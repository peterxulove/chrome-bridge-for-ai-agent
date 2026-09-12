/**
 * ws-lite — 极简 WebSocket 服务端（RFC 6455），零依赖。
 *
 * 只实现本项目需要的部分：握手、文本帧收发、分片重组、ping/pong、close。
 * 消息都是小体积 JSON，不追求做通用库。
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024 * 1024;

export class MiniWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // 1 = OPEN
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = 0;

    socket.on('data', (c) => this._onData(c));
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
    socket.setNoDelay?.(true);
  }

  _die() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    for (;;) {
      const frame = this._parse();
      if (!frame) break;
      this._handle(frame);
    }
  }

  _parse() {
    const b = this._buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) === 0x80;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) === 0x80;

    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('payload_too_large');
      len = Number(big);
      off += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;

    let payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handle({ fin, opcode, payload }) {
    if (opcode === 0x8) return this.close(1000, '');
    if (opcode === 0x9) return this._write(0xa, payload);
    if (opcode === 0xa) return this.emit('pong');

    if (opcode === 0x0) {
      this._fragments.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this._fragments);
      this._fragments = [];
      if (this._fragOpcode === 0x1) this.emit('message', full.toString('utf8'));
      return;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        this._fragOpcode = opcode;
        this._fragments = [payload];
        return;
      }
      if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
      else this.emit('message', payload);
    }
  }

  _write(opcode, payload) {
    if (this.readyState !== 1) return;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = buf.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, buf]));
    } catch {
      this._die();
    }
  }

  send(data) {
    this._write(0x1, data);
  }

  ping() {
    this._write(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    const r = Buffer.from(String(reason), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._write(0x8, p);
    this.readyState = 2; // CLOSING
    setTimeout(() => {
      try { this.socket.destroy(); } catch {}
      this._die();
    }, 60);
  }
}

/**
 * 完成 HTTP → WebSocket 升级握手。
 * @returns {MiniWebSocket|null}
 */
export function acceptUpgrade(req, socket, head, onOpen) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const ws = new MiniWebSocket(socket);
  if (head && head.length) ws._onData(head);
  onOpen(ws);
  return ws;
}
