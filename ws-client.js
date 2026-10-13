/**
 * dsh-wechat-media - a minimal RFC 6455 WebSocket client.
 *
 * Why hand-rolled: Node's built-in `WebSocket` (undici) failed the handshake against
 * WeCom's long-connection endpoint with an opaque `TypeError` and no message, while a
 * hand-written upgrade over the same TLS socket is answered with
 * `101 Switching Protocols` by `curl` and by this client. Keeping it here also keeps
 * the plugin dependency-free and lets the framing be tested without a network.
 *
 * Scope: text frames, ping/pong, close, fragmentation on receive, client-side masking.
 * No extensions, no subprotocols - which is all the WeCom bot channel uses.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect as tlsConnect } from "node:tls";

/** The magic string from RFC 6455 section 4.2.2. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value a server must answer with. */
export function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** A fresh 16-byte client key. */
export function clientKey() {
  return randomBytes(16).toString("base64");
}

/**
 * Encode one client frame. Client frames are always masked (RFC 6455 section 5.3).
 * @param {number} opcode 0x1 text, 0x8 close, 0x9 ping, 0xA pong
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = randomBytes(4), fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  header[1] |= 0x80; // masked
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Decode as many frames as `buffer` holds.
 * @returns {{ frames: Array<{fin:boolean, opcode:number, payload:Buffer}>, rest: Buffer }}
 */
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * A WebSocket client that speaks just enough of the protocol.
 *
 * Events: `open`, `message` ({ data }), `close` ({ code, reason }), `error` (Error).
 */
export class MiniWebSocket extends EventEmitter {
  constructor(url, { headers = {}, timeoutMs = 20000, ca, rejectUnauthorized = true } = {}) {
    super();
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:") throw new Error(`only wss:// is supported, got ${parsed.protocol}`);
    this.url = url;
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 443);
    this.path = `${parsed.pathname}${parsed.search}` || "/";
    this.extraHeaders = headers;
    this.timeoutMs = timeoutMs;
    this.readyState = 0; // 0 connecting, 1 open, 2 closing, 3 closed
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.key = clientKey();
    this.socket = tlsConnect(
      { host: this.host, port: this.port, servername: this.host, ...(ca ? { ca } : {}), rejectUnauthorized },
      () => this.#writeHandshake(),
    );
    this.socket.setTimeout(timeoutMs, () => this.#fail(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`)));
    this.socket.on("data", (chunk) => this.#onData(chunk));
    this.socket.on("error", (error) => this.#fail(error));
    this.socket.on("close", () => this.#onSocketClose());
  }

  #writeHandshake() {
    const lines = [
      `GET ${this.path} HTTP/1.1`,
      `Host: ${this.host}${this.port === 443 ? "" : `:${this.port}`}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(this.extraHeaders).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ];
    this.socket.write(lines.join("\r\n"));
  }

  #fail(error) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
    try {
      this.socket?.destroy();
    } catch {
      // already gone
    }
    this.emit("close", { code: 1006, reason: "", wasClean: false });
  }

  #onSocketClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1006, reason: "", wasClean: false });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.readyState === 0) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 4);
      const status = Number(head.split("\r\n")[0].split(" ")[1]);
      if (status !== 101) {
        this.#fail(new Error(`WebSocket upgrade refused: ${head.split("\r\n")[0]}`));
        return;
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== acceptKey(this.key)) {
        this.#fail(new Error("WebSocket upgrade answered with a wrong Sec-WebSocket-Accept"));
        return;
      }
      this.readyState = 1;
      this.socket.setTimeout(0);
      this.emit("open");
    }
    if (this.readyState !== 1 && this.readyState !== 2) return;
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) this.#onFrame(frame);
  }

  #onFrame(frame) {
    if (frame.opcode === 0x8) {
      // Close: answer once, then finish.
      if (this.readyState === 1) {
        this.readyState = 2;
        try {
          this.socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2)));
        } catch {
          // the peer may be gone already
        }
      }
      try {
        this.socket.end();
      } catch {
        // already gone
      }
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
      this.readyState = 3;
      this.emit("close", { code, reason: frame.payload.subarray(2).toString("utf8"), wasClean: true });
      return;
    }
    if (frame.opcode === 0x9) {
      try {
        this.socket.write(encodeFrame(0xa, frame.payload));
      } catch {
        // ignore
      }
      return;
    }
    if (frame.opcode === 0xa) return; // pong
    if (frame.opcode === 0x0 && this.fragmentOpcode !== 0) {
      this.fragments.push(frame.payload);
      if (frame.fin) {
        const data = Buffer.concat(this.fragments);
        const opcode = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.emit("message", { data: opcode === 0x1 ? data.toString("utf8") : data });
      }
      return;
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (!frame.fin) {
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        return;
      }
      this.emit("message", { data: frame.opcode === 0x1 ? frame.payload.toString("utf8") : frame.payload });
    }
  }

  /** Send a text frame. */
  send(data) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    this.socket.write(encodeFrame(0x1, Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")));
    return true;
  }

  /** Close politely (1000), then the socket. */
  close() {
    if (this.readyState === 3) return;
    if (this.readyState === 1) {
      this.readyState = 2;
      try {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1000, 0);
        this.socket.write(encodeFrame(0x8, payload));
      } catch {
        // ignore
      }
    }
    try {
      this.socket.end();
    } catch {
      // already gone
    }
  }

  addEventListener(type, listener) {
    this.on(type, (event) => listener(event));
    return this;
  }

  removeEventListener(type, listener) {
    this.off(type, listener);
    return this;
  }
}
