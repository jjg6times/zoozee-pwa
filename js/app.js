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
  SWEEP_REGION: 28, SWEEPING_REGION: 29, SWEEP_TIME: 12,
  SWEEP_FAN_MODE: 25, SMART_PRESSURIZATION: 58
};
const CMD = {
  STOP: 24, GO_HOME: 25, SWEEP: 26, SWEEP_SPOT: 27, CLEAR_MAP: 54, FIND_ME: 56,
  START_SWEEP_REGION: 68, START_AUTO_EXPLORING: 108, START_EDGE_SWEEPING: 109,
  UPDATE_VIRTUAL_WALL: 29, GET_SWEEP_FAN_MODE: 58, SET_SWEEP_FAN_MODE: 59,
  GET_SMART_PRESSURIZATION: 83
};
const FAN_MODES = [
  { label: 'Normal', value: 0 },
  { label: 'Silent', value: 1 },
  { label: 'High', value: 2 },
  { label: 'Full', value: 3 },
  { label: 'Inherit', value: 4 }
];
const ACTION_LABELS = {
  IDLE: 'Idle',
  AUTO_EXPLORE: 'Auto-explore', AUTO_EXPLORING: 'Exploring…', AUTO_EXPLORING_PAUSED: 'Exploring (paused)',
  SWEEP: 'Sweeping', SWEEPING: 'Sweeping…', SWEEPING_PAUSED: 'Sweeping (paused)',
  EDGE: 'Edge sweep', EDGE_SWEEP: 'Edge sweep', EDGE_SWEEPING: 'Edge sweeping…', EDGE_SWEEPING_PAUSED: 'Edge (paused)',
  SPOT: 'Spot clean', SPOT_CLEAN: 'Spot cleaning…', SWEEP_SPOT: 'Spot clean',
  SWEEP_SPOT_GUIDE: 'Spot (guide)', SWEEP_SPOT_PAUSED: 'Spot (paused)',
  DRAWING_SWEEP: 'Drawing sweep', DRAWING_SWEEP_PAUSED: 'Drawing (paused)',
  DRAWING_SWEEP_ADD: 'Drawing sweep', DRAWING_SWEEP_PICTURE: 'Drawing sweep',
  SWEEPING_REGION: 'Region sweep…', SWEEP_REGION: 'Region sweep',
  PAUSE: 'Paused', PAUSED: 'Paused',
  RETURN: 'Returning home', RETURNING: 'Returning home', CHARGING: 'Charging', CHARGING_PAUSED: 'Charging (paused)'
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
  mapCache: new Map(), // tileKey -> {tile, canvas, dirty}
  worldBounds: null,   // {minX,minY,maxX,maxY} in meters
  deviceId: null,
  pose: null,          // {x,y,yaw}
  action: null,        // {an,st,pt,ms}
  battery: null,
  charging: null,
  status: null,
  spot: false,
  spotStart: null,
  spotCur: null,
  walls: [],           // [{id,x0,y0,x1,y1}] in meters (virtual walls)
  wallMode: false,
  wallDirty: false,
  dock: null,          // {x,y,yaw} dock/charging pose
  fanMode: null,
  carpetBoost: null,   // smart pressurization (auto boost on carpet)
  area: null,          // cleaned area m2
  sweepTime: null,     // seconds
  view: { scale: 0, ox: 0, oy: 0, fit: true }, // px-per-meter + origin offset (CSS px)
  retry: { timer: null, delay: 2000 },
  logCount: 0
};

let refreshPromise = null;
function refreshTokens() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function doRefresh() {
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
  let actionTxt = '';
  if (act && act.an) {
    actionTxt = (ACTION_LABELS[act.an] || act.an) + (act.st !== undefined && act.st !== null ? ' (' + act.st + ')' : '');
    if (statusTxt) actionTxt += ' · ' + statusTxt;
  } else if (statusTxt) {
    actionTxt = statusTxt;
  } else {
    actionTxt = 'Idle';
  }
  if (state.area != null && state.sweepTime != null) {
    const mm = Math.floor(state.sweepTime / 60);
    const ss = Math.floor(state.sweepTime % 60);
    actionTxt += ` · ${state.area.toFixed(1)} m² · ${mm}:${String(ss).padStart(2, '0')}`;
  }
  $('action-line').textContent = actionTxt;
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
      scheduleReconnect('token may be stale', true);
      return;
    }
    state.mqttReconnecting = false;
    state.retry.delay = 2000;
    log('MQTT connected');
    state.mqttOk = true;
    m.subscribe('device/' + deviceId + '/app', 0, () => {
      log('subscribed device/' + deviceId + '/app');
      setCtrlEnabled(true);
      requestFanMode();
      requestSmartPress();
    });
  };
  m.onMessage = (topic, payload, raw) => handleAppMessage(topic, payload, raw);
  m.onClose = () => {
    log('MQTT disconnected');
    state.mqttOk = false;
    setCtrlEnabled(false);
    if (state.device && state.device.online) scheduleReconnect('connection dropped', false);
  };
  m.onError = (e) => log('MQTT error: ' + (e && e.message ? e.message : e));
}

function scheduleReconnect(reason, useRefresh) {
  if (state.mqttReconnecting) return;
  if (!store.refresh) return;
  if (!state.device || !state.device.online) { log('no reconnect: device offline'); return; }
  state.mqttReconnecting = true;
  const delay = state.retry.delay;
  clearTimeout(state.retry.timer);
  log((useRefresh ? 'refreshing token & ' : '') + 'reconnecting in ' + (delay / 1000) + 's…');
  state.retry.timer = setTimeout(() => {
    ensureAccess()
      .then(() => { state.mqttReconnecting = false; connectMqtt(state.deviceId); })
      .catch((e) => { state.mqttReconnecting = false; state.retry.delay = Math.min(state.retry.delay * 2, 30000); log('reconnect failed: ' + e.message); scheduleReconnect('retry', false); });
  }, delay);
  state.retry.delay = Math.min(state.retry.delay * 2, 30000);
}

function setCtrlEnabled(on) {
  const ids = ['btn-sweep', 'btn-edge', 'btn-spot', 'btn-home', 'btn-find', 'btn-wall', 'btn-wall-save'];
  ids.forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  $('btn-stop').disabled = !on;
  $('fan-mode').disabled = !on;
  $('carpet-boost').disabled = !on;
  if (!on && state.wallMode) {
    state.wallMode = false;
    state.wallDraft = null;
    const btn = $('btn-wall');
    if (btn) { btn.textContent = '＋ Wall'; btn.classList.remove('active'); }
    drawMap$();
  }
}

function sendCmd(f, p) {
  const m = state.mqtt;
  if (!m.connected) { ctrlMsg('Not connected (robot offline?)', true); return; }
  const payload = JSON.stringify(p === undefined || p === null ? { f } : { f, p });
  m.publish('device/' + state.deviceId + '/robot', strToBytes(payload));
  ctrlMsg('sent f=' + f, false);
  log('cmd: ' + payload);
}

function requestFanMode() {
  sendCmd(CMD.GET_SWEEP_FAN_MODE);
}

function sendFanMode(value) {
  sendCmd(CMD.SET_SWEEP_FAN_MODE, value);
}

function requestSmartPress() {
  sendCmd(CMD.GET_SMART_PRESSURIZATION, { messageId: '' });
}
function toggleCarpetBoost(value) {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  sendCmd(CMD.GET_SMART_PRESSURIZATION, { messageId: id, value });
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
  if (!env || env.f === undefined) {
    log('rx: ' + text.slice(0, 120));
    return;
  }
  const f = env.f;
  const p = env.p;
  switch (f) {
    case TYPE.POSE:
      state.pose = { x: num(p.x), y: num(p.y), yaw: num(p.yaw) };
      renderStatus();
      drawMap$();
      break;
    case TYPE.CURRENT_ACTION:
      state.action = p;
      renderStatus();
      drawMap$();
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
    case TYPE.VIRTUAL_WALLS:
      if (!state.wallDirty) {
        state.walls = parseWalls(p);
        setWallBank();
        drawMap$();
      }
      break;
    case TYPE.DOCK_POSE:
      if (p && typeof p === 'object') {
        state.dock = { x: num(p.x), y: num(p.y), yaw: num(p.yaw) };
        drawMap$();
      }
      break;
    case TYPE.SWEEP_TIME:
      state.sweepTime = num(p);
      renderStatus();
      break;
    case TYPE.SWEEP_AREA:
      state.area = num(p);
      renderStatus();
      break;
    case TYPE.SWEEP_FAN_MODE:
      state.fanMode = num(p);
      const sel = $('fan-mode');
      if (sel && sel.value === '') sel.value = String(state.fanMode);
      break;
    case TYPE.SMART_PRESSURIZATION:
      if (p && typeof p === 'object' && p.value !== undefined) {
        state.carpetBoost = !!p.value;
        const cb = $('carpet-boost');
        if (cb) cb.checked = state.carpetBoost;
      }
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

function parseWalls(p) {
  const out = [];
  if (!Array.isArray(p)) return out;
  p.forEach((line, idx) => {
    if (!Array.isArray(line) || line.length !== 2) return;
    const s = line[0], e = line[1];
    if (!Array.isArray(s) || !Array.isArray(e)) return;
    out.push({ id: idx, x0: num(s[0]), y0: num(s[1]), x1: num(e[0]), y1: num(e[1]) });
  });
  return out;
}

function wallsPayload() {
  return state.walls.map(w => [[w.x0, w.y0], [w.x1, w.y1]]);
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
function tileKey(t) { return t.realX + ',' + t.realY + ',' + t.res + ',' + t.dimX + 'x' + t.dimY; }

function storeMapTile(p) {
  if (!p || !p.map_data) { log('map msg without map_data'); return; }
  const tile = MapRLE.decodeMapMessage(p);
  if (!tile) { log('map decode failed'); return; }
  // Dedupe: the robot retransmits tiles often; keep one entry per tile origin.
  const key = tileKey(tile);
  const entry = state.mapCache.get(key);
  if (entry) {
    entry.tile = tile;
    tileToCanvas(entry);
  } else {
    state.maps.push(tile);
    const e = { tile, canvas: null };
    tileToCanvas(e);
    state.mapCache.set(key, e);
  }
  const minX = tile.realX, minY = tile.realY;
  const maxX = tile.realX + tile.dimX * tile.res;
  const maxY = tile.realY + tile.dimY * tile.res;
  if (!state.worldBounds) {
    state.worldBounds = { minX, minY, maxX, maxY };
  } else {
    const bl = state.worldBounds;
    bl.minX = Math.min(bl.minX, minX);
    bl.minY = Math.min(bl.minY, minY);
    bl.maxX = Math.max(bl.maxX, maxX);
    bl.maxY = Math.max(bl.maxY, maxY);
  }
  if (state.view.fit) fitView();
  $('map-status').textContent = 'map ' + tile.dimX + 'x' + tile.dimY + '  ' + state.mapCache.size + (state.mapCache.size > 1 ? ' tiles' : ' tile');
}

function tileToCanvas(entry) {
  const t = entry.tile;
  const c = document.createElement('canvas');
  c.width = t.dimX; c.height = t.dimY;
  const cx = c.getContext('2d');
  const img = cx.createImageData(t.dimX, t.dimY);
  const g = t.grid;
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (v === 0) continue;
    const idx = i * 4;
    if (v > 127) { img.data[idx] = 42; img.data[idx + 1] = 49; img.data[idx + 2] = 66; }
    else { img.data[idx] = 238; img.data[idx + 1] = 241; img.data[idx + 2] = 246; }
    img.data[idx + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  entry.canvas = c;
}

/* -------- pan / zoom view -------- */
function fitView() {
  const b = state.worldBounds, canvas = $('map');
  if (!b || !canvas) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W === 0 || H === 0) return;
  const bw = Math.max(0.01, b.maxX - b.minX);
  const bh = Math.max(0.01, b.maxY - b.minY);
  state.view.scale = Math.min(W / bw, H / bh);
  state.view.ox = (W - bw * state.view.scale) / 2;
  state.view.oy = (H - bh * state.view.scale) / 2;
}

function baseFitScale() {
  const b = state.worldBounds, canvas = $('map');
  if (!b || !canvas) return 1;
  return Math.min(canvas.clientWidth / Math.max(0.01, b.maxX - b.minX), canvas.clientHeight / Math.max(0.01, b.maxY - b.minY));
}

function zoomAt(f, cx, cy) {
  if (!state.worldBounds) return;
  const base = baseFitScale();
  const v = state.view;
  const ns = Math.min(Math.max(v.scale * f, base * 0.25), base * 16);
  const ratio = ns / v.scale;
  v.scale = ns;
  v.ox = cx - (cx - v.ox) * ratio;
  v.oy = cy - (cy - v.oy) * ratio;
  v.fit = false;
  drawMap$();
}
function zoomIn() { const c = $('map'); if (c) zoomAt(1.5, c.clientWidth / 2, c.clientHeight / 2); }
function zoomOut() { const c = $('map'); if (c) zoomAt(1 / 1.5, c.clientWidth / 2, c.clientHeight / 2); }
function resetView() { state.view.fit = true; fitView(); drawMap$(); }

function worldToScreen(x, y) {
  const b = state.worldBounds, v = state.view;
  return { x: (x - b.minX) * v.scale + v.ox, y: (y - b.minY) * v.scale + v.oy };
}
function screenToWorld(px, py) {
  const b = state.worldBounds, v = state.view;
  if (!b || v.scale <= 0) return null;
  return { x: (px - v.ox) / v.scale + b.minX, y: (py - v.oy) / v.scale + b.minY };
}

function drawMap$() {
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W === 0 || H === 0) return;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0f1c';
  ctx.fillRect(0, 0, W, H);
  const b = state.worldBounds;
  if (!b || !state.view.scale) {
    ctx.fillStyle = '#8a93a8';
    ctx.textAlign = 'center';
    ctx.font = '13px sans-serif';
    ctx.fillText('Waiting for map…', W / 2, H / 2);
    return;
  }
  const v = state.view;
  ctx.imageSmoothingEnabled = true;
  for (const entry of state.mapCache.values()) {
    const t = entry.tile;
    const tx = v.ox + (t.realX - b.minX) * v.scale;
    const ty = v.oy + (t.realY - b.minY) * v.scale;
    ctx.drawImage(entry.canvas, tx, ty, t.dimX * t.res * v.scale, t.dimY * t.res * v.scale);
  }

  // sweep path
  const act = state.action;
  if (act && Array.isArray(act.pt)) {
    ctx.strokeStyle = 'rgba(62,166,255,.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    act.pt.forEach((pt, i) => {
      const sx = v.ox + (num(pt[0]) - b.minX) * v.scale;
      const sy = v.oy + (num(pt[1]) - b.minY) * v.scale;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  }

  // dock / charging station
  if (state.dock) {
    const d = worldToScreen(state.dock.x, state.dock.y);
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(state.dock.yaw || 0);
    ctx.fillStyle = '#7de0a3';
    ctx.fillRect(-0.10 * v.scale, -0.07 * v.scale, 0.20 * v.scale, 0.14 * v.scale);
    ctx.restore();
  }

  // robot pose
  if (state.pose) {
    const p = worldToScreen(state.pose.x, state.pose.y);
    const r = Math.max(4, 0.09 * v.scale);
    ctx.fillStyle = '#3ea6ff';
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(state.pose.yaw) * r * 2, p.y + Math.sin(state.pose.yaw) * r * 2);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  // virtual walls
  drawWalls(ctx, v, b, state.wallDraft || null);

  // spot region selection
  if (state.spot && state.spotCur) {
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(state.spotCur.x0, state.spotCur.y0, state.spotCur.x1 - state.spotCur.x0, state.spotCur.y1 - state.spotCur.y0);
    ctx.setLineDash([]);
  }
}

function drawWalls(ctx, v, b, draft) {
  const walls = state.walls.slice();
  if (draft && draft.x1 !== undefined) walls.push(draft);
  ctx.lineCap = 'round';
  for (const w of walls) {
    const s = { x: v.ox + (w.x0 - b.minX) * v.scale, y: v.oy + (w.y0 - b.minY) * v.scale };
    const e = { x: v.ox + (w.x1 - b.minX) * v.scale, y: v.oy + (w.y1 - b.minY) * v.scale };
    ctx.strokeStyle = w.draft ? 'rgba(255,71,87,.6)' : '#ff4757';
    ctx.lineWidth = Math.max(2, 0.035 * v.scale);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    const dx = e.x - s.x, dy = e.y - s.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;
    const nx = -dy / len, ny = dx / len;
    const perp = Math.max(3, 0.10 * v.scale);
    const ticks = Math.max(1, Math.floor(len / Math.max(8, 0.18 * v.scale)));
    ctx.strokeStyle = w.draft ? 'rgba(255,143,163,.7)' : '#ff8fa3';
    ctx.lineWidth = 1.5;
    for (let i = 1; i <= ticks; i++) {
      const t = i / (ticks + 1);
      const cx = s.x + dx * t, cy = s.y + dy * t;
      ctx.beginPath();
      ctx.moveTo(cx - nx * perp * 0.5, cy - ny * perp * 0.5);
      ctx.lineTo(cx + nx * perp * 0.5, cy + ny * perp * 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#ff8fa3';
    for (const pt of [s, e]) { ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(3, 0.03 * v.scale), 0, Math.PI * 2); ctx.fill(); }
  }
}

function drawAll() { drawMap$(); }

/* ================= virtual walls ================= */
function setWallBank() {
  const el = $('wall-status');
  if (!el) return;
  el.textContent = (state.wallDirty ? '● unsaved · ' : '') + state.walls.length + ' wall' + (state.walls.length === 1 ? '' : 's') + (state.wallMode ? ' — drag to add, tap a wall to delete' : '');
  const save = $('btn-wall-save');
  const clear = $('btn-wall-clear');
  if (save) save.disabled = !state.wallDirty;
  if (clear) clear.disabled = !state.walls.length && !state.wallDirty;
}

function toggleWallMode() {
  if (!state.mqttOk) { ctrlMsg('Connect first', true); return; }
  state.wallMode = !state.wallMode;
  if (state.wallMode) { state.spot = false; $('btn-spot').textContent = 'Spot region'; state.spotCur = null; }
  const btn = $('btn-wall');
  btn.textContent = state.wallMode ? 'Cancel' : '＋ Wall';
  btn.classList.toggle('active', state.wallMode);
  state.wallDraft = null;
  setWallBank();
  drawMap$();
}

function finishWallDraft() {
  const d = state.wallDraft;
  if (!d || d.x1 === undefined) return;
  if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 0.05) {
    ctrlMsg('Wall too short (drag a line)', true);
    return;
  }
  const id = state.walls.reduce((m, w) => Math.max(m, w.id), -1) + 1;
  state.walls.push({ id, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
  state.wallDirty = true;
  ctrlMsg('wall added — tap Save to send', false);
  setWallBank();
  drawMap$();
}

function saveWalls() {
  if (!state.mqttOk) { ctrlMsg('Not connected', true); return; }
  sendCmd(CMD.UPDATE_VIRTUAL_WALL, wallsPayload());
  state.wallDirty = false;
  setWallBank();
}

function clearWalls() {
  state.walls = [];
  state.wallDirty = true;
  setWallBank();
  drawMap$();
  ctrlMsg('walls cleared — tap Save to send', false);
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/* ================= canvas interactions (spot, walls, pan, zoom) ================= */
function setupMap() {
  const canvas = $('map');
  const ptrs = new Map();
  let down = null;
  let pinchD = null;

  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const nearestWall = (p) => {
    let best = null, bestD = 10;
    for (const w of state.walls) {
      const s = worldToScreen(w.x0, w.y0);
      const e = worldToScreen(w.x1, w.y1);
      const d = distToSegment(p, s, e);
      if (d < bestD) { bestD = d; best = w; }
    }
    return best;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    ptrs.set(e.pointerId, p);
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ } }
    if (ptrs.size === 1) {
      down = { x: p.x, y: p.y, moved: false };
      if (state.spot) state.spotCur = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      if (state.wallMode) {
        const w = screenToWorld(p.x, p.y);
        if (w) state.wallDraft = { draft: true, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
      }
      drawMap$();
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      down = null;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = pos(e);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const ratio = d / (pinchD || d);
      pinchD = d;
      zoomAt(ratio, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (!down) return;
    const dx = p.x - down.x, dy = p.y - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 6) down.moved = true;
    if (state.spot) {
      state.spotCur = { x0: down.x, y0: down.y, x1: p.x, y1: p.y };
      drawMap$();
    } else if (state.wallMode) {
      const w = screenToWorld(p.x, p.y);
      if (w && state.wallDraft) { state.wallDraft.x1 = w.x; state.wallDraft.y1 = w.y; }
      drawMap$();
    } else if (down.moved) {
      state.view.ox += dx; state.view.oy += dy;
      state.view.fit = false;
      down.x = p.x; down.y = p.y;
      drawMap$();
    }
  });

  const finishPointer = (e) => {
    const p = pos(e);
    ptrs.delete(e.pointerId);
    if (ptrs.size > 0) return;
    pinchD = null;
    if (!down) { drawMap$(); return; }
    if (!down.moved) {
      // tap
      if (state.wallMode && state.worldBounds) {
        const hit = nearestWall(p);
        if (hit) {
          state.walls = state.walls.filter(w => w.id !== hit.id);
          state.wallDirty = true;
          setWallBank();
          ctrlMsg('wall removed — tap Save to send', false);
          drawMap$();
        }
      } else if (state.spot) {
        // tap with no drag = nothing to send
      }
    } else if (state.wallMode) {
      finishWallDraft();
    } else if (state.spot && state.worldBounds) {
      endSpotRegion(p);
    }
    down = null;
    state.wallDraft = null;
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('lostpointercapture', finishPointer);

  canvas.addEventListener('dblclick', (e) => {
    const p = pos(e);
    zoomAt(2, p.x, p.y);
  });
}

function endSpotRegion(p) {
  const b = state.worldBounds;
  const x0 = state.spotCur ? state.spotCur.x0 : p.x;
  const y0 = state.spotCur ? state.spotCur.y0 : p.y;
  const a = screenToWorld(Math.min(x0, p.x), Math.min(y0, p.y));
  const c = screenToWorld(Math.max(x0, p.x), Math.max(y0, p.y));
  state.spot = false;
  state.spotCur = null;
  $('btn-spot').textContent = 'Spot region';
  drawMap$();
  if (!a || !c) { ctrlMsg('No map yet', true); return; }
  const w = c.x - a.x, h = c.y - a.y;
  if (w < 0.05 || h < 0.05) { ctrlMsg('Region too small (need drag on map)', true); return; }
  const region = {
    label: 'PWA spot',
    rad: 0.05,
    type: 0, // SWEEP
    points: [
      { x: a.x, y: a.y }, { x: c.x, y: a.y },
      { x: c.x, y: c.y }, { x: a.x, y: c.y }
    ]
  };
  sendCmd(CMD.START_SWEEP_REGION, [region]);
}

function toggleSpot() {
  if (state.wallMode) toggleWallMode();
  state.spot = !state.spot;
  $('btn-spot').textContent = state.spot ? 'Drag on map…' : 'Spot region';
  if (!state.spot) { state.spotCur = null; state.spotStart = null; }
  drawMap$();
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
  $('btn-sweep').onclick = () => sendCmd(CMD.SWEEP);
  $('btn-edge').onclick = () => sendCmd(CMD.START_EDGE_SWEEPING);
  $('btn-stop').onclick = () => sendCmd(CMD.STOP);
  $('btn-home').onclick = () => sendCmd(CMD.GO_HOME);
  $('btn-find').onclick = () => sendCmd(CMD.FIND_ME);
  $('btn-spot').onclick = toggleSpot;
  $('btn-all-clear').onclick = () => {
    if (window.confirm('Reset (clear) the robot mapping? This wipes the saved floor plan and starts a new map.')) {
      sendCmd(CMD.CLEAR_MAP);
    }
  };
  $('btn-wall').onclick = toggleWallMode;
  $('btn-wall-save').onclick = saveWalls;
  $('btn-wall-clear').onclick = clearWalls;
  $('btn-zoom-in').onclick = zoomIn;
  $('btn-zoom-out').onclick = zoomOut;
  $('btn-zoom-fit').onclick = resetView;
  $('btn-add-sched').onclick = addSchedule;
  $('btn-logout').onclick = logout;
  $('sched-time').addEventListener('change', () => $('sched-msg').textContent = '');
  $('carpet-boost').addEventListener('change', (e) => toggleCarpetBoost(!!e.target.checked));
  const fan = $('fan-mode');
  fan.addEventListener('change', () => {
    if (fan.value !== '') sendFanMode(parseInt(fan.value, 10));
  });
}

/* ================= screens ================= */
function show(id) {
  ['screen-login', 'screen-main'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
}

function clearState() {
  state.maps = [];
  state.mapCache = new Map();
  state.worldBounds = null;
  state.pose = null;
  state.action = null;
  state.battery = null;
  state.charging = null;
  state.status = null;
  state.dock = null;
  state.area = null;
  state.sweepTime = null;
  state.fanMode = null;
  state.carpetBoost = null;
  const cbEl = $('carpet-boost');
  if (cbEl) cbEl.checked = false;
  state.walls = [];
  state.wallDirty = false;
  state.wallMode = false;
  state.spot = false;
  state.spotCur = null;
  state.view = { scale: 0, ox: 0, oy: 0, fit: true };
}

function logout() {
  state.mqtt.disconnect();
  state.mqttOk = false;
  clearTimeout(state.retry.timer);
  store.refresh = null;
  store.email = null;
  access = null;
  clearState();
  const fan = $('fan-mode');
  if (fan) fan.innerHTML = '<option value="" disabled>—</option>';
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
  const msg = $('login-msg');
  msg.textContent = '';
  msg.className = 'msg';
  show('screen-login');
  if (store.email) $('login-email').value = store.email;
}

async function enterMain() {
  show('screen-main');
  $('banner').classList.add('hidden');
  populateFanOptions();
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
function populateFanOptions() {
  const fan = $('fan-mode');
  fan.innerHTML = '<option value="" disabled selected>fan mode</option>';
  FAN_MODES.forEach(fm => {
    const o = document.createElement('option');
    o.value = String(fm.value); o.textContent = fm.label;
    fan.appendChild(o);
  });
  if (state.fanMode != null) fan.value = String(state.fanMode);
}

function init() {
  wireControls();
  setupMap();
  setWallBank();
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

  window.addEventListener('resize', () => { if (state.view.fit) fitView(); drawMap$(); });
  bootstrap();
}

init();