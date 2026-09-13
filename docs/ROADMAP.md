# Roadmap: Sho Metrics for Linux as a community fork

## Where we stand

Upstream declined official Linux support in
[ShoMetrics/sho_metrics#5](https://github.com/ShoMetrics/sho_metrics/issues/5)
and endorsed an independent fork. That changes the shape of this project: we
stop being a patch set applied to someone else's bundle and become the Linux
distribution of Sho Metrics, built from our own fork's source.

Two repos exist today:

- `emaspa/sho_metrics`: the fork. Currently just a mirror of upstream v0.2.0
  with no Linux work in it yet.
- `emaspa/shometrics-linux-helper` (this repo): the gRPC helper daemon
  (`server.mjs`), the patch script against the minified bundle, the pristine
  v0.2.0 bundle, the pre-patched plugin releases, and the diagnostics tools.

The patch-script approach has taken us as far as it can. Every upstream release
means re-verifying anchors in a 2.2 MB minified bundle, and users who update
through the marketplace silently lose the patches. Building from the fork's
source removes that whole failure class.

## What the author's response commits us to

Edwardez gave three pieces of design guidance along with the fork blessing.
They are good calls, and following them keeps the door open for cooperation
later.

1. **Don't put `linux` in the base manifest's `OS` array.** Elgato's schema
   only accepts `mac` and `windows`. OpenDeck supports a
   `manifest.<os>.json` override file next to `manifest.json`, merged with a
   JSON merge patch (verified in OpenDeck's `src-tauri/src/plugins/manifest.rs`,
   which also supports a `code_path_linux` field). So the base manifest stays
   schema-valid and the Linux entries live in `manifest.linux.json`, which only
   OpenDeck ever reads.

2. **The helper protocol stays an internal ShoMetrics boundary.** No pitch for
   "any conforming third-party helper". Our fork owns a Linux helper
   implementation, versioned against our fork's copy of the contract, the same
   way upstream owns `source-windows`.

3. **The property-inspector lifecycle fix belongs in OpenDeck first.** The
   ping/pong bug (inspector iframe mounted hidden at startup,
   `propertyInspectorDidAppear` only on panel open, pong dropped because
   `ui.current` is unset) is an OpenDeck compatibility gap. We should report it
   upstream to OpenDeck with our frame-decode evidence, and keep the
   plugin-side workaround isolated in an OpenDeck compat path rather than
   changing normal Stream Deck runtime behavior.

## Decisions to make

These shape everything downstream. Each has a recommendation; none is
irreversible.

### D1. The fork becomes the product

Build the plugin from `emaspa/sho_metrics` source with Linux support committed
there. Retire `patches/apply-linux-patches.py`, the pristine bundle, and the
pre-patched plugin releases from this repo.

**Recommended: yes.** This is the only arrangement that survives an upstream
release cycle without manual re-patching.

### D2. Plugin identity (UUID and name)

The current patched releases keep upstream's `com.ez.sho-metrics` UUID. Options:

- **Keep the UUID.** Users' existing keys keep working, and installing the fork
  over an official build just replaces it. But two different codebases sharing
  one identity is exactly the confusion a fork should avoid, and OpenDeck keys
  the plugin directory by UUID, so an official reinstall silently clobbers the
  fork.
- **New UUID (recommended).** Something like `com.ez.sho-metrics-linux`, name
  "Sho Metrics Linux". Honest about being a separate community build, no
  clobber risk, side-by-side install possible. Cost: existing patched-release
  users re-add their keys once. There have been two releases and a tiny user
  base, so now is the cheapest moment to do this. Document the migration in
  the release notes.

### D3. Helper lives in the fork's monorepo

Move `server.mjs`, the systemd unit, and the install docs into the fork as
`packages/source-linux`, mirroring `packages/source-windows`. Proto files come
from `contracts/proto` in-tree instead of being copied here. One version, one
release train, one changelog.

**Recommended: yes.** This repo then archives with a pointer to the fork, or
shrinks to just the diagnostics tools and docs if we want to keep those
separate.

### D4. Branch model and rebase discipline

A long-lived `linux` branch off upstream's release tags. Linux changes stay in
small self-contained commits, and wherever possible in new files or behind
capability checks rather than interleaved with upstream logic, so rebasing onto
the next upstream tag is mechanical. `main` in the fork stays a clean mirror of
upstream.

## Phases

### Phase 0: fork foundation

- Sync the fork to current upstream (`upstream/main` was pushed 2026-09-08;
  our mirror is behind).
- Settle D1 to D4.
- Fork branding: README that says what this is (community Linux fork, based on
  upstream version X), keep GPLv3, add a NOTICE-style attribution of upstream,
  state changes per GPLv3 section 5.
- CI skeleton: GitHub Actions that builds the hub package on Linux and runs
  upstream's test suite. Red build on day one is fine; it tells us what the
  bundle-patching hid.

### Phase 1: source-level Linux support in the hub

Port the patch script's changes into `packages/hub` source. From the upstream
issue draft, the touch points are:

- `source-registry`, `metric-source-preferences`, `metric-read-plan`,
  `catalog-metric`, the descriptor runtime cache, and
  `action-settings-resolver`: replace `platform === "win32"` gates with one
  capability, e.g. `supportsHelperSourceOnPlatform`. Keep the
  `windows-helper` source id and `local:windows-helper` profile id unchanged
  so stored settings stay compatible.
- gRPC target becomes platform-aware: named pipe on Windows,
  `$XDG_RUNTIME_DIR/shometrics/source.sock` on Linux.
- Service status probe: systemd user unit reader instead of `sc.exe`.
- Property inspector: `isWindows` gates become the same capability check.
  Remember OpenDeck reports `application.platform` as `linux` to inspectors
  while spoofing `windows` to plugin processes, so both sides key off the
  capability, not the OS name.
- Sensor picker: add the `current` reading-kind category with `en`, `zh_CN`,
  `ja` strings.
- Update the tests that assert win32-only routing; add Linux routing tests.

Exit criterion: `pack` on Linux produces a plugin that does everything the
patchset-2 release does, and the patch script is deleted.

### Phase 2: packaging and releases

- `manifest.linux.json` override carrying the Linux OS entry,
  `code_path_linux`, and any Linux-only action tweaks. Base manifest untouched.
- Bundle Linux natives: `@resvg/resvg-js-linux-x64-gnu` and node-hid Linux
  prebuilds, wired into the pack step as a `linux-x64` target.
- Release pipeline: tag `vX.Y.Z-linux.N` in the fork, CI produces
  `ShoMetrics-Linux.streamDeckPlugin` plus the helper install artifacts.
- Versioning convention: fork version = upstream version + `-linux.N`. The
  changelog always names the upstream base.
- Nice-to-have: AUR package (`sho-metrics-linux`) covering plugin install plus
  the systemd user unit. We are on Arch, so this is our own dogfood first.

### Phase 3: helper integration

- Move `server.mjs` into `packages/source-linux` with its own
  `package.json`, split the monolith into modules if it helps (hwmon reader,
  LACT client, MangoHud log watcher, alias table, gRPC server).
- Delete this repo's `proto/` copy; build against `contracts/proto` in-tree.
- Ship the systemd user unit and an install script from the fork.
- Keep the recent robustness work: lactd startup wait, 12 A default for
  amperes, re-enumeration when LACT appears late.
- Decide what happens to this repo (archive, or keep diagnostics tools here).

### Phase 4: PI lifecycle, proper path

- Open an issue on `nekename/OpenDeck` describing the hidden-iframe mount and
  the dropped pong, with the WebSocket frame evidence from `diagnostics/`.
  Propose that OpenDeck either align `propertyInspectorDidAppear` semantics
  with the SDK or route early `sendToPropertyInspector` calls correctly.
- In the fork, keep the reply-through-action-context fix behind an explicit
  OpenDeck detection, with a comment linking the OpenDeck issue, so it can be
  deleted the day OpenDeck fixes it.

### Phase 5: maintenance loop

- Policy: rebase `linux` onto each upstream release, cut `-linux.N` within
  days, not weeks.
- CI job that diffs `contracts/proto` against upstream's copy on every rebase,
  so a contract change fails the build instead of breaking the helper at
  runtime.
- Track OpenDeck releases for PI lifecycle changes and manifest handling.

### Phase 6: distribution and community

- Once the first source-built release ships, comment on issue #5: thank the
  author for the guidance, link the fork, note which suggestions we followed.
  Not before; announce the artifact, not the intention.
- Post in OpenDeck community channels (Discord/Matrix) and r/streamdeck.
- README polish for the fork: screenshot, install one-liner, requirements,
  what the Linux build adds over upstream (LACT hotspot and VRAM temps,
  WireView per-pin current, MangoHud FPS).
- Refresh this repo's README to point at the fork once D3 lands, so the docs
  don't describe a dead workflow.

## Risks

- **Upstream churn.** Mitigated by the capability-gate design: Linux code sits
  beside upstream logic, not inside it, and the proto-diff CI catches contract
  drift.
- **Maintainer bandwidth.** One person, Linux-only scope, no Windows/macOS
  obligations. The scope stays narrow on purpose. If maintenance lapses, the
  last release still works; that is better than the patch-set situation, where
  an upstream update actively breaks users.
- **UUID split confuses users.** Clear naming ("Sho Metrics Linux"), migration
  notes in the first renamed release, README that explains the difference from
  official Sho Metrics.
- **Upstream adopts Linux support later.** Then the fork's job is done and we
  converge: send the work upstream or point users there. Designing to the
  author's stated preferences makes that outcome easy.

## Non-goals

- No changes to Windows or macOS behavior.
- No campaign to upstream Linux support; it was declined.
- No third-party helper ecosystem on the gRPC contract.
- No Elgato marketplace distribution; OpenDeck only.

## Next concrete actions

1. Decide D2 (UUID rename) and pick the fork's display name.
2. Sync the fork to upstream, create the `linux` branch.
3. Get CI building the hub on Linux against unmodified upstream source;
   inventory what breaks.
4. Port the six capability-gate areas from the patch script into hub source
   (Phase 1 list above).
5. Add `manifest.linux.json` and the Linux pack target.
6. File the OpenDeck PI lifecycle issue with the frame-decode evidence.
7. Move the helper into `packages/source-linux`, first `-linux` tagged release.
8. Comment on issue #5 and announce.
