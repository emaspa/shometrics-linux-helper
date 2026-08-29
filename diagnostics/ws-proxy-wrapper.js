// Diagnostic wrapper: WS-frame-decoding proxy between the SDK and OpenDeck.
import net from "node:net";
import fs from "node:fs";
const LOG = "/tmp/shometrics-ws.log";
const log = (line) => { try { fs.appendFileSync(LOG, line + "\n"); } catch {} };

const portIdx = process.argv.indexOf("-port");
const realPort = parseInt(process.argv[portIdx + 1], 10);
const proxyPort = 58999;

function decodeFrames(buffer, dir) {
    let off = 0;
    while (off + 2 <= buffer.length) {
        const b0 = buffer[off], b1 = buffer[off + 1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, hdr = 2;
        if (len === 126) { if (off + 4 > buffer.length) break; len = buffer.readUInt16BE(off + 2); hdr = 4; }
        else if (len === 127) { if (off + 10 > buffer.length) break; len = Number(buffer.readBigUInt64BE(off + 2)); hdr = 10; }
        const maskLen = masked ? 4 : 0;
        if (off + hdr + maskLen + len > buffer.length) break;
        let payload = buffer.slice(off + hdr + maskLen, off + hdr + maskLen + len);
        if (masked) {
            const key = buffer.slice(off + hdr, off + hdr + 4);
            payload = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]));
        }
        if (opcode === 1) log(dir + " " + payload.toString("utf8").slice(0, 400));
        else if (opcode !== 0) log(dir + " [opcode " + opcode + " len " + len + "]");
        off += hdr + maskLen + len;
    }
    return off;
}

const server = net.createServer((client) => {
    const upstream = net.connect(realPort, "127.0.0.1");
    let cBuf = Buffer.alloc(0), uBuf = Buffer.alloc(0), handshakeDone = false;
    client.on("data", (d) => {
        upstream.write(d);
        if (!handshakeDone) return;
        cBuf = Buffer.concat([cBuf, d]);
        cBuf = cBuf.slice(decodeFrames(cBuf, "PLUGIN->OD:"));
    });
    upstream.on("data", (d) => {
        client.write(d);
        if (!handshakeDone) {
            const s = d.toString("latin1");
            if (s.includes("101")) { handshakeDone = true; log("== handshake done =="); }
            return;
        }
        uBuf = Buffer.concat([uBuf, d]);
        uBuf = uBuf.slice(decodeFrames(uBuf, "OD->PLUGIN:"));
    });
    client.on("error", () => {}); upstream.on("error", () => {});
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
});
server.listen(proxyPort, "127.0.0.1", () => {
    log("== proxy up, real port " + realPort + " ==");
    process.argv[portIdx + 1] = String(proxyPort);
    import("./plugin-real.js");
});
