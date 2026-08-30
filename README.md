# Sho Metrics for Linux

Beautiful hardware sensor widgets on your Stream Deck, on Linux.

This project ports the [Sho Metrics](https://github.com/ShoMetrics/sho_metrics)
Stream Deck plugin (officially Windows/macOS) to Linux under
[OpenDeck](https://github.com/nekename/OpenDeck), and replaces its Windows-only
LibreHardwareMonitor helper with a native Linux daemon. You get the plugin's
polished gauges, graphs, and bars, fed by Linux-native sensor sources:

- **Every hwmon sensor** in `/sys/class/hwmon`: CPU (k10temp/coretemp), board
  fans and voltages (it87/nct67xx), NVMe temps, DDR5 SPD temps, and anything
  else with a driver, including exotic hardware like the
  [WireView Pro](https://github.com/emaspa/wireview-hwmon) power meter
  (per-pin 12VHPWR current on a deck key!)
- **NVIDIA GPUs via [LACT](https://github.com/ilya-zlobintsev/LACT)**: core
  temp, **hotspot**, **VRAM junction and per-chip temps** (readings NVML
  refuses to expose on Blackwell), fan RPM/PWM, power draw and limit, clocks,
  VRAM usage, utilization
- **AMD GPUs** through plain hwmon (amdgpu)
- **In-game FPS via [MangoHud](https://github.com/flightlessmango/MangoHud)**:
  FPS, 1% lows, and frametime while a MangoHud-enabled game runs
- **Stable aliases** (`cpu.temp`, `gpu.temp`, `gpu.power`, ...) so the plugin's
  curated CPU/GPU widgets work too

## How it works

```
Sho Metrics plugin (patched)  --gRPC over unix socket-->  shometrics-linux-helper
        |                                                   |- /sys/class/hwmon
     OpenDeck                                               |- lactd (NVIDIA)
                                                            |- ~/mangohud_logs
```

Sho Metrics talks to its deep-sensor helper over a small, well-designed gRPC
contract (`contracts/proto` upstream). `server.mjs` implements that contract as
a Node daemon reading Linux sources. The plugin itself needs a set of small
patches (platform gates, a property-inspector timing fix for OpenDeck, and a
few Linux niceties) - a pre-patched build is provided in Releases.

## Requirements

- [OpenDeck](https://github.com/nekename/OpenDeck) 2.14+ with your deck working
- Node.js 20+ (`node` on PATH; the helper and the plugin both use it)
- Optional, for NVIDIA deep sensors: `lact` with the `lactd` service enabled
  (v0.10+ for Blackwell hotspot); your user must be able to read
  `/run/lactd.sock` (wheel group on most distros)
- Optional, for FPS: `mangohud`

## Install

### 1. The helper daemon

```sh
git clone https://github.com/emaspa/shometrics-linux-helper
cd shometrics-linux-helper
npm install
cp systemd/shometrics-linux-helper.service ~/.config/systemd/user/
systemctl --user enable --now shometrics-linux-helper
```

### 2. The plugin

Download `ShoMetrics-Linux.streamDeckPlugin` from
[Releases](../../releases) and install it through OpenDeck's plugin manager
(or unzip it into `~/.config/opendeck/plugins/`). Restart OpenDeck.

Prefer to patch upstream yourself? Download the official
`ShoMetrics.streamDeckPlugin`, extract it, and run
`patches/apply-linux-patches.py <sdPlugin dir>` - the script asserts on every
anchor so a new upstream release fails loudly instead of half-patching. Then
add a `linux` entry to `manifest.json`'s `OS` array and drop in the Linux
builds of the two native modules (`@resvg/resvg-js-linux-x64-gnu`, `node-hid`
Linux prebuilds) - compare with the bundled copy in `plugin/`.

### 3. Add keys

In OpenDeck, drag **Advanced Sensor** onto a key and pick from the full
hardware tree. The curated CPU/GPU widgets work as well through the stable
aliases. Gauge view lives under View: Circle, then Variant: Gauge.

### FPS setup (optional)

Configure MangoHud to auto-log where the helper looks
(`~/.config/MangoHud/MangoHud.conf`):

```ini
autostart_log=1
log_interval=1000
output_folder=/home/YOU/mangohud_logs
# no_display=1   # log invisibly, Shift_R+F12 toggles the overlay
```

Then get MangoHud into your games. Per game: `mangohud %command%` in Steam
launch options. Steam-wide: launch Steam with `MANGOHUD=1` in its environment
(e.g. copy `steam.desktop` to `~/.local/share/applications/` and prefix the
`Exec` lines with `env MANGOHUD=1`) - this covers all Vulkan/DXVK titles;
OpenGL-under-Proton games still need the per-game launch option. The
`MANGOHUD_LOG_DIR` environment variable moves the helper's watch directory.

## Repo layout

- `server.mjs` - the helper daemon (only dependency: `@grpc/grpc-js`)
- `proto/` - Sho Metrics' helper contract (from upstream `contracts/proto`)
- `plugin/` - pre-patched plugin v0.2.0 with Linux natives and manifest entry
- `patches/apply-linux-patches.py` - the full patch set, self-verifying
- `patches/plugin.js.v0.2.0.orig` - pristine upstream bundle for diffing
- `diagnostics/` - the debugging tools used to develop this (a WebSocket
  frame-decoding proxy wrapper, an instrumented property inspector)

## Status and caveats

- Confirmed working: Advanced Sensor keys, curated CPU/GPU aliases, MangoHud
  FPS, all under OpenDeck 2.14 on Arch (CachyOS), Plasma Wayland
- A marketplace/upstream plugin update will overwrite the patches; re-apply
  with the script or reinstall the release build
- `cpu.power` has no hwmon source on most AMD boards and reads unavailable
- This is an unofficial community port, not affiliated with Sho Metrics or
  Elgato. The long-term goal is upstreaming a proper Linux source - the
  helper contract explicitly welcomes independent implementations

## License

GPLv3, matching upstream Sho Metrics, whose code this repo redistributes
(pre-patched plugin build and protobuf contracts). See `LICENSE`.
