#!/usr/bin/env python3
"""Apply the Linux-support patches to a pristine Sho Metrics plugin.

Usage: apply-linux-patches.py <path-to-sdPlugin-dir>

Patches bin/plugin.js (backend) and ui/property-inspector.js (PI).
Verified against plugin v0.2.0; minified identifiers (`QY`, `H3`, `I1`, `Mn`,
`qt`, `dn`, `hI`, `iI`, `o`) may need re-discovery on newer releases - find
them via the anchor strings below.
"""
import sys
from pathlib import Path

BACKEND_PATCHES = [
    # 1: createDefaultSourceRegistry: register the helper source client on linux
    ('return"win32"===t&&n.push(new QY),',
     'return("win32"===t||"linux"===t)&&n.push(new QY),'),
    # 2: helper gRPC target: unix socket instead of windows named pipe
    ('`unix:\\\\\\\\.\\\\pipe\\\\${',
     '`unix:///tmp/shometrics-helper/${'),
    # 3: helper catalog sync gate
    ('if("win32"!==e)return void await n({availableCatalogMetricDescriptors:',
     'if("win32"!==e&&"linux"!==e)return void await n({availableCatalogMetricDescriptors:'),
    # 4: helper status display mapping
    ('function H3(e,t){if("win32"===t)return',
     'function H3(e,t){if("win32"===t||"linux"===t)return'),
    # 5: property inspector helper status subscription
    ('"win32"===process.platform&&(I1.subscribe(',
     '("win32"===process.platform||"linux"===process.platform)&&(I1.subscribe('),
    # 6: runtime context sent to the PI (isWindows = helper-capable platform)
    ('return{isWindows:"win32"===process.platform,',
     'return{isWindows:"win32"===process.platform||"linux"===process.platform,'),
    # 7: infer PI presence from incoming sendToPlugin messages. OpenDeck mounts
    # all PI iframes hidden at startup and only sends propertyInspectorDidAppear
    # when the user opens the panel, so the SDK's ui.current is unset when the
    # PI's early runtime-connection ping arrives and every reply is dropped.
    ('const Mn=new class{#m;#g=0;constructor(){this.onDidAppear(e=>{',
     'const Mn=new class{#m;#g=0;constructor(){qt.disposableOn("sendToPlugin",'
     't=>{const n=dn.getActionById(t.context);n&&(this.#g=1,this.#m=n)}),'
     'this.onDidAppear(e=>{'),
    # 7b: answer the PI runtime-connection ping via the event's own context.
    # With several PI iframes pinging (OpenDeck mounts them all), the
    # ui.current-based reply raced the presence tracker and answered the
    # previous pinger.
    ('return void Dn.ui.sendToPropertyInspector((n=t.requestId,{type:YN,command:"pong",requestId:n}));var n;',
     'return void qt.send({event:"sendToPropertyInspector",context:e.action.id,payload:{type:YN,command:"pong",requestId:t.requestId}});var n;'),
    # 10: one-decimal displayValue for amps/volts/watts catalog metrics
    ('return{value:j0(e/1e9,1,3),unit:"GHz"}}(t);default:return}',
     'return{value:j0(e/1e9,1,3),unit:"GHz"}}(t);'
     'case To.AMPERES:return{value:t.toFixed(1),unit:"A"};'
     'case To.VOLTS:return{value:t.toFixed(1),unit:"V"};'
     'case To.WATTS:return{value:t.toFixed(1),unit:"W"};'
     'default:return}'),
    # 11: bar view on uncategorized hardware: title by reading kind (the
    # sensor label already renders at the bottom), icon by reading kind
    ('l=s3("bar"===a?N3[e.target.detectedCategory]:o??i,s)??W3',
     'l=s3("bar"!==a?o??i:"other"!==e.target.detectedCategory&&"unspecified"!==e.target.detectedCategory'
     '?N3[e.target.detectedCategory]'
     ':o??{temperature:"Temperature",usage:"Usage",clock:"Clock",voltage:"Voltage",current:"Current",'
     'power:"Power",fan:"Fan",control:"Control",data:"Data",throughput:"Throughput",timing:"Timing",'
     'level:"Level"}[e.target.detectedReadingKind]??i,s)??W3'),
    ('function P3(e){const t=A0({hardware:e.detectedCategory,status:T3(e.detectedReadingKind)});return{...t,centerIconFragment:ZP(e.customIconId)??t.centerIconFragment}}',
     'function P3(e){const t=A0({hardware:e.detectedCategory,status:T3(e.detectedReadingKind)});const n="other"===e.detectedCategory||"unspecified"===e.detectedCategory?M0(w0(T3(e.detectedReadingKind)),58):void 0;return{...t,centerIconFragment:ZP(e.customIconId)??n??t.centerIconFragment}}'),
    # 9: localSourceSupportsMetricOnPlatform: the source router strips the
    # helper from every candidate list off-Windows, leaving catalog metrics
    # with no source at all (empty selectedSourceId, permanent "no data").
    ('case Oo:return"win32"===n;',
     'case Oo:return"win32"===n||"linux"===n;'),
]

# 8: the PI receives platform "linux" from OpenDeck's make_info (only wine
# plugins get "windows"), so its own isWindows gates hide the sensor UI.
PI_PATCHES = [
    ('l="win32"===o', 'l="win32"===o||"linux"===o'),
    ('function hI(e){return"win32"===e}', 'function hI(e){return"win32"===e||"linux"===e}'),
    ('case iI:return"win32"===n;', 'case iI:return"win32"===n||"linux"===n;'),
    # 8b: give amperes sensors their own "Current" category in the Advanced
    # Sensor picker (upstream files them under "Other"; wireview exposes 7)
    ('case"voltage":return"voltage";case"power":return"power";',
     'case"current":return"current";case"voltage":return"voltage";case"power":return"power";'),
    ('clock:"Clock",voltage:"Voltage",power:"Power",fan:"Fan",',
     'clock:"Clock",voltage:"Voltage",current:"Current",power:"Power",fan:"Fan",'),
    # 8b (cont): category order map and i18n label for Current
    ('{temperature:0,usage:1,clock:2,voltage:3,power:4,fan:5,control:6,data:7,throughput:8,timing:9,other:10}',
     '{temperature:0,usage:1,clock:2,voltage:3,current:4,power:5,fan:6,control:7,data:8,throughput:9,timing:10,other:11}'),
    ('case"voltage":return t.t(ns.voltageOption);case"power":return t.t(ns.powerOption);',
     'case"voltage":return t.t(ns.voltageOption);case"current":return"Current";case"power":return t.t(ns.powerOption);'),
]


def apply(path: Path, patches) -> None:
    src = path.read_text()
    for old, new in patches:
        count = src.count(old)
        assert count == 1, f"{path.name}: expected 1 occurrence, got {count}: {old[:60]!r}"
        src = src.replace(old, new)
    path.write_text(src)
    print(f"applied {len(patches)} patches to {path}")


plugin_dir = Path(sys.argv[1])
apply(plugin_dir / "bin" / "plugin.js", BACKEND_PATCHES)
apply(plugin_dir / "ui" / "property-inspector.js", PI_PATCHES)
print("done - remember to add the linux OS entry to manifest.json and the"
      " linux natives for resvg-js/node-hid (see README)")
