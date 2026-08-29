# shometrics-linux-helper

Linux hardware sensor support for the [Sho Metrics](https://github.com/ShoMetrics/sho_metrics)
Stream Deck plugin running under [OpenDeck](https://github.com/nekename/OpenDeck).

Implements Sho Metrics' `MetricSourceService` gRPC contract (the protocol its
Windows LibreHardwareMonitor helper speaks) as a native Linux daemon, serving:

- **/sys/class/hwmon** - all chips: temperatures, fans, voltages, currents,
  power, energy, humidity (k10temp, it87, nvme, spd5118, amdgpu, wireview, ...)
- **NVIDIA GPUs via [LACT](https://github.com/ilya-zlobintsev/LACT)** (lactd
  0.10+, queried over /run/lactd.sock): core temp, **hotspot**, **VRAM junction
  and per-chip temps** (data NVML refuses to expose on Blackwell), fan RPM/PWM,
  power draw and limit, GPU/VRAM clocks, VRAM usage, utilization

## Layout

- `server.mjs` - the helper daemon (Node, @grpc/grpc-js), listens on
  `/tmp/shometrics-helper/ShoMetrics.Source.Windows.Grpc.v1`
- `proto/` - Sho Metrics contract protos (from `contracts/proto`, GPLv3)
- `test-client.mjs` - exercises all four RPCs against the running daemon
- `systemd/shometrics-linux-helper.service` - user service unit
- `plugin/com.ez.sho-metrics.sdPlugin/` - plugin v0.2.0 **patched for Linux**
  with Linux builds of its native modules (resvg-js, node-hid) installed and a
  `linux` platform entry in the manifest
- `patches/apply-linux-patches.py` - re-applies the five platform-gate patches
  to a pristine `bin/plugin.js` (anchors verified against v0.2.0)
- `patches/plugin.js.v0.2.0.orig` - pristine upstream bundle for reference

## Install

```sh
npm install
cp systemd/shometrics-linux-helper.service ~/.config/systemd/user/
systemctl --user enable --now shometrics-linux-helper
cp -r plugin/com.ez.sho-metrics.sdPlugin ~/.config/opendeck/plugins/
# restart OpenDeck; requires lactd running for the NVIDIA sensors
```

## Upgrading the plugin

On a new upstream release: extract the `.streamDeckPlugin`, run
`patches/apply-linux-patches.py` against its `bin/plugin.js` (re-discover the
minified identifiers if an assert fires), re-add the Linux natives and the
manifest `linux` OS entry.

Upstream plugin is GPLv3; this repo redistributes it under the same license.
The long-term plan is upstreaming a proper Linux source to ShoMetrics - the
contract explicitly allows independent helper implementations.
