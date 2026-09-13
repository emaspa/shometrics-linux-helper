Title: Hidden property inspector iframes send messages before propertyInspectorDidAppear, and the Node SDK drops the replies

### Preflight checklist

- [x] I have searched the existing issues and believe this will not be a duplicate of any existing issue.
- [x] I understand that if this issue is about support for non-Elgato or non-Tacto hardware, it will be closed without explanation, as per issue #38, and that it should be raised in the repository of the plugin that provides support for the hardware.
- [x] I will provide the OpenDeck log file and the log files of plugins involved, where applicable.
- [x] I will provide my operating system information and method of installation, as well as any steps I have taken to troubleshoot the issue.
- [x] I certify that I am using the latest available version of OpenDeck, and that I will provide enough information to reproduce the issue.

---

First, thank you for OpenDeck. I maintain the Linux fork of the Sho Metrics plugin, and the only reason a hardware-metrics plugin written for the Elgato app runs on my deck at all is that you built this and kept it going. What follows is one thing I hit and traced while porting, written up in case it helps. Nothing here is blocking me; I have a workaround in place.

In https://github.com/ShoMetrics/sho_metrics/issues/5 the Sho Metrics author asked that this be raised with you first, with any plugin-side handling kept to an OpenDeck-only path. That is what I did, and this is the OpenDeck half.

## Environment

- OpenDeck 2.14.0, Arch package `opendeck 2.14.0-1.3`, not Flatpak. That is the latest release; `main` is one commit ahead and none of the files I quote below changed after the tag. The registration info reports `application.version` `7.1.0`.
- Plugin: Sho Metrics, Linux fork at https://github.com/emaspa/sho-metrics-linux (branch `linux`), a Node plugin on `@elgato/streamdeck` 2.1.0.
- CachyOS (Arch), Plasma Wayland, Node 26.8.2.

## What I saw

`PropertyInspectorView.svelte` renders one iframe per action instance in the profile. All of them mount at once with class `hidden`; the inspected one gets `block`. `propertyInspectorDidAppear` only goes out from `switch_property_inspector`, which runs when `inspectedInstance` changes in `src/lib/propertyInspector.ts`, so when the user selects a key.

A property inspector page can therefore load, register over the WebSocket and send `sendToPlugin` before the plugin has ever received `propertyInspectorDidAppear` for it.

The official Node SDK has no path for that state. In `@elgato/streamdeck` `dist/plugin/ui.js`, `UIController` sets its current action only in the `propertyInspectorDidAppear` handler and clears it on `propertyInspectorDidDisappear`. `ui.action` is documented as "`undefined` when a property inspector is not visible", and the send looks like this:

```js
async sendToPropertyInspector(payload) {
    if (this.#action) {
        await connection.send({ event: "sendToPropertyInspector", context: this.#action.id, payload });
    }
}
```

No current action, no send, no error.

Observed: the PI sends a message on load, the plugin receives it and answers through `streamDeck.ui.sendToPropertyInspector`, and the answer never leaves the plugin process. The PI sits on its timeout path for good. In Sho Metrics the page shows a permanent "plugin engine is not responding" banner while the plugin process is running and handling every other event fine.

Also observed: with several iframes mounted and pinging, a reply that relies on the SDK's single current action goes to whichever action last became current, which is not always the one that asked.

Expected, or rather what the SDK is written against: a property inspector exists only between `propertyInspectorDidAppear` and `propertyInspectorDidDisappear`, so a message from a PI always arrives while that PI is current.

## Reproduction

Any Node plugin on `@elgato/streamdeck` whose PI sends `sendToPlugin` on load and whose plugin answers with `streamDeck.ui.sendToPropertyInspector` should show it:

1. Install the plugin and place one of its actions on a key.
2. Restart OpenDeck, or reload the plugin, and do not select the key.
3. The PI iframe loads hidden, connects and sends its message. The plugin logs the `sendToPlugin` event. No `sendToPropertyInspector` frame goes back.
4. Selecting the key now sends `propertyInspectorDidAppear`, but the PI has already timed out on its first request.

Sho Metrics is a concrete case. Its inspector sends a runtime-connection ping right after connecting and expects a pong on the same channel.

## How I verified it

I did not want to guess from log lines, so I decoded the WebSocket traffic on both sides. The tools are in https://github.com/emaspa/shometrics-linux-helper/tree/master/diagnostics.

`ws-proxy-wrapper.js` replaces the plugin's entry point. It reads the `-port` argument OpenDeck passes, opens a local TCP proxy in front of that port, rewrites `-port` to the proxy and then imports the real plugin. It decodes RFC 6455 frames in both directions, unmasking client frames, and logs each text frame with a `PLUGIN->OD:` or `OD->PLUGIN:` prefix. Every `registerPlugin`, `sendToPlugin`, `propertyInspectorDidAppear` and `sendToPropertyInspector` frame shows up with its `context`.

`property-inspector-instrumented.html` is the PI page plus a small pre-script that POSTs page load, JS errors, the arguments OpenDeck passes to `connectElgatoStreamDeckSocket` and an independent WebSocket probe to `pilog-server.py`, a local HTTP sink.

After startup, without touching any key, the log shows the PI page loading, `connectElgatoStreamDeckSocket` called with the action context, an `OD->PLUGIN` `sendToPlugin` for that context carrying the ping payload, no `propertyInspectorDidAppear` frame for that context before it, and no `PLUGIN->OD` `sendToPropertyInspector` frame after it. Selecting the key later produces the `propertyInspectorDidAppear` frame.

## What I do about it today

The fork answers the ping through the event's own action context instead of the SDK's current-inspector send:

```ts
await connection.send({
    event: "sendToPropertyInspector",
    context: actionContextId,   // the sendToPlugin event's action id
    payload,
});
```

It works and is shipped. I would rather not keep it, for two reasons.

The SDK has no public context-addressed PI send. `connection` is an internal module and the package's `exports` map blocks the subpath, so I import `node_modules/@elgato/streamdeck/dist/plugin/connection.js` by file path in one compat module, https://github.com/emaspa/sho-metrics-linux/blob/linux/packages/hub/src/runtime/opendeck/pi-channel.ts, gated on the host being OpenDeck. That is the kind of thing that breaks on the next SDK release.

And every Node plugin whose PI talks to the plugin on load has to find and carry the same patch. A plugin that replies the documented way, through `ui.sendToPropertyInspector`, works on the Elgato app and shows this symptom on OpenDeck.

I will keep the workaround behind the OpenDeck check and delete it if the host behaviour changes.

## Two ideas, in case either fits

Both are in `PropertyInspectorView.svelte`.

The smaller one: mount an instance's iframe the first time `$inspectedInstance` equals its context, instead of rendering every iframe at profile load. `switch_property_inspector` already fires on that same store change, so `propertyInspectorDidAppear` and the iframe's load and connect happen for the same selection. Nothing is mounted at startup, so nothing pings early. Inspectors that have been opened once stay mounted and hidden as they do now, and keep whatever state they hold.

The fuller one: unmount the iframe on deselect, so one PI iframe is alive at a time. That is the lifecycle `UIController` assumes, `ui.action` undefined when no inspector is visible, and it also removes the multi-iframe race. The cost is losing unsaved in-page state when switching keys, which is what the SDK expects anyway.

The first covers the bug I reported. The second is the closer match to the SDK. In both cases `plugin_reloaded`, which today reloads every mounted iframe, would only have mounted ones to reload.

If you want to try either, I have a real deck and the frame-decoding setup ready and can test a branch the same day. If a PR for the first idea would save you time I am glad to write one, and equally fine if you would rather do it your own way.

## One more thing I noticed, asked out of curiosity

The Node plugin process gets `platform: "windows"` in its registration info. Live process line on this machine:

```
node bin/plugin.js -port ... -pluginUUID com.ez.sho-metrics-linux.sdPlugin -registerEvent registerPlugin -info {"application":{...,"platform":"windows","platformVersion":"10.0.19045.4474",...}}
```

The PI iframes for the same plugin get `application.platform: "linux"`, because the `make_info` Tauri command passes `wine = false`.

Reading the source, this is not an accident of a shared code path. `src-tauri/src/plugins/mod.rs` calls `info_param::make_info(plugin_uuid, manifest.version, true)` in the Node branch, line 255 on both v2.14.0 and `main`, and `info_param.rs` returns `"windows"` and `"10.0.19045.4474"` whenever that flag is true. The `true` has been there since Node support landed in 67087af1 ("Add Node PluginInstance for js plugin (#12)"). The Wine branch passes `true` as well; the webview and native-binary branches pass `false`.

In the Sho Metrics thread you mentioned thinking the Windows spoof only applied to Wine processes, which is why I am asking rather than assuming. Is spoofing Windows to Node plugins on purpose, maybe so that Windows-only Node plugins launched through their `windows` manifest entry see a platform they recognise? If so, would it make sense to pass `use_wine` in the Node branch instead of a constant `true`, so a plugin that lists `linux` in its manifest gets `linux`? Plugins that gate on `info.application.platform` rather than Node's `process.platform` currently see Linux as Windows 10, and PI and plugin disagree about the host OS. My fork reads `process.platform`, so nothing hangs on the answer. I was mostly surprised, and thought you would want to know how it looks from the outside.

## Logs

`~/.local/share/opendeck/logs/opendeck.log` has nothing about this beyond the `Registered plugin com.ez.sho-metrics-linux.sdPlugin` debug lines; there is no error to log, since the host does exactly what its code says. The plugin's file under `logs/plugins/` is empty (0 bytes). The evidence is the decoded WebSocket frame log described above; I can attach the raw `/tmp/shometrics-ws.log` from a fresh run if that is useful.
