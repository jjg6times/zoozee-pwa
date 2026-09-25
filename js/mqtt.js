// Minimal MQTT 3.1.1 client over WebSocket (binary frames).
// Supports CONNECT, SUBSCRIBE, PUBLISH, PINGREQ and parsing of incoming
// PUBLISH/CONNACK/SUBACK/PINGRESP frames. QoS 0 only (what the robot uses).
(function (global) {
  'use strict';

  function encodeLen(n) {
    const out = [];
    let len = n;
    do {
      let d = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) d |= 0x80;
      out.push(d);
    } while (len > 0);
    return out;
  }

  function readLen(bytes, at) {
    let mult = 1;
    let value = 0;
    let i = at;
    let count = 0;
    while (count < 4) {
      const b = bytes[i++];
      value += (b & 0x7f) * mult;
      mult *= 128;
      count++;
      if ((b & 0x80) === 0) break;
    }
    return { value, next: i };
  }

  function buildConnect(opts) {
    const cid = stringBytes(opts.clientId || '');
    const user = opts.username !== undefined ? stringBytes(String(opts.username)) : null;
    const pass = opts.password !== undefined ? stringBytes(String(opts.password)) : null;
    const proto = stringBytes('MQTT');
    let flags = 0x02; // clean session
    if (user) flags |= 0x80;
    if (pass) flags |= 0x40;
    const vh = concat(
      concat([0x00, proto.length], proto),
      [0x04, flags],
      [0x00, 0x3c]
    );
    const payload = concat(
      user ? concat([(user.length >> 8) & 0xff, user.length & 0xff], user) : [],
      pass ? concat([(pass.length >> 8) & 0xff, pass.length & 0xff], pass) : [],
      concat([(cid.length >> 8) & 0xff, cid.length & 0xff], cid)
    );
    const body = concat(vh, payload);
    return concat([0x10], concat(encodeLen(body.length), body));
  }

  function buildSubscribe(msgId, topic, qos) {
    const t = stringBytes(topic);
    const payload = concat(
      [0x00, msgId & 0xff],
      [(t.length >> 8) & 0xff, t.length & 0xff],
      t,
      [qos & 0x03]
    );
    return concat([0x82], concat(encodeLen(payload.length), payload));
  }

  function buildPublish(topic, payload, msgId) {
    const t = stringBytes(topic);
    const body = concat(
      concat([(t.length >> 8) & 0xff, t.length & 0xff], t),
      msgId != null ? [0x00, msgId & 0xff] : [],
      payload
    );
    return concat([0x30], concat(encodeLen(body.length), body));
  }

  function buildPing() {
    return [0xc0, 0x00];
  }

  function stringBytes(s) {
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
    return arr;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function parsePublish(bytes, headerStart, body) {
    // returns { topic, payload (Uint8Array) }
    const tl = (body[headerStart] << 8) | body[headerStart + 1];
    let at = headerStart + 2;
    let topic = '';
    for (let i = 0; i < tl; i++) topic += String.fromCharCode(body[at++]);
    // skip packet id (QoS>0) - robot uses QoS 0
    const payload = body.slice(at);
    return { topic, payload };
  }

  class MqttClient {
    constructor() {
      this.ws = null;
      this.connected = false;
      this.msgId = 1;
      this._buffer = null; // accumulating incoming bytes
      this.onConnect = null;
      this.onMessage = null;
      this.onClose = null;
      this.onError = null;
    }

    connect(url, opts) {
      if (this.ws) this.disconnect();
      const ws = new WebSocket(url, 'mqtt');
      this.ws = ws;
      const self = this;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        ws.send(buildConnect(opts));
      };

      ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data);
        this._ingest(data);
      };

      ws.onclose = () => {
        this.connected = false;
        if (self.onClose) self.onClose();
      };

      ws.onerror = (err) => {
        if (self.onError) self.onError(err);
      };

      this._connAckCb = (code) => {
        this.connected = code === 0;
        if (self.onConnect) self.onConnect(this.connected ? null : code);
      };
    }

    _ingest(bytes) {
      const buf = this._buffer ? concat(this._buffer, bytes) : bytes;
      let at = 0;
      while (at < buf.length) {
        const first = buf[at];
        const type = (first >> 4) & 0x0f;
        const rl = readLen(buf, at + 1);
        const bodyAt = rl.next;
        if (buf.length < bodyAt + rl.value) break; // incomplete frame
        const body = buf.subarray(bodyAt, bodyAt + rl.value);
        this._handle(type, body);
        at = bodyAt + rl.value;
      }
      this._buffer = at < buf.length ? buf.subarray(at) : null;
    }

    _handle(type, body) {
      switch (type) {
        case 2: // CONNACK
          if (this._connAckCb) {
            const code = body.length > 2 ? body[2] : body[1] || 0xff;
            this.connected = code === 0;
            this._connAckCb(this.connected ? null : code);
          }
          break;
        case 3: { // PUBLISH
          const msg = parsePublish(body, 0, body);
          if (this.onMessage) this.onMessage(msg.topic, msg.payload, body);
          break;
        }
        case 9: // SUBACK
          if (this._subAckCb) this._subAckCb(Array.from(body.slice(2)));
          break;
        case 13: // PINGRESP
          break;
        default:
          break;
      }
    }

    _send(bytes) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
    }

    subscribe(topic, qos, cb) {
      this._subAckCb = cb || null;
      this._send(buildSubscribe(this.msgId++, topic, qos || 0));
    }

    publish(topic, payload, msgId) {
      this._send(buildPublish(topic, payload, msgId));
    }

    ping() {
      this._send(buildPing());
    }

    disconnect() {
      if (this.ws) {
        try { this.ws.close(); } catch (e) { /* noop */ }
        this.ws = null;
      }
      this.connected = false;
    }
  }

  global.MqttClient = MqttClient;
})(window);