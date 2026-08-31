Title: [Feature]: Linux support under OpenDeck through an independent MetricSourceService helper

## Problem

Sho Metrics runs only on Windows and macOS. Linux Stream Deck users run
OpenDeck (https://github.com/nekename/OpenDeck), which loads Node-based Elgato
plugins. The plugin's Node core already runs there, but every path to the
deep-sensor experience is gated on `platform === "win32"`, and the property
inspector hides its sensor UI for any other platform. Linux has a rich native
sensor stack (`/sys/class/hwmon`, LACT for NVIDIA including Blackwell hotspot
and VRAM temperatures, MangoHud for in-game FPS) with no way to reach the
plugin's widgets.

## Proposed solution

Treat the deep-sensor helper as platform-independent, which the contract
already anticipates ("A helper may run on the local machine or a remote
machine. The boundary is not locality; it is an independently versioned
ShoMetrics-owned process that speaks this gRPC protocol").

I have a working Linux port and would like to upstream the hub-side changes as
small PRs, keeping the Linux helper external at first:

1. Helper source on Linux: replace the `win32` gates in `source-registry`,
   `metric-source-preferences`, `metric-read-plan`, `catalog-metric`, the
   descriptor runtime cache, and `action-settings-resolver` with one named
   capability (for example `supportsHelperSourceOnPlatform`). Keep the
   `windows-helper` source id and `local:windows-helper` profile id unchanged
   for stored-settings compatibility; only the naming in code and docs would
   generalize. Make the gRPC target platform-aware: the existing named pipe on
   Windows, `$XDG_RUNTIME_DIR/shometrics/source.sock` on Linux. Give the
   service-status probe a Linux reader (systemd user unit) instead of `sc.exe`.
   Add the `linux` OS entry to the manifest and a `linux-x64` native-addon
   target to `pack:streamdeck`. Update the tests that assert win32-only routing.
2. Property inspector platform semantics: the inspector's `isWindows` gates
   become "helper-capable platform". Note that OpenDeck reports
   `application.platform` as `linux` to inspectors while it spoofs `windows` to
   plugin processes, so both sides need the capability rather than the OS name.
3. Runtime-connection robustness: OpenDeck mounts every action's inspector
   iframe hidden at startup and sends `propertyInspectorDidAppear` only when a
   panel is opened. The inspector's early ping therefore arrives while the SDK's
   `ui.current` is unset and the pong (sent through `ui.sendToPropertyInspector`)
   is dropped, leaving the "plugin engine is not responding" notice permanently.
   Replying through the ping event's own action context fixes it. Verified by
   decoding the WebSocket frames between plugin and host.
4. Sensor picker: add a `current` reading-kind category (with `en`, `zh_CN`,
   `ja` entries). Amperes sensors are currently filed under "Other".
5. Separately, for discussion rather than assumed: one-decimal display for
   amps/volts/watts on catalog metrics, a 12 A default maximum for amperes
   (100 A leaves single-rail current bars nearly empty), and a bar-view title
   by reading kind for hardware in the "other" category (currently "Metric").

The Linux helper (Node, `@grpc/grpc-js`, ~450 lines) implements the four RPCs
over hwmon, LACT, and MangoHud, and would stay in its own repository until the
hub accepts any conforming helper. Moving it under `packages/` can be a later
discussion; it is GPLv3 like the rest of the project.

## Who benefits?

Linux users of OpenDeck with any Stream Deck. On Linux the helper reaches
readings the Windows stack cannot: RTX 50-series hotspot and per-chip VRAM
temperatures via LACT, per-pin 12VHPWR current from the WireView Pro hwmon
driver, and MangoHud FPS with 1% lows.

## Notes

- Working port, patch set against v0.2.0, and a screenshot of the keys:
  https://github.com/emaspa/shometrics-linux-helper
- Host tested: OpenDeck 2.14, Arch (CachyOS), Plasma Wayland, Node 26.
- Questions before I open PRs: is the hub-side generalization welcome in this
  form, do you prefer a Linux helper under `packages/source-linux` eventually,
  and do you have a preferred socket location and capability name?
- AI assistance (Claude) was used during the port; per CONTRIBUTING I will
  review and be able to explain every diff I submit.
