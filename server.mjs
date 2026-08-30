#!/usr/bin/env node
// shometrics-linux-helper: serves Linux hardware sensors to the Sho Metrics
// Stream Deck plugin over its MetricSourceService gRPC contract.
//
// Sources:
//   - /sys/class/hwmon (temperatures, fans, voltages, currents, power, energy)
//   - lactd (NVIDIA GPU: hotspot, VRAM junction + per-chip temps, fan, power,
//     clocks, VRAM usage, utilization) when /run/lactd.sock is available
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { readdirSync, readFileSync, readlinkSync, mkdirSync, rmSync, existsSync, openSync, readSync, fstatSync, closeSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { connect } from "node:net";

const HWMON_ROOT = "/sys/class/hwmon";
const LACT_SOCKET = "/run/lactd.sock";
const SOCKET_DIR = "/tmp/shometrics-helper";
const SOCKET_PATH = join(SOCKET_DIR, "ShoMetrics.Source.Windows.Grpc.v1");
const PROTOCOL_VERSION = "1";
const HELPER_VERSION = "0.2.0";
const ENUMERATE_INTERVAL_MS = 60000;
const LACT_STATS_CACHE_MS = 900;

const UNIT = {
    PERCENT: 1, CELSIUS: 2, VOLTS: 3, AMPERES: 4, WATTS: 5,
    HERTZ: 6, BYTES: 7, RPM: 9, UNITLESS: 11, WATT_HOURS: 13, MILLISECONDS: 16,
};

// ---------------------------------------------------------------- hwmon source

// sensor file prefix -> [unit, divisor to canonical unit]
const HWMON_TYPES = {
    temp:     { unit: UNIT.CELSIUS,    divisor: 1000,  label: "Temperature", lhm: "Temperature" },
    fan:      { unit: UNIT.RPM,        divisor: 1,     label: "Fan",         lhm: "Fan" },
    in:       { unit: UNIT.VOLTS,      divisor: 1000,  label: "Voltage",     lhm: "Voltage" },
    curr:     { unit: UNIT.AMPERES,    divisor: 1000,  label: "Current",     lhm: "Current" },
    power:    { unit: UNIT.WATTS,      divisor: 1e6,   label: "Power",       lhm: "Power" },
    energy:   { unit: UNIT.WATT_HOURS, divisor: 3.6e9, label: "Energy",      lhm: "Energy" },
    humidity: { unit: UNIT.PERCENT,    divisor: 1000,  label: "Humidity",    lhm: "Humidity" },
};

function readTrimmed(path) {
    return readFileSync(path, "utf8").trim();
}

// Stable id for a chip across reboots: driver name + device path basename
// (hwmonN numbering is not stable).
function chipDeviceId(hwmonPath) {
    try {
        return basename(readlinkSync(join(hwmonPath, "device")));
    } catch {
        return "virtual";
    }
}

function addCpuTempAlias(sensors) {
    // stable alias cpu.temp -> k10temp Tctl (preferred) or its first temp
    const candidates = [...sensors.values()].filter(s => s.hardwareName === "k10temp");
    const source = candidates.find(s => s.sensorName === "Tctl") ?? candidates[0];
    if (!source) return;
    sensors.set("cpu.temp", {
        ...source,
        metricId: "cpu.temp",
        metricIdKind: 1,
        sensorName: "CPU Package",
    });
}

function enumerateHwmonSensors(sensors) {
    let entries = [];
    try {
        entries = readdirSync(HWMON_ROOT);
    } catch {
        return;
    }
    for (const hw of entries) {
        const hwPath = join(HWMON_ROOT, hw);
        let chip;
        try {
            chip = readTrimmed(join(hwPath, "name"));
        } catch {
            continue;
        }
        const devId = chipDeviceId(hwPath);
        const hardwareId = `${chip}@${devId}`;
        let files;
        try {
            files = readdirSync(hwPath);
        } catch {
            continue;
        }
        for (const file of files) {
            const m = file.match(/^(temp|fan|in|curr|power|energy|humidity)(\d+)_input$/);
            if (!m) continue;
            const [, kind, index] = m;
            const type = HWMON_TYPES[kind];
            const inputPath = join(hwPath, file);
            let label = `${type.label} ${index}`;
            try {
                label = readTrimmed(join(hwPath, `${kind}${index}_label`));
            } catch { /* no label file; keep generic */ }
            const metricId = `linux-hwmon.${hardwareId}.${kind}${index}`;
            sensors.set(metricId, {
                metricId,
                unit: type.unit,
                hardwareId,
                hardwareName: chip,
                hardwareType: "hwmon",
                sensorName: label,
                sensorType: type.lhm,
                pollingGroupId: hardwareId,
                read: async () => {
                    const raw = parseInt(readTrimmed(inputPath), 10);
                    if (Number.isNaN(raw)) throw new Error("NaN");
                    return raw / type.divisor;
                },
            });
        }
    }
}

// ----------------------------------------------------------------- LACT source

function lactRequest(command, args) {
    return new Promise((resolve, reject) => {
        const socket = connect(LACT_SOCKET);
        let buffer = "";
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("lact timeout")); });
        socket.on("error", reject);
        socket.on("connect", () => {
            socket.write(JSON.stringify(args === undefined ? { command } : { command, args }) + "\n");
        });
        socket.on("data", chunk => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline === -1 && !buffer.trim().endsWith("}")) return;
            socket.destroy();
            try {
                const response = JSON.parse(buffer);
                if (response.status !== "ok") return reject(new Error(`lact: ${response.data}`));
                resolve(response.data);
            } catch (e) {
                reject(e);
            }
        });
    });
}

const lactStatsCache = new Map(); // device id -> { at, promise }

function lactStats(deviceId) {
    const cached = lactStatsCache.get(deviceId);
    if (cached && Date.now() - cached.at < LACT_STATS_CACHE_MS) return cached.promise;
    const promise = lactRequest("device_stats", { id: deviceId });
    lactStatsCache.set(deviceId, { at: Date.now(), promise });
    promise.catch(() => lactStatsCache.delete(deviceId));
    return promise;
}

function slug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function enumerateLactSensors(sensors) {
    if (!existsSync(LACT_SOCKET)) return;
    const devices = await lactRequest("list_devices");
    for (const device of devices) {
        if (!device.id.startsWith("10DE:")) continue; // NVIDIA only; hwmon covers AMD
        const stats = await lactStats(device.id);
        const hardwareId = `nvidia@${device.id}`;
        const base = {
            hardwareId,
            hardwareName: device.name,
            hardwareType: "GpuNvidia",
            pollingGroupId: hardwareId,
        };
        const add = (key, sensorName, sensorType, unit, extract) => {
            const metricId = `linux-nvidia.${device.id}.${key}`;
            sensors.set(metricId, {
                ...base, metricId, unit, sensorName, sensorType,
                read: async () => {
                    const value = extract(await lactStats(device.id));
                    if (value === undefined || value === null || Number.isNaN(value)) {
                        throw new Error("missing");
                    }
                    return value;
                },
            });
        };
        for (const tempName of Object.keys(stats.temps ?? {})) {
            add(`temp.${slug(tempName)}`, tempName, "Temperature", UNIT.CELSIUS,
                s => s.temps?.[tempName]?.current);
        }
        add("fan_rpm", "GPU Fan", "Fan", UNIT.RPM, s => s.fan?.speed_current);
        add("fan_pwm", "GPU Fan PWM", "Control", UNIT.PERCENT,
            s => s.fan?.pwm_current === undefined ? undefined : s.fan.pwm_current / 255 * 100);
        add("power_draw", "GPU Package Power", "Power", UNIT.WATTS, s => s.power?.current);
        add("power_cap", "Power Limit", "Power", UNIT.WATTS, s => s.power?.cap_current);
        add("clock_gpu", "GPU Core Clock", "Clock", UNIT.HERTZ,
            s => s.clockspeed?.gpu_clockspeed === undefined ? undefined : s.clockspeed.gpu_clockspeed * 1e6);
        add("clock_vram", "GPU Memory Clock", "Clock", UNIT.HERTZ,
            s => s.clockspeed?.vram_clockspeed === undefined ? undefined : s.clockspeed.vram_clockspeed * 1e6);
        add("vram_used", "GPU Memory Used", "Data", UNIT.BYTES, s => s.vram?.used);
        add("vram_total", "GPU Memory Total", "Data", UNIT.BYTES, s => s.vram?.total);
        add("busy", "GPU Core Load", "Load", UNIT.PERCENT, s => s.busy_percent);
        // stable aliases used by the curated GPU widget metrics
        const alias = (metricId, sensorName, sensorType, unit, extract, valueKind) => {
            sensors.set(metricId, {
                ...base, metricId, unit, sensorName, sensorType,
                metricIdKind: 1, valueKind: valueKind ?? 1,
                read: async () => {
                    const value = extract(await lactStats(device.id));
                    if (value === undefined || value === null) throw new Error("missing");
                    return value;
                },
            });
        };
        alias("gpu.temp", "GPU Core", "Temperature", UNIT.CELSIUS, s => s.temps?.GPU?.current);
        alias("gpu.usage_percent", "GPU Core Load", "Load", UNIT.PERCENT, s => s.busy_percent);
        alias("gpu.power", "GPU Package Power", "Power", UNIT.WATTS, s => s.power?.current);
        alias("gpu.power_limit", "Power Limit", "Power", UNIT.WATTS, s => s.power?.cap_current);
        alias("gpu.vram_used", "GPU Memory Used", "Data", UNIT.BYTES, s => s.vram?.used);
        alias("gpu.vram_total", "GPU Memory Total", "Data", UNIT.BYTES, s => s.vram?.total);
        alias("gpu.model", "GPU Model", "Text", 0, () => device.name, 2);
    }
}


// --------------------------------------------------------- MangoHud FPS source

const MANGOHUD_DIR = process.env.MANGOHUD_LOG_DIR
    ?? join(process.env.HOME ?? "/root", "mangohud_logs");
const MANGOHUD_FRESH_MS = 8000;
const MANGOHUD_CACHE_MS = 500;

function newestMangohudLog() {
    let files;
    try {
        files = readdirSync(MANGOHUD_DIR).filter(f => f.endsWith(".csv"));
    } catch {
        return undefined;
    }
    let best;
    for (const f of files) {
        try {
            const path = join(MANGOHUD_DIR, f);
            const st = statSync(path);
            if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs };
        } catch { /* file vanished mid-scan */ }
    }
    return best;
}

let mangohudCache = { at: 0, data: undefined };

// Parses the tail of the newest MangoHud CSV (columns: fps,frametime,...).
// Throws when no game has logged recently, which surfaces as metric-unavailable.
function readMangohudStats() {
    if (Date.now() - mangohudCache.at < MANGOHUD_CACHE_MS) {
        if (mangohudCache.data) return mangohudCache.data;
        throw new Error("no fresh mangohud log");
    }
    mangohudCache = { at: Date.now(), data: undefined };
    const log = newestMangohudLog();
    if (!log || Date.now() - log.mtimeMs > MANGOHUD_FRESH_MS) {
        throw new Error("no fresh mangohud log");
    }
    const fd = openSync(log.path, "r");
    let text;
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, 65536);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        text = buffer.toString("utf8");
    } finally {
        closeSync(fd);
    }
    const rows = [];
    for (const line of text.split("\n").slice(1)) { // first line may be partial
        const parts = line.split(",");
        if (parts.length < 2) continue;
        const fps = parseFloat(parts[0]);
        const frametime = parseFloat(parts[1]);
        if (Number.isFinite(fps) && Number.isFinite(frametime) && fps >= 0) {
            rows.push({ fps, frametime });
        }
    }
    if (rows.length === 0) throw new Error("no data rows yet");
    const window = rows.slice(-120);
    const recent = window.slice(-3);
    const frametimes = window.map(r => r.frametime).sort((a, b) => a - b);
    const p99 = frametimes[Math.min(frametimes.length - 1, Math.floor(frametimes.length * 0.99))];
    const data = {
        fps: recent.reduce((a, r) => a + r.fps, 0) / recent.length,
        frametime: recent[recent.length - 1].frametime,
        low1: p99 > 0 ? 1000 / p99 : 0,
    };
    mangohudCache.data = data;
    return data;
}

function enumerateMangohudSensors(sensors) {
    if (!existsSync(MANGOHUD_DIR)) return;
    const base = {
        hardwareId: "mangohud",
        hardwareName: "MangoHud",
        hardwareType: "Game",
        pollingGroupId: "mangohud",
    };
    const add = (key, sensorName, sensorType, unit, extract) => {
        const metricId = `linux-mangohud.${key}`;
        sensors.set(metricId, {
            ...base, metricId, unit, sensorName, sensorType,
            read: async () => extract(readMangohudStats()),
        });
    };
    add("fps", "FPS", "Level", UNIT.UNITLESS, s => s.fps);
    add("fps_1pct_low", "FPS 1% Low", "Level", UNIT.UNITLESS, s => s.low1);
    add("frametime", "Frametime", "Timing", UNIT.MILLISECONDS, s => s.frametime);
}

// ------------------------------------------------------------------- catalog

let sensors = new Map();
let lastEnumeratedAt = 0;
let enumerating = null;

async function refreshedSensors() {
    if (Date.now() - lastEnumeratedAt < ENUMERATE_INTERVAL_MS) return sensors;
    enumerating ??= (async () => {
        const next = new Map();
        enumerateHwmonSensors(next);
        addCpuTempAlias(next);
        try {
            enumerateMangohudSensors(next);
        } catch (e) {
            console.error("mangohud enumeration failed:", e.message);
        }
        try {
            await enumerateLactSensors(next);
        } catch (e) {
            console.error("lact enumeration failed:", e.message);
        }
        sensors = next;
        lastEnumeratedAt = Date.now();
        enumerating = null;
    })();
    await enumerating;
    return sensors;
}

function descriptorFor(sensor) {
    return {
        descriptor: {
            metric_id: sensor.metricId,
            value_kind: sensor.valueKind ?? 1,
            unit: sensor.unit,
            metric_id_kind: sensor.metricIdKind ?? 2,
            polling_group_id: sensor.pollingGroupId,
        },
        raw_sensor_identity: {
            source_sensor_id: sensor.metricId,
            hardware_id: sensor.hardwareId,
            hardware_name: sensor.hardwareName,
            hardware_type: sensor.hardwareType,
            sensor_name: sensor.sensorName,
            source_sensor_type: sensor.sensorType,
        },
    };
}

function fingerprint(all) {
    return `linux:${all.size}:${[...all.keys()].sort().join("|").length}`;
}

function nowTimestamp() {
    const ms = Date.now();
    return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
}

// -------------------------------------------------------------------- server

const handlers = {
    GetSourceHealth(_call, callback) {
        callback(null, {
            source_id: "linux-hwmon-helper",
            protocol_version: PROTOCOL_VERSION,
            helper_version: HELPER_VERSION,
            warnings: [],
            component_statuses: [
                { component: "sysfs:hwmon", state: 2 /* OK */ },
                { component: "daemon:lactd", state: existsSync(LACT_SOCKET) ? 2 : 3 /* NOT_INSTALLED */ },
            ],
        });
    },

    ListMetricDescriptors(call, callback) {
        refreshedSensors().then(all => {
            const filter = call.request.metric_ids ?? [];
            const selected = filter.length > 0
                ? filter.map(id => all.get(id)).filter(Boolean)
                : [...all.values()];
            callback(null, {
                descriptor_snapshot: {
                    descriptors: selected.map(descriptorFor),
                    descriptor_fingerprint: fingerprint(all),
                },
                warnings: [],
            });
        }).catch(e => callback(e));
    },

    ReadMetricSnapshot(call, callback) {
        refreshedSensors().then(async all => {
            const requested = (call.request.metric_ids?.length ?? 0) > 0
                ? call.request.metric_ids
                : [...all.keys()];
            const metrics = {};
            const provenance = [];
            const unavailable = [];
            await Promise.all(requested.map(async id => {
                const sensor = all.get(id);
                if (!sensor) {
                    unavailable.push({ report: { metric_id: id, reason: 1 /* NO_SOURCE_READING */ } });
                    return;
                }
                try {
                    const value = await sensor.read();
                    metrics[id] = {
                        ...(typeof value === "string" ? { text: value } : { scalar: value }),
                        unit: sensor.unit,
                        metadata: { freshness: 1 /* FRESH */ },
                    };
                    provenance.push({
                        metric_id: id,
                        raw_sensor_identity: descriptorFor(sensor).raw_sensor_identity,
                    });
                } catch {
                    unavailable.push({
                        report: { metric_id: id, reason: 2 /* INVALID_VALUE */ },
                        raw_sensor_identity: descriptorFor(sensor).raw_sensor_identity,
                    });
                }
            }));
            const response = {
                snapshot: { captured_at: nowTimestamp(), metrics },
                warnings: [],
                value_provenance: provenance,
                unavailable_metrics: unavailable,
            };
            if (call.request.include_descriptors) {
                response.descriptor_snapshot = {
                    descriptors: [...all.values()].map(descriptorFor),
                    descriptor_fingerprint: fingerprint(all),
                };
            }
            callback(null, response);
        }).catch(e => callback(e));
    },

    SetMetricRefreshDemand(call, callback) {
        // reads are cheap and done on demand; accept everything
        callback(null, {
            accepted_group_count: call.request.groups?.length ?? 0,
            ignored_group_count: 0,
            effective_minimum_interval_milliseconds: 500,
            demand_ttl_milliseconds: 60000,
            warnings: [],
        });
    },
};

const packageDefinition = protoLoader.loadSync(
    "shometrics/v1/helper_grpc_service.proto",
    { includeDirs: [join(import.meta.dirname, "proto")], keepCase: true, defaults: true },
);
const proto = grpc.loadPackageDefinition(packageDefinition);

mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH);

const server = new grpc.Server({
    "grpc.max_send_message_length": 1024 * 1024,
    "grpc.max_receive_message_length": 1024 * 1024,
});
server.addService(proto.shometrics.v1.MetricSourceService.service, handlers);
server.bindAsync(`unix://${SOCKET_PATH}`, grpc.ServerCredentials.createInsecure(), async (err) => {
    if (err) {
        console.error("bind failed:", err.message);
        process.exit(1);
    }
    const all = await refreshedSensors();
    console.log(`serving ${all.size} sensors on ${SOCKET_PATH}`);
});
