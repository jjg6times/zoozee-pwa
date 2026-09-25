'use strict';

/* ================= config ================= */
const CFG = {
  BASE: 'https://cloud.slamtec.com',
  WS: 'wss://iot.slamtec.com:8084/mqtt',
  MQTT_PWD: 'Y@1!ghHhPc91',
  APP_KEY: 'apeman',
  APP_SECRET: 'r90GT8EtL3h0',
  USER_AGENT: 'okhttp/4.9.0'
};

/* OAuth token types / MQTT data types */
const TYPE = {
  POSE: 1, CURRENT_ACTION: 2, BATTERY_PERCENTAGE: 3, BATTERY_IS_CHARGING: 4,
  EXPLORE_MAP: 7, SWEEP_MAP: 8, VIRTUAL_WALLS: 9, HELLO: 16,
  ENTIRE_EXPLORE_MAP: 17, ENTIRE_SWEEP_MAP: 18, ROBOTTRACK: 19,
  SWEEP_AREA: 20, DOCK_POSE: 21, ROBOT_STATUS: 22,
  SWEEP_REGION: 25, SWEEPING_REGION: 26
};
const CMD = {
  STOP: 24, GO_HOME: 25, SWEEP: 26, SWEEP_SPOT: 27, CLEAR_MAP: 54, FIND_ME: 56,
  START_SWEEP_REGION: 68, START_AUTO_EXPLORING: 108, START_EDGE_SWEEPING: 109
};

/* ================= state ================= */
const $ = (id) => document.getElementById(id);

const store = {
  get remember() { return localStorage.getItem('jarvis.remember') !== '0'; },
  set remember(v) {
    localStorage.setItem('jarvis.remember', v ? '1' : '0');
    const src = v ? sessionStorage : localStorage;
    const dst = v ? localStorage : sessionStorage;
    for (const k of ['jarvis.email', 'jarvis.refresh']) {
      if (src.getItem(k)) {
        dst.setItem(k, src.getItem(k));
        src.removeItem(k);
      }
    }
  },
  get email() { return localStorage.getItem('jarvis.email') || sessionStorage.getItem('jarvis.email'); },
  set email(v) {
    const s = this.remember ? localStorage : sessionStorage;
    if (v) s.setItem('jarvis.email', v); else s.removeItem('jarvis.email');
  },
  get refresh() { return localStorage.getItem('jarvis.refresh') || sessionStorage.getItem('jarvis.refresh'); },
  set refresh(v) {
    const s = this.remember ? localStorage : sessionStorage;
    if (v) s.setItem('jarvis.refresh', v); else s.removeItem('jarvis.refresh');
  }
};

let access = null;
let accessType = 'Bearer';
let expiresAt = 0;

const state = {
  user: null,
  devices: [],
  device: null,
  mqtt: new MqttClient(),
  mqttOk: false,
  mqttReconnecting: false,
  maps: [],            // received map tiles: {grid, dimX, dimY, res, realX, realY}
  worldBounds: null,   // {minX,minY,maxX,maxY} in meters
  deviceId: null,
  pose: null,          // {x,y,yaw}
  action: null,        // {an,st,pt,ms}
  battery: null,
  charging: null,
  status: null,
  spot: false,
  spotStart: null,
  logCount: 0
};

/* ================= api helpers ================= */
function log(msg) {
  const box = $('log-box');
  if (!box) return;
  state.logCount++;
  box.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + box.textContent;
  if (state.logCount > 80) {
    const lines = box.textContent.split('\n').slice(0, 60);
    box.textContent = lines.join('\n');
    state.logCount = 60;
  }
}

function basicAuth() {
  return 'Basic ' + btoa(CFG.APP_KEY + ':' + CFG.APP_SECRET);
}

async function http(path, { method = 'GET', body, headers = {}, useAuth = true, raw = false } = {}) {
  const opts = { method, headers: { 'User-Agent': CFG.USER_AGENT, ...headers } };
  if (body !== undefined) opts.body = body;
  if (useAuth && access) opts.headers['Authorization'] = accessType + ' ' + access;
  const res = await fetch(CFG.BASE + path, opts);
  if (res.status === 401 && useAuth && store.refresh) {
    await refreshTokens();
    opts.headers['Authorization'] = accessType + ' ' + access;
    const res2 = await fetch(CFG.BASE + path, opts);
    return { ok: res2.ok, status: res2.status, body: await res2.text(), headers: res2.headers };
  }
  return { ok: res.ok, status: res.status, body: await res.text(), headers: res.headers };
}

function jsonOk(res) {
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.body.slice(0, 200));
  try { return JSON.parse(res.body); } catch (e) { return res.body; }
}

async function oauthPassword(email, password) {
  const form = new URLSearchParams({ grant_type: 'password', username: email, password });
  const res = await fetch(CFG.BASE + '/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CFG.USER_AGENT },
    body: form.toString()
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.includes('User not found') ? 'Account not found' : 'Wrong email or password');
  return JSON.parse(text);
}

async function refreshTokens() {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.refresh });
  const res = await fetch(CFG.BASE + '/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CFG.USER_AGENT },
    body: form.toString()
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Refresh failed');
  const tok = JSON.parse(text);
  access = tok.access_token;
  accessType = tok.token_type || 'Bearer';
  store.refresh = tok.refresh_token || store.refresh;
  expiresAt = Date.now() + ((tok.expires_in || 1800) - 60) * 1000;
  log('token refreshed');
}

async function ensureAccess() {
  if (access && Date.now() < expiresAt) return;
  if (!store.refresh) throw new Error('Not signed in');
  await refreshTokens();
}

async function fetchUser() {
  await ensureAccess();
  const res = await http('/api/users?user=' + encodeURIComponent(store.email));
  const j = jsonOk(res);
  state.user = j;
  $('account-line').textContent = 'account: ' + store.email;
  log('user: ' + JSON.stringify(j).slice(0, 160));
}

async function fetchDevices() {
  await ensureAccess();
  const res = await http('/api/devices?user=' + encodeURIComponent(store.email) +
    '&with_location=true&with_owner=true&page=0&size=20', {
    headers: { 'Accept': 'application/vnd.slamtec.devicelist-v1.0+json' }
  });
  const j = jsonOk(res);
  let devs = Array.isArray(j) ? j : (j.content || j.devices || j.data || []);
  state.devices = devs;
  state.device = devs[0] || null;
  if (state.device) {
    const d = state.device;
    state.deviceId = d.device_id || d.id || d.sn;
    const id = state.deviceId;
    $('dev-name').textContent = d.name || 'Jarvis';
    $('dev-sub').textContent = (d.model || '') + ' · ' + String(id || '').slice(0, 8);
    log('device: ' + JSON.stringify({ name: d.name, model: d.model, online: d.online, wl: d.work_status, map: d.current_map }).slice(0, 200));
    updateOnlineBadge();
    return id;
  }
  throw new Error('No robot found on this account');
}

/* ================= status UI ================= */
function updateOnlineBadge() {
  const d = state.device;
  if (!d) return;
  const pill = $('pill-online');
  const banner = $('banner');
  if (d.online) {
    pill.textContent = 'Online';
    pill.className = 'pill on';
    banner.classList.add('hidden');
  } else {
    pill.textContent = 'Offline';
    pill.className = 'pill off';
    banner.textContent = 'Robot is offline (last seen ' + (d.sl_last_seen || d.last_seen || '?') +
      '). Switch it on and connect it to WiFi, then refresh.';
    banner.classList.remove('hidden');
  }
}

function renderStatus() {
  const pillB = $('pill-battery');
  const pillC = $('pill-charge');
  if (state.battery != null) {
    pillB.textContent = state.battery + '%';
    pillB.className = 'pill' + (state.battery < 20 ? ' off' : ' on');
  }
  if (state.charging != null) {
    pillC.textContent = state.charging ? 'Charging' : 'Not charging';
    pillC.className = 'pill' + (state.charging ? ' on' : '');
    pillC.style.display = '';
  }
  const act = state.action;
  const statusTxt = state.status && state.status.text ? String(state.status.text) : '';
  if (act && act.an) {
    $('action-line').textContent = 'Action: ' + act.an + ' (' + (act.st ?? '?') + ')' + (statusTxt ? ' · ' + statusTxt : '');
  } else if (statusTxt) {
    $('action-line').textContent = statusTxt;
  } else {
    $('action-line').textContent = 'Idle';
  }
  if (state.pose) {
    $('pos-line').textContent = `x: ${state.pose.x.toFixed(2)} m   y: ${state.pose.y.toFixed(2)} m`;
  }
}

/* ================= MQTT ================= */
function connectMqtt(deviceId) {
  const m = state.mqtt;
  m.connect(CFG.WS, {
    clientId: access,
    username: access,
    password: CFG.MQTT_PWD
  });
  m.onConnect = (errCode) => {
    if (errCode) {
      log('MQTT CONNACK rc=' + errCode);
      setCtrlEnabled(false);
      if (store.refresh && !state.mqttReconnecting) {
        state.mqttReconnecting = true;
        log('token may be stale; refreshing & retrying…');
        ensureAccess()
          .then(() => { state.mqttReconnecting = false; connectMqtt(deviceId); })
          .catch((e) => { state.mqttReconnecting = false; log('reconnect failed: ' + e.message); });
      }
      return;
    }
    log('MQTT connected');
    state.mqttOk = true;
    m.subscribe('device/' + deviceId + '/app', 0, () => {
      log('subscribed device/' + deviceId + '/app');
      setCtrlEnabled(true);
    });
  };
  m.onMessage = (topic, payload, raw) => handleAppMessage(topic, payload, raw);
  m.onClose = () => {
    log('MQTT disconnected');
    state.mqttOk = false;
    setCtrlEnabled(false);
  };
  m.onError = (e) => log('MQTT error: ' + (e && e.message ? e.message : e));
}

function setCtrlEnabled(on) {
  const ids = ['btn-sweep', 'btn-edge', 'btn-spot', 'btn-home', 'btn-find'];
  ids.forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  $('btn-stop').disabled = !on;
}

function sendCmd(f, p) {
  const m = state.mqtt;
  if (!m.connected) { ctrlMsg('Not connected (robot offline?)', true); return; }
  const payload = JSON.stringify(p === undefined ? { f } : { f, p });
  m.publish('device/' + state.deviceId + '/robot', strToBytes(payload));
  ctrlMsg('sent f=' + f, false);
  log('cmd: ' + payload);
}

function strToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

let lastPing = 0;
function pingLoop() {
  setInterval(() => {
    const m = state.mqtt;
    if (m.connected && Date.now() - lastPing > 20000) {
      m.ping();
      lastPing = Date.now();
    }
  }, 10000);
}

function handleAppMessage(topic, payload, raw) {
  const text = bytesToStr(payload);
  const env = safeJson(text);
  if (!env || env.f === undefined || !env.p) {
    log('rx: ' + text.slice(0, 120));
    return;
  }
  const f = env.f;
  const p = env.p;
  switch (f) {
    case TYPE.POSE:
      state.pose = { x: num(p.x), y: num(p.y), yaw: num(p.yaw) };
      renderStatus();
      drawAll();
      break;
    case TYPE.CURRENT_ACTION:
      state.action = p;
      renderStatus();
      drawAll();
      break;
    case TYPE.BATTERY_PERCENTAGE:
      state.battery = num(p.progress != null ? p.progress : p);
      renderStatus();
      break;
    case TYPE.BATTERY_IS_CHARGING:
      state.charging = !!(p.is_charging !== undefined ? p.is_charging : p);
      renderStatus();
      break;
    case TYPE.ROBOT_STATUS:
      state.status = null;
      if (typeof p === 'object') {
        state.status = p;
        if (p.state !== undefined) state.status.text = String(p.state);
      }
      renderStatus();
      break;
    case TYPE.EXPLORE_MAP:
    case TYPE.SWEEP_MAP:
    case TYPE.ENTIRE_EXPLORE_MAP:
    case TYPE.ENTIRE_SWEEP_MAP:
      storeMapTile(p);
      drawMap$();
      break;
    default:
      log('rx f=' + f + ' ' + bytesToStr(payload).slice(0, 160));
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function num(v) { return typeof v === 'number' ? v : parseFloat(v) || 0; }
function bytesToStr(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
  }
  return s;
}

/* ================= map ================= */
function storeMapTile(p) {
  if (!p || !p.map_data) { log('map msg without map_data'); return; }
  const tile = MapRLE.decodeMapMessage(p);
  if (!tile) { log('map decode failed'); return; }
  // Absolute geometry (meters): real_x/real_y = origin, res = m/pixel.
  state.maps.push(tile);
  const minX = tile.realX, minY = tile.realY;
  const maxX = tile.realX + tile.dimX * tile.res;
  const maxY = tile.realY + tile.dimY * tile.res;
  if (!state.worldBounds) {
    state.worldBounds = { minX, minY, maxX, maxY };
  } else {
    const b = state.worldBounds;
    b.minX = Math.min(b.minX, minX);
    b.minY = Math.min(b.minY, minY);
    b.maxX = Math.max(b.maxX, maxX);
    b.maxY = Math.max(b.maxY, maxY);
  }
  $('map-status').textContent = 'map ' + tile.dimX + 'x' + tile.dimY + '  ' + (state.maps.length) + (state.maps.length > 1 ? ' tiles' : ' tile');
}

function drawMap$() {
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W === 0 || H === 0) return;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0f1c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const b = state.worldBounds;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0f1c';
  ctx.fillRect(0, 0, W, H);
  if (!b) {
    ctx.fillStyle = '#8a93a8';
    ctx.textAlign = 'center';
    ctx.font = '13px sans-serif';
    ctx.fillText('Waiting for map…', W / 2, H / 2);
    return;
  }

  const scale = Math.min(W / (b.maxX - b.minX), H / (b.maxY - b.minY));
  const ox = (W - (b.maxX - b.minX) * scale) / 2;
  const oy = (H - (b.maxY - b.minY) * scale) / 2;
  const s2 = Math.max(1, scale); // world pixel size

  for (const t of state.maps) {
    const img = ctx.createImageData(t.dimX, t.dimY);
    const g = t.grid;
    for (let i = 0; i < g.length; i++) {
      const v = g[i];
      if (v === 0) continue;
      const idx = i * 4;
      if (v > 127) { img.data[idx] = 42; img.data[idx + 1] = 49; img.data[idx + 2] = 66; }
      else { img.data[idx] = 238; img.data[idx + 1] = 241; img.data[idx + 2] = 246; }
      img.data[idx + 3] = 255;
    }
    const tx = ox + (t.realX - b.minX) * scale;
    const ty = oy + (t.realY - b.minY) * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img._canvas ? putOnCanvas(img) : imgToCanvas(img), tx, ty, t.dimX * t.res * scale, t.dimY * t.res * scale);
  }

  // robot pose / path
  const act = state.action;
  if (act && Array.isArray(act.pt)) {
    ctx.strokeStyle = '#3ea6ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    act.pt.forEach((pt, i) => {
      const x = ox + (num(pt[0]) - b.minX) * scale;
      const y = oy + (num(pt[1]) - b.minY) * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  if (state.pose) {
    const x = ox + (state.pose.x - b.minX) * scale;
    const y = oy + (state.pose.y - b.minY) * scale;
    const r = Math.max(4, 0.09 * scale);
    ctx.fillStyle = '#3ea6ff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(state.pose.yaw) * r * 2, y + Math.sin(state.pose.yaw) * r * 2);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (state.spot) {
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    if (state.spotCur) {
      ctx.strokeRect(state.spotCur.x0, state.spotCur.y0, state.spotCur.x1 - state.spotCur.x0, state.spotCur.y1 - state.spotCur.y0);
    }
    ctx.setLineDash([]);
  }
}

function imgToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
function putOnCanvas(img) {
  if (!img._canvas) img._canvas = imgToCanvas(img);
  return img._canvas;
}

function drawAll() { drawMap$(); }

/* ================= spot region ================= */
function setupSpot() {
  const canvas = $('map');
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.spot) return;
    const r = canvas.getBoundingClientRect();
    state.spotStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    state.spotCur = { x0: state.spotStart.x, y0: state.spotStart.y, x1: state.spotStart.x, y1: state.spotStart.y };
    state.mqttOk && drawAll();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.spot || !state.spotCur) return;
    const r = canvas.getBoundingClientRect();
    state.spotCur.x1 = e.clientX - r.left;
    state.spotCur.y1 = e.clientY - r.top;
    drawAll();
  });
  const endSpot = (e) => {
    if (!state.spot || !state.spotStart) return;
    const r = canvas.getBoundingClientRect();
    const b = state.worldBounds;
    const scale = Math.min(canvas.clientWidth / (b.maxX - b.minX), canvas.clientHeight / (b.maxY - b.minY));
    const ox = (canvas.clientWidth - (b.maxX - b.minX) * scale) / 2;
    const oy = (canvas.clientHeight - (b.maxY - b.minY) * scale) / 2;
    const x0 = state.spotStart.x, y0 = state.spotStart.y;
    const x1 = e.clientX - r.left, y1 = e.clientY - r.top;
    const mX0 = (Math.min(x0, x1) - ox) / scale + b.minX;
    const mY0 = (Math.min(y0, y1) - oy) / scale + b.minY;
    const mX1 = (Math.max(x0, x1) - ox) / scale + b.minX;
    const mY1 = (Math.max(y0, y1) - oy) / scale + b.minY;
    state.spot = false;
    state.spotCur = null;
    state.spotStart = null;
    $('btn-spot').textContent = 'Spot region';
    drawAll();
    if (Math.abs(mX1 - mX0) < 0.05 || Math.abs(mY1 - mY0) < 0.05) {
      ctrlMsg('Region too small (need drag on map)', true);
      return;
    }
    const region = {
      label: 'PWA spot',
      rad: 0.05,
      type: 0, // SWEEP
      points: [
        { x: mX0, y: mY0 }, { x: mX1, y: mY0 },
        { x: mX1, y: mY1 }, { x: mX0, y: mY1 }
      ]
    };
    sendCmd(CMD.START_SWEEP_REGION, [region]);
  };
  canvas.addEventListener('pointerup', endSpot);
  canvas.addEventListener('pointercancel', endSpot);
}

function toggleSpot() {
  state.spot = !state.spot;
  $('btn-spot').textContent = state.spot ? 'Drag on map…' : 'Spot region';
  if (!state.spot) { state.spotCur = null; state.spotStart = null; drawAll(); }
}

/* ================= schedules ================= */
async function refreshSchedules() {
  if (!state.device) return;
  const listEl = $('schedule-list');
  listEl.textContent = '…';
  try {
    await ensureAccess();
    const id = state.deviceId;
    const res = await http('/api/devices/' + id + '/scheduled-tasks', {
      headers: { 'Accept': 'application/vnd.slamtec.scheduledtasklist-v1.0+json' }
    });
    if (!res.ok) { listEl.textContent = 'HTTP ' + res.status; return; }
    const j = JSON.parse(res.body);
    const items = Array.isArray(j) ? j : (j.content || j.scheduled_tasks || j.data || []);
    if (!items.length) { listEl.textContent = 'No scheduled tasks'; return; }
    listEl.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'item';
      const text = document.createElement('span');
      text.textContent = `${it.task || '?'} · ${(it.start_date || '').replace('T', ' ').slice(0, 16)} · repeat=${it.repeat ?? 0}${it.enabled === false ? ' · OFF' : ''}`;
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.onclick = () => deleteSchedule(it.scheduled_task_id);
      row.appendChild(text);
      row.appendChild(del);
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.textContent = err.message;
  }
}

async function deleteSchedule(taskId) {
  const id = state.deviceId;
  const res = await http('/api/devices/' + id + '/scheduled-tasks/' + taskId, { method: 'DELETE' });
  $('sched-msg').textContent = res.ok ? 'deleted' : ('HTTP ' + res.status);
  refreshSchedules();
}

async function addSchedule() {
  const t = $('sched-time').value;
  if (!t) { $('sched-msg').textContent = 'pick a time first'; return; }
  const repeatStr = $('sched-repeat').value;
  const repeat = DAY_BITS[repeatStr];
  const start_date = localStartDate(t);
  const body = {
    task: 'sweep',
    start_date,
    enabled: true,
    repeat,
    max_duration_in_minutes: 360
  };
  const id = state.deviceId;
  const res = await http('/api/devices/' + id + '/scheduled-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.slamtec.scheduledtask-v1.0+json',
               'Accept': 'application/vnd.slamtec.scheduledtask-v1.0+json' },
    body: JSON.stringify(body)
  });
  $('sched-msg').textContent = res.ok ? 'added ' + start_date : ('HTTP ' + res.status + ' ' + res.body.slice(0, 120));
  refreshSchedules();
}

const DAY_BITS = { MONDAY: 2, TUESDAY: 4, WEDNESDAY: 8, THURSDAY: 16, FRIDAY: 32, SATURDAY: 64, SUNDAY: 1 };

function localStartDate(t) {
  const d = new Date();
  const [hh, mm] = t.split(':').map(Number);
  d.setHours(hh, mm, 0, 0);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const offAbs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00.000${sign}${pad(Math.floor(offAbs / 60))}${pad(offAbs % 60)}`;
}

/* ================= controls ================= */
function ctrlMsg(text, isErr) {
  const el = $('ctrl-msg');
  el.textContent = text;
  el.className = 'msg' + (isErr ? ' err' : ' ok');
}

function wireControls() {
  $('btn-sweep').onclick = () => sendCmd(CMD.SWEEP, null);
  $('btn-edge').onclick = () => sendCmd(CMD.START_EDGE_SWEEPING, null);
  $('btn-stop').onclick = () => sendCmd(CMD.STOP, null);
  $('btn-home').onclick = () => sendCmd(CMD.GO_HOME, null);
  $('btn-find').onclick = () => sendCmd(CMD.FIND_ME, null);
  $('btn-spot').onclick = toggleSpot;
  $('btn-add-sched').onclick = addSchedule;
  $('btn-logout').onclick = logout;
  $('sched-time').addEventListener('change', () => $('sched-msg').textContent = '');
}

/* ================= screens ================= */
function show(id) {
  ['screen-login', 'screen-main'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
}

function logout() {
  store.refresh = null;
  store.email = null;
  access = null;
  state.mqtt.disconnect();
  show('screen-login');
}

async function bootstrap() {
  // try silent re-login from stored refresh token
  if (store.refresh) {
    $('login-msg').textContent = 'Restoring session…';
    try {
      await refreshTokens();
      await enterMain();
      return;
    } catch (e) {
      log('session restore failed: ' + e.message);
      store.refresh = null;
    }
  }
  show('screen-login');
  if (store.email) $('login-email').value = store.email;
}

async function enterMain() {
  show('screen-main');
  $('banner').classList.add('hidden');
  setCtrlEnabled(false);
  try {
    await fetchUser();
    const deviceId = await fetchDevices();
    connectMqtt(deviceId);
    pingLoop();
    refreshSchedules();
    if (state.deviceId) ctrlMsg('', false);
  } catch (err) {
    $('dev-sub').textContent = err.message;
    log('init error: ' + err.message);
  }
}

/* ================= init ================= */
function init() {
  wireControls();
  setupSpot();
  $('login-remember').checked = store.remember;

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    const msg = $('login-msg');
    msg.textContent = 'Signing in…';
    msg.className = 'msg';
    $('login-btn').disabled = true;
    try {
      const tok = await oauthPassword(email, password);
      access = tok.access_token;
      accessType = tok.token_type || 'Bearer';
      store.remember = $('login-remember').checked;
      store.refresh = tok.refresh_token || null;
      store.email = email;
      expiresAt = Date.now() + ((tok.expires_in || 1800) - 60) * 1000;
      log('login ok' + (store.remember ? '' : ' (session only)'));
      await enterMain();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add('err');
    } finally {
      $('login-btn').disabled = false;
    }
  });

  window.addEventListener('resize', drawAll);
  bootstrap();
}

init();