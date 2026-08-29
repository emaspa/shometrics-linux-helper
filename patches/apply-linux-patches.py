#!/usr/bin/env python3
"""Apply the Linux-support patches to a pristine Sho Metrics plugin bundle.

Usage: apply-linux-patches.py <path-to-plugin.js>

Patches the five platform gates that keep the plugin's out-of-process helper
source Windows-only, and swaps the Windows named-pipe gRPC target for the unix
socket served by shometrics-linux-helper. Verified against plugin v0.2.0;
minified identifiers (e.g. `QY`, `H3`, `I1`) may need re-discovery on newer
releases — find them via the anchor strings below.
"""
import sys

PATCHES = [
    # createDefaultSourceRegistry: register the helper source client on linux
    ('return"win32"===t&&n.push(new QY),',
     'return("win32"===t||"linux"===t)&&n.push(new QY),'),
    # helper gRPC target: unix socket instead of windows named pipe
    ('`unix:\\\\\\\\.\\\\pipe\\\\${',
     '`unix:///tmp/shometrics-helper/${'),
    # helper catalog sync gate
    ('if("win32"!==e)return void await n({availableCatalogMetricDescriptors:',
     'if("win32"!==e&&"linux"!==e)return void await n({availableCatalogMetricDescriptors:'),
    # helper status display mapping
    ('function H3(e,t){if("win32"===t)return',
     'function H3(e,t){if("win32"===t||"linux"===t)return'),
    # property inspector helper status subscription
    ('"win32"===process.platform&&(I1.subscribe(',
     '("win32"===process.platform||"linux"===process.platform)&&(I1.subscribe('),
]

path = sys.argv[1]
src = open(path).read()
for old, new in PATCHES:
    count = src.count(old)
    assert count == 1, f"expected 1 occurrence, got {count}: {old[:60]!r}"
    src = src.replace(old, new)
open(path, "w").write(src)
print(f"applied {len(PATCHES)} patches to {path}")
