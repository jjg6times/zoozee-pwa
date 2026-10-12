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
const APP_VER = 'v36';
const TYPE = {
  POSE: 1, CURRENT_ACTION: 2, BATTERY_PERCENTAGE: 3, BATTERY_IS_CHARGING: 4,
  EXPLORE_MAP: 7, SWEEP_MAP: 8, VIRTUAL_WALLS: 9, HELLO: 16,
  ENTIRE_EXPLORE_MAP: 17, ENTIRE_SWEEP_MAP: 18, ROBOTTRACK: 19,
  SWEEP_AREA: 20, DOCK_POSE: 21, ROBOT_STATUS: 22,
  SWEEP_REGION: 28, SWEEPING_REGION: 29, SWEEP_TIME: 12,
  SWEEP_FAN_MODE: 25, SMART_PRESSURIZATION: 58, NETWORK_INFO: 24
};
const CMD = {
  STOP: 24, GO_HOME: 25, SWEEP: 26, SWEEP_SPOT: 27, CLEAR_MAP: 54, FIND_ME: 56,
  START_SWEEP_REGION: 68, START_AUTO_EXPLORING: 108, START_EDGE_SWEEPING: 109,
  UPDATE_VIRTUAL_WALL: 29, GET_SWEEP_FAN_MODE: 58, SET_SWEEP_FAN_MODE: 59,
  GET_SMART_PRESSURIZATION: 83, NETWORK_INFO: 57, ENTIRE_MAP: 42,
  GET_SWEEP_REGION: 64, CREATE_SWEEP_REGION: 65, DELETE_SWEEP_REGION: 66,
  UPDATE_SWEEP_REGION: 67
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
/* The Z70 firmware sends NUMERIC codes (verified live, 2026):
   CURRENT_ACTION.an -> 0 exploring/edge, 3 go-home, 4 sweep, 5 spot
   ROBOT_STATUS.p    -> 0 idle, 5 returning, 6 sweeping, 11 spot, 20 mapping, 22 edge */
const ACTION_NUM = {
  0: 'Exploring', 1: 'Returning home', 3: 'Returning home',
  4: 'Sweeping', 5: 'Spot cleaning', 6: 'Edge sweeping'
};
const STATUS_LABELS = {
  0: 'Idle', 1: 'Idle', 2: 'Charging', 3: 'Charging', 4: 'Charge complete',
  5: 'Returning to dock', 6: 'Sweeping', 7: 'Paused', 8: 'Paused', 9: 'Docking',
  10: 'Charging', 11: 'Spot cleaning', 12: 'Spot cleaning', 13: 'Recharging',
  20: 'Mapping', 21: 'Docked', 22: 'Edge sweeping'
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

function loadLastWifi() {
  try { return JSON.parse(localStorage.getItem('jarvis.wifi') || 'null'); } catch (e) { return null; }
}
function saveLastWifi(w) {
  try { localStorage.setItem('jarvis.wifi', JSON.stringify(w)); } catch (e) { /* noop */ }
}

const state = {
  user: null,
  devices: [],
  device: null,
  mqtt: new MqttClient(),
  mqttOk: false,
  mqttReconnecting: false,
  mqttConnecting: false,
  maps: [],            // received map tiles: {grid, dimX, dimY, res, realX, realY}
  mapKind: null,       // 'live' (explore/sweep, while mapping) | 'entire' (17/18) | 'saved'
  mapSource: 'live',   // 'live' (robot) | 'saved' (viewing a stored/cloud map)
  mapLabel: '',        // name of the map currently being viewed
  savedDock: null,     // dock pose stored with a viewed saved/cloud map
  savedMaps: [],       // locally saved snapshots: {id,name,savedAt,kind,tiles[]}
  cloudMaps: [],       // map list fetched from the cloud
  hasEntireMap: false, // true once an ENTIRE (17/18) map has been rendered
  mapCache: new Map(), // tileKey -> {tile, canvas, dirty}
  worldBounds: null,   // {minX,minY,maxX,maxY} in meters
  deviceId: null,
  pose: null,          // {x,y,yaw}
  poseTs: 0,           // when the last POSE message arrived (ms)
  trail: [],           // robot path history [{x,y}] in meters
  _mapVer: 0,          // bumped when a map tile is stored/replaced (static layer cache)
  _lastMapMsg: 0,      // when the last map message arrived (ms) — drives stale-map refresh
  _lastEntireReq: 0,   // when we last asked the robot for the full map (ms)
  headingFlip: false,  // true once the heading arrow is calibrated to need its Y flipped
  _headScore1: 0,      // calibration scores for the two heading conventions
  _headScore2: 0,
  _headN: 0,
  _headDone: false,
  history: [],         // cleaning history [{ts,type,durSec,areaM2,sweepSec}]
  run: null,           // currently-observed cleaning run
  action: null,        // {an,st,pt,ms}
  battery: null,
  charging: null,
  status: null,
  statusText: '',
  spot: false,
  spotStart: null,
  spotCur: null,
  walls: [],           // [{id,x0,y0,x1,y1}] in meters (virtual walls)
  wallMode: false,
  wallDirty: false,
  _wallVer: 0,         // bumped on wall changes (invalidates the static map layer)
  noGo: [],            // [{id,x0,y0,x1,y1}] no-go (forbidden) rectangles in meters
  noGoMode: false,
  noGoDirty: false,
  noGoDraft: null,
  _nogoVer: 0,         // bumped on no-go zone changes (invalidates static map layer)
  dock: null,          // {x,y,yaw} dock/charging pose
  wifi: null,          // live network info {ssid, ip, mac}
  wifiTs: 0,
  lastContact: 0,      // last time any robot message was received (ms)
  reachable: false,    // robot answered an MQTT probe or sent traffic recently
  ctrlEnabled: false,
  fanMode: null,
  carpetBoost: null,   // smart pressurization (auto boost on carpet)
  area: null,          // cleaned area m2
  sweepTime: null,     // seconds
  view: { scale: 0, ox: 0, oy: 0, fit: true }, // px-per-meter + origin offset (CSS px)
  retry: { timer: null, delay: 2000, burst: 0 },
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
  $('account-line').textContent = 'account: ' + store.email + ' · build ' + APP_VER + ' · ' + (typeof MapRLE !== 'undefined' && MapRLE.VER ? MapRLE.VER : 'rle-OLD');
  log('user: ' + JSON.stringify(j).slice(0, 160));
}

function devOnline(x) {
  return !!(x && (x.online === true || x.online === 1 || x.online === '1' ||
    x.online === 'true' || x.is_online === true || x.device_status === 'online'));
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
  const picked = devs.find(devOnline) || devs[0] || null;
  state.device = picked;
  if (picked) {
    const d = picked;
    state.deviceId = d.device_id || d.id || d.sn;
    const id = state.deviceId;
    const nOnline = devs.filter(devOnline).length;
    $('dev-name').textContent = d.name || 'Jarvis';
    $('dev-sub').textContent = (d.model || '') + ' · ' + String(id || '').slice(0, 8) +
      ' · ' + (devs.length || 1) + ' dev, ' + nOnline + ' online';
    log('raw one: ' + JSON.stringify(d).slice(0, 600));
    log('devices: ' + JSON.stringify(devs.slice(0, 8).map(x => ({
      id: String(x.device_id || x.id || x.sn || '').slice(0, 8),
      on: devOnline(x),
      raw: !!x.online,
      seen: x.sl_last_seen || x.last_seen || null
    }))) + (devs.length > 8 ? ' …(+' + (devs.length - 8) + ')' : ''));
    log('picked: ' + String(id || '').slice(0, 8) + (devOnline(d) ? ' (cloud-listed online)' : ' (cloud has no online flag)'));
    updateBadgeState(null);
    return id;
  }
  throw new Error('No robot found on this account');
}

/* ================= status UI ================= */
function updateBadgeState(online) {
  const pill = $('pill-online');
  const banner = $('banner');
  if (!pill || !banner) return;
  if (online) {
    pill.textContent = 'Online';
    pill.className = 'pill on';
    banner.classList.add('hidden');
  } else if (online === null) {
    pill.textContent = 'Contacting…';
    pill.className = 'pill';
    banner.textContent = 'Cloud link OK — asking the robot to reply…';
    banner.classList.remove('hidden');
  } else {
    pill.textContent = 'Offline';
    pill.className = 'pill off';
    const last = state.lastContact ? ' Last live: ' + ago(state.lastContact) + ' ago.' : '';
    const txt = 'Robot is offline' + last + ' Power it on, make sure its 2.4 GHz WiFi is working, then press "Check robot now".';
    if (banner.textContent !== txt) banner.textContent = txt;
    banner.classList.remove('hidden');
  }
}

let reachTimer = null;
let reachWaitResolve = null;

function clearReachTimer() {
  if (reachTimer) { clearTimeout(reachTimer); reachTimer = null; }
}

function armReachProbe(ms) {
  clearReachTimer();
  reachTimer = setTimeout(() => {
    reachTimer = null;
    if (state.reachable) return;
    log('no reply in ' + Math.round(ms / 1000) + 's — robot did not answer');
    setCtrlEnabled(false);
    state.ctrlEnabled = false;
    updateBadgeState(false);
  }, ms);
}

function waitReach(ms) {
  clearReachTimer();
  return new Promise((resolve) => {
    const to = setTimeout(() => { reachWaitResolve = null; resolve(state.reachable); }, ms);
    reachWaitResolve = (ok) => { clearTimeout(to); reachWaitResolve = null; resolve(ok); };
  });
}

function sendProbes() {
  if (!state.mqtt.connected) return;
  requestFanMode();
  requestSmartPress();
  requestNetworkInfo();
  requestEntireMap();
}

function handleReach() {
  state.lastContact = Date.now();
  clearReachTimer();
  if (state.reachable) return; // already online — avoid per-message DOM writes
  log('robot is reachable (replied)');
  state.reachable = true;
  state.ctrlEnabled = true;
  if (reachWaitResolve) reachWaitResolve(true);
  setCtrlEnabled(true);
  updateBadgeState(true);
  renderPose();
}

/* Coalesce status repaints to one per animation frame — POSE/ACTION messages
   can arrive at ~10 Hz and each one used to trigger a full DOM update. */
let _statusRaf = 0;
function renderStatus() {
  if (_statusRaf) return;
  _statusRaf = requestAnimationFrame(() => { _statusRaf = 0; renderStatusNow(); });
}

function renderStatusNow() {
  trackRun();
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
  let actionTxt = '';
  if (state.statusText) {
    actionTxt = state.statusText;
  } else if (act && act.an !== undefined && act.an !== null) {
    const name = ACTION_NUM[act.an] || ACTION_LABELS[act.an] || ('Action ' + act.an);
    actionTxt = name + (act.st !== undefined && act.st !== null ? ' (' + act.st + ')' : '');
  } else {
    actionTxt = 'Idle';
  }
  if (state.area != null && state.sweepTime != null) {
    const mm = Math.floor(state.sweepTime / 60);
    const ss = Math.floor(state.sweepTime % 60);
    actionTxt += ` · ${state.area.toFixed(1)} m² · ${mm}:${String(ss).padStart(2, '0')}`;
  }
  $('action-line').textContent = actionTxt;
  renderPose();
}

/* Live pose readout: x, y, heading, and whether the fix is fresh (so you can
   tell at a glance if the robot has lost localization — a stale/frozen pose). */
function renderPose() {
  const el = $('pos-line');
  if (!el) return;
  const p = state.pose;
  if (!p) { el.textContent = 'pose: waiting for robot…'; el.className = 'status-line muted'; return; }
  const ageS = state.poseTs ? (Date.now() - state.poseTs) / 1000 : Infinity;
  const deg = ((p.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const live = ageS < 5 ? 'live' : (isFinite(ageS) ? 'stale ' + Math.floor(ageS) + 's' : 'stale');
  el.textContent = `x ${p.x.toFixed(2)} m  ·  y ${p.y.toFixed(2)} m  ·  yaw ${deg.toFixed(0)}°  ·  ${live}`;
  el.className = 'status-line' + (ageS < 5 ? '' : ' muted');
}

/* ================= MQTT ================= */
let mqttConnTimer = null;
let lastConnectTs = 0;
function connectMqtt(deviceId) {
  const m = state.mqtt;
  state.mqttConnecting = true;
  clearTimeout(mqttConnTimer);
  mqttConnTimer = setTimeout(() => {
    state.mqttConnecting = false;
    if (!m.connected && state.device) {
      log('mqtt connect timed out');
      scheduleReconnect('connect timed out', false);
    }
  }, 15000);
  m.connect(CFG.WS, {
    clientId: access,
    username: access,
    password: CFG.MQTT_PWD
  });
  m.onConnect = (errCode) => {
    state.mqttConnecting = false;
    clearTimeout(mqttConnTimer);
    if (errCode) {
      log('MQTT CONNACK rc=' + errCode);
      setCtrlEnabled(false);
      scheduleReconnect('token may be stale', true);
      return;
    }
    state.mqttReconnecting = false;
    log('MQTT connected');
    state.mqttOk = true;
    state.retry.burst = 0;
    lastConnectTs = Date.now();
    lastPing = Date.now();
    updateBadgeState(null);
    m.subscribe('device/' + deviceId + '/app', 0, () => {
      log('subscribed device/' + deviceId + '/app');
      sendProbes();
      if (!state.reachable) armReachProbe(8000);
    });
  };
  m.onMessage = (topic, payload, raw) => handleAppMessage(topic, payload, raw);
  m.onOpen = () => log('WS open — sent CONNECT');
  m.onClose = (ev) => {
    state.mqttConnecting = false;
    clearTimeout(mqttConnTimer);
    log('MQTT disconnected' + (ev ? ' code=' + ev.code + (ev.reason ? ' ' + ev.reason : '') : ''));
    state.mqttOk = false;
    setCtrlEnabled(false);
    state.ctrlEnabled = false;
    updateBadgeState(false);
    const up = lastConnectTs ? (Date.now() - lastConnectTs) : 0;
    state.retry.burst = (up > 30000) ? 0 : state.retry.burst + 1;
    if (up > 30000) state.retry.delay = 2000;
    scheduleReconnect('connection dropped', false);
  };
  m.onError = (e) => log('MQTT error: ' + (e && e.message ? e.message : e));
}

function scheduleReconnect(reason, useRefresh) {
  if (state.mqttReconnecting) return;
  if (!store.refresh) return;
  if (!state.device) return;
  if (state.retry.burst >= 6) {
    log('mqtt keeps getting dropped — backing off until next poll/check');
    return;
  }
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

let statusTimer = null;
function startStatusPoll() {
  stopStatusPoll();
  pollDeviceStatus();
  statusTimer = setInterval(pollDeviceStatus, 30000);
}
function stopStatusPoll() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

async function pollDeviceStatus() {
  if (!state.deviceId || !store.email) return 'not signed in';
  try {
    await ensureAccess();
    const res = await http('/api/devices?user=' + encodeURIComponent(store.email) +
      '&with_location=true&with_owner=true&page=0&size=20', {
      headers: { 'Accept': 'application/vnd.slamtec.devicelist-v1.0+json' }
    });
    if (!res.ok) return 'status check failed (HTTP ' + res.status + ')';
    const j = safeJson(res.body);
    const devs = Array.isArray(j) ? j : (j && (j.content || j.devices || j.data)) || [];
    const curId = state.deviceId;
    const d = devs.find(x => (x.device_id || x.id || x.sn) === curId && devOnline(x)) ||
      devs.find(devOnline) ||
      devs.find(x => (x.device_id || x.id || x.sn) === curId) ||
      devs[0] || null;
    if (!d) return 'robot not found in account';
    const newId = d.device_id || d.id || d.sn;
    if (newId && newId !== curId) {
      state.deviceId = newId;
      log('switched device to ' + String(newId).slice(0, 8) + ' (previous one offline)');
    }
    if (state.device) state.device = Object.assign({}, state.device, d); else state.device = d;
    updateBadgeState(state.reachable);
    if (!state.mqtt.connected && !state.mqttConnecting && !state.mqttReconnecting) {
      if (state.deviceId) connectMqtt(state.deviceId);
    } else if (state.mqtt.connected && !state.reachable && !reachTimer) {
      sendProbes();
      armReachProbe(8000);
    }
    return state.mqtt.connected && state.reachable ? 'robot is online' : 'robot is OFFLINE';
  } catch (e) {
    log('status poll error: ' + e.message);
    return 'status check failed (' + e.message + ')';
  }
}

function setCtrlEnabled(on) {
  const ids = ['btn-sweep', 'btn-edge', 'btn-spot', 'btn-home', 'btn-find', 'btn-wall', 'btn-wall-save', 'btn-nogo', 'btn-remap', 'btn-all-clear'];
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
  if (!on && state.noGoMode) {
    state.noGoMode = false;
    state.noGoDraft = null;
    const btn = $('btn-nogo');
    if (btn) { btn.textContent = '＋ Zone'; btn.classList.remove('active'); }
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
function requestNetworkInfo() {
  sendCmd(CMD.NETWORK_INFO);
}
function requestEntireMap(force) {
  // Throttle: if the robot is already streaming live tiles there's no need to
  // ask for the whole map again; a 6 s floor stops request storms.
  const now = Date.now();
  if (!force && now - state._lastEntireReq < 6000) return;
  state._lastEntireReq = now;
  sendCmd(CMD.ENTIRE_MAP);
}
function renderWifi() {
  const el = $('wifi-line');
  if (!el) return;
  const w = state.wifi;
  const last = state.lastContact;
  let txt;
  if (w) {
    txt = (w.ssid ? 'WiFi: ' + w.ssid : 'WiFi: —') + (w.ip ? ' · IP ' + w.ip : '') +
      (w.mac ? ' · ' + w.mac.slice(-6).toUpperCase() : '');
  } else {
    const lw = loadLastWifi();
    txt = lw && lw.ssid
      ? 'WiFi (last known): ' + lw.ssid + ' · ' + (lw.ip || 'no IP')
      : 'WiFi: — (robot offline)';
  }
  if (last) txt += ' · live ' + ago(last);
  el.textContent = txt;
}
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm';
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
let pingTimer = null;
let poseTimer = null;
function startPoseTick() {
  if (poseTimer) return;
  poseTimer = setInterval(() => {
    renderPose();
    // Keep the map fresh: if the robot has gone quiet (not streaming tiles) but
    // is still reachable, ask for the full map again so the pose never tracks
    // over a stale floor plan.
    if (state.mqtt && state.mqtt.connected && state.reachable && state.mapSource !== 'saved') {
      if (Date.now() - state._lastMapMsg > 12000) requestEntireMap();
    }
  }, 1000);
}
function stopPoseTick() {
  if (poseTimer) { clearInterval(poseTimer); poseTimer = null; }
}
function pingLoop() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    const m = state.mqtt;
    if (m.connected && Date.now() - lastPing > 20000) {
      m.ping();
      lastPing = Date.now();
    }
    renderWifi();
  }, 10000);
}

function handleAppMessage(topic, payload, raw) {
  const text = bytesToStr(payload);
  const env = safeJson(text);
  if (!env || env.f === undefined) {
    handleReach();
    log('rx: ' + text.slice(0, 120));
    return;
  }
  const f = env.f;
  const p = env.p;
  handleReach();
  switch (f) {
    case TYPE.POSE:
      state.pose = { x: num(p.x), y: num(p.y), yaw: num(p.yaw) };
      state.poseTs = Date.now();
      if (!state._poseLogged) {
        state._poseLogged = true;
        log('pose sample: x=' + p.x + ' y=' + p.y + ' yaw=' + p.yaw);
      }
      trackPose(state.pose);
      renderPose();
      // When viewing a saved/cloud map the pose/s trail aren't drawn, so a full
      // repaint here would be wasted work.
      if (state.mapSource !== 'saved') drawMap$();
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
      if (typeof p === 'number') {
        state.statusText = STATUS_LABELS[p] || ('Working (' + p + ')');
      } else if (p && typeof p === 'object') {
        state.status = p;
        const t = p.state !== undefined ? p.state : (p.text !== undefined ? p.text : p.status);
        state.statusText = (t === undefined || t === null || t === '') ? '' : (STATUS_LABELS[t] || String(t));
      }
      renderStatus();
      break;
    case TYPE.VIRTUAL_WALLS:
      if (!state.wallDirty) {
        state.walls = parseWalls(p);
        state._wallVer++;
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
    case TYPE.SWEEP_FAN_MODE: {
      state.fanMode = num(p);
      const sel = $('fan-mode');
      if (sel && sel.value === '') sel.value = String(state.fanMode);
      break;
    }
    case TYPE.SMART_PRESSURIZATION:
      if (p && typeof p === 'object' && p.value !== undefined) {
        state.carpetBoost = !!p.value;
        const cb = $('carpet-boost');
        if (cb) cb.checked = state.carpetBoost;
      }
      break;
    case TYPE.NETWORK_INFO:
      if (p && typeof p === 'object') {
        state.wifi = {
          ssid: p.ssid !== undefined ? String(p.ssid) : null,
          ip: p.ip !== undefined ? String(p.ip) : null,
          mac: p.mac !== undefined ? String(p.mac) : null
        };
        state.wifiTs = Date.now();
        saveLastWifi(state.wifi);
        log('network: ssid=' + state.wifi.ssid + ' ip=' + state.wifi.ip);
        renderWifi();
      }
      break;
    case TYPE.ENTIRE_EXPLORE_MAP:
    case TYPE.ENTIRE_SWEEP_MAP:
      state.hasEntireMap = true;
      state._lastMapMsg = Date.now();
      storeMapTile(p, 'entire');
      drawMap$();
      break;
    case TYPE.EXPLORE_MAP:
    case TYPE.SWEEP_MAP:
      // Live tiles streamed while the robot is mapping. Rendered on their own
      // layer so they never mix with the complete (17/18) map.
      state._lastMapMsg = Date.now();
      queueLive(p);
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
/* Jumps >1 m are treated as teleports (robot picked up / re-localised) and start
   a new trail segment so we never draw a false line across the map. */
function trackPose(p) {
  if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
  const t = state.trail;
  const last = t[t.length - 1];
  if (!last) { t.push({ x: p.x, y: p.y }); return; }
  const d = Math.hypot(p.x - last.x, p.y - last.y);
  if (d > 1.0) {
    // A big jump means the robot was picked up/moved (localization reset), so
    // the cached map is now in the old frame — resync it from the robot.
    requestEntireMap();
    t.push({ x: p.x, y: p.y, brk: true });
    if (t.length > 8000) t.splice(0, t.length - 8000);
    return;
  }
  if (d > 0.02) {
    t.push({ x: p.x, y: p.y });
    if (t.length > 8000) t.splice(0, t.length - 8000);
    // Self-calibrate the heading arrow: the direction of travel is ground truth
    // for which yaw convention makes the arrow point where the robot is going.
    if (!state._headDone && d > 0.15) {
      const ux = (p.x - last.x) / d, uy = (p.y - last.y) / d;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      state._headScore1 += ux * c + uy * s;      // dx=cos, dy=+sin
      state._headScore2 += ux * c + uy * (-s);   // dx=cos, dy=-sin
      state._headN++;
      if (state._headN >= 6 && Math.abs(state._headScore1 - state._headScore2) > 1.5) {
        state._headDone = true;
        state.headingFlip = state._headScore2 > state._headScore1;
        log('heading calibration: ' + (state.headingFlip ? 'MIRRORED (y flipped)' : 'standard') +
          ' (scores ' + state._headScore1.toFixed(1) + ' vs ' + state._headScore2.toFixed(1) + ')');
      }
    }
  }
}

/* Key by origin + resolution only (NOT dimensions): a live tile grows in size
   as the robot explores, and we want each update to replace the previous one
   rather than accumulate overlapping copies. */
function tileKey(t) { return t.realX + ',' + t.realY + ',' + t.res; }

function storeMapTile(p, kind) {
  // While viewing a saved/cloud map, ignore live robot tiles until the user
  // returns to the live layer (otherwise the robot stream overwrites it).
  if (state.mapSource === 'saved' && kind !== 'saved') return false;
  if (!p || !p.map_data) { log('map msg without map_data'); return false; }
  const tile = MapRLE.decodeMapMessage(p);
  if (!tile) { log('map decode failed'); return false; }
  // Switching between the live (mapping) layer and the complete map resets the
  // cache, so tiles from different frames never overlap into a jumbled mess.
  if (state.mapKind !== kind) {
    state.mapKind = kind;
    state.mapCache = new Map();
    state.maps = [];
    state.worldBounds = null;
    state._mapLogged = false;
    state.view.fit = true;
    log('map layer: ' + kind);
  }
  const key = tileKey(tile);
  const entry = state.mapCache.get(key);
  if (entry) {
    entry.tile = tile;
    entry.raw = p;
    tileToCanvas(entry);
  } else {
    state.maps.push(tile);
    const e = { tile, canvas: null, raw: p };
    tileToCanvas(e);
    state.mapCache.set(key, e);
  }
  state._mapVer++;
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
  $('map-status').textContent = (kind === 'live' ? 'mapping… ' : 'map ') + tile.dimX + 'x' + tile.dimY +
    '  ' + state.mapCache.size + (state.mapCache.size > 1 ? ' tiles' : ' tile') + ' · ' + (MapRLE.VER || 'rle-OLD');
  if (!state._mapLogged) {
    state._mapLogged = true;
    log('map tile (' + kind + ') dims=' + tile.dimX + 'x' + tile.dimY + ' res=' + tile.res + ' real=(' + tile.realX + ',' + tile.realY + ') cells=' + tile.grid.length);
    log('map sample(A):\n' + gridAscii(tile.grid, tile.dimX, tile.dimY, 48, 18));
  }
  return true;
}

/* Live tiles can stream at ~10 Hz while mapping; decode + rasterise is not free,
   so coalesce to ~5 Hz but always flush the last frame so nothing is missed. */
let _livePending = null, _liveLast = 0, _liveTimer = null;
function queueLive(p) {
  const now = Date.now();
  if (now - _liveLast >= 180) {
    _liveLast = now;
    storeMapTile(p, 'live');
    drawMap$();
    return;
  }
  _livePending = p;
  if (!_liveTimer) {
    _liveTimer = setTimeout(() => {
      _liveTimer = null;
      _liveLast = Date.now();
      const q = _livePending; _livePending = null;
      if (q) { storeMapTile(q, 'live'); drawMap$(); }
    }, 180);
  }
}

function gridAscii(grid, dimX, dimY, cols, rows) {
  const sx = Math.max(1, Math.floor(dimX / cols));
  const sy = Math.max(1, Math.floor(dimY / rows));
  let s = '';
  for (let y = 0; y < dimY; y += sy) {
    let line = '';
    for (let x = 0; x < dimX; x += sx) {
      const v = grid[y * dimX + x];
      line += (v > 127) ? '#' : (v ? '.' : ' ');
    }
    s += line + '\n';
  }
  return s;
}

function tileToCanvas(entry) {
  const t = entry.tile;
  const g = t.grid;
  // Occupancy image: 1 pixel per cell. Drawn with image smoothing OFF, so each
  // cell stays a crisp block at any zoom (no blur on high-DPI screens).
  const c = document.createElement('canvas');
  c.width = t.dimX; c.height = t.dimY;
  const cx = c.getContext('2d');
  const img = cx.createImageData(t.dimX, t.dimY);
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (v === 0) continue;
    const idx = i * 4;
    if (v > 127) { img.data[idx] = 22; img.data[idx + 1] = 29; img.data[idx + 2] = 44; }
    else { img.data[idx] = 237; img.data[idx + 1] = 242; img.data[idx + 2] = 249; }
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

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draw the home/charging base as a small "home + charging" glyph.
function drawDock(ctx, v, dock) {
  const d = worldToScreen(dock.x, dock.y);
  const s = Math.max(14, 0.24 * v.scale); // glyph size in px
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(dock.yaw || 0);

  // soft glow
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.15);
  glow.addColorStop(0, 'rgba(125,224,163,.45)');
  glow.addColorStop(1, 'rgba(125,224,163,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 0, s * 1.15, 0, Math.PI * 2); ctx.fill();

  // rounded dock base
  const w = s * 1.25, h = s * 0.92, r = s * 0.28;
  ctx.fillStyle = '#0e2b1e';
  ctx.strokeStyle = '#7de0a3';
  ctx.lineWidth = Math.max(1.5, s * 0.08);
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.fill(); ctx.stroke();

  // roof
  ctx.beginPath();
  ctx.moveTo(-w * 0.32, -h * 0.08);
  ctx.lineTo(0, -h * 0.46);
  ctx.lineTo(w * 0.32, -h * 0.08);
  ctx.strokeStyle = '#7de0a3';
  ctx.lineWidth = Math.max(1.5, s * 0.08);
  ctx.lineJoin = 'round';
  ctx.stroke();

  // lightning bolt (charging)
  ctx.fillStyle = '#7de0a3';
  ctx.beginPath();
  ctx.moveTo(s * 0.08, -h * 0.14);
  ctx.lineTo(-s * 0.10, s * 0.10);
  ctx.lineTo(s * 0.00, s * 0.10);
  ctx.lineTo(-s * 0.06, h * 0.38);
  ctx.lineTo(s * 0.16, -s * 0.02);
  ctx.lineTo(s * 0.02, -s * 0.02);
  ctx.closePath();
  ctx.fill();

  // label (kept upright)
  ctx.rotate(-(dock.yaw || 0));
  ctx.fillStyle = '#7de0a3';
  ctx.font = '600 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('HOME', 0, -s * 0.95);
  ctx.restore();
}

/* Coalesce map repaints: POSE streaming at ~10 Hz used to trigger a full canvas
   redraw per message. Now at most one redraw per animation frame. */
let _mapRaf = 0;
function drawMap$() {
  if (_mapRaf) return;
  _mapRaf = requestAnimationFrame(() => { _mapRaf = 0; renderMap(); });
}

function renderMap() {
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W === 0 || H === 0) return;
  const wpx = Math.round(W * dpr), hpx = Math.round(H * dpr);
  if (canvas.width !== wpx || canvas.height !== hpx) { canvas.width = wpx; canvas.height = hpx; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const b = state.worldBounds;
  if (!b || !state.view.scale) {
    ctx.fillStyle = '#0a0f1c'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8a93a8'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Waiting for map…', W / 2, H / 2);
    return;
  }
  const v = state.view;
  // The static layer (floor plan + walls + no-go zones) only changes when the
  // map, view or zones change; POSE streams (~10 Hz) reuse it in one blit plus a
  // couple of cheap overlays, instead of re-rasterising every tile each frame.
  if (_scKey !== staticLayerKey(W, H, dpr, v, b) || !_sc) buildStaticLayer(W, H, dpr, v, b);
  ctx.drawImage(_sc, 0, 0, W, H);

  if (state.mapSource === 'saved') {
    // Viewing a stored/cloud map: show its own dock (if any) but NOT the live
    // robot pose/trail, which would be misleading on a different floor plan.
    if (state.savedDock) drawDock(ctx, v, state.savedDock);
  } else {
    // robot path trail (history of poses)
    const trail = state.trail;
    if (trail && trail.length > 1) {
      ctx.strokeStyle = 'rgba(62,166,255,.85)';
      ctx.lineWidth = Math.max(1.5, 0.025 * v.scale);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < trail.length; i++) {
        const pt = trail[i];
        const sx = v.ox + (pt.x - b.minX) * v.scale;
        const sy = v.oy + (pt.y - b.minY) * v.scale;
        if (pt.brk || !pen) { ctx.moveTo(sx, sy); pen = true; } else { ctx.lineTo(sx, sy); }
      }
      ctx.stroke();
    }

    // sweep path (robot-reported planned/executed path for this action)
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

    // dock / charging station (home base)
    if (state.dock) drawDock(ctx, v, state.dock);

    // robot pose
    if (state.pose) {
      const p = worldToScreen(state.pose.x, state.pose.y);
      const r = Math.max(4, 0.09 * v.scale);
      ctx.fillStyle = '#3ea6ff';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(state.pose.yaw) * r * 2,
        p.y + Math.sin(state.pose.yaw) * (state.headingFlip ? -1 : 1) * r * 2);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  // draft walls / no-go box (committed ones are baked into the static layer)
  drawWalls(ctx, v, b, state.wallDraft && state.wallDraft.x1 !== undefined ? state.wallDraft : null, true);
  drawNoGo(ctx, v, b, state.noGoDraft && state.noGoDraft.x1 !== undefined ? state.noGoDraft : null, true);

  // spot region selection
  if (state.spot && state.spotCur) {
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(state.spotCur.x0, state.spotCur.y0, state.spotCur.x1 - state.spotCur.x0, state.spotCur.y1 - state.spotCur.y0);
    ctx.setLineDash([]);
  }
}

function drawWalls(ctx, v, b, draft, only) {
  const walls = only ? [] : state.walls.slice();
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

function drawNoGo(ctx, v, b, draft, only) {
  const zones = only ? [] : state.noGo.slice();
  if (draft && draft.x1 !== undefined) zones.push(draft);
  for (const z of zones) {
    const x0 = v.ox + (Math.min(z.x0, z.x1) - b.minX) * v.scale;
    const y0 = v.oy + (Math.min(z.y0, z.y1) - b.minY) * v.scale;
    const w = Math.abs(z.x1 - z.x0) * v.scale;
    const h = Math.abs(z.y1 - z.y0) * v.scale;
    if (w < 1 && h < 1) continue;
    ctx.fillStyle = z.draft ? 'rgba(255,71,87,.16)' : 'rgba(255,71,87,.13)';
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = z.draft ? 'rgba(255,71,87,.75)' : '#ff4757';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    if (w > 8 && h > 8) {
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x0 + w, y0 + h);
      ctx.moveTo(x0 + w, y0); ctx.lineTo(x0, y0 + h);
      ctx.stroke();
    }
  }
}

/* ---- static map layer cache ---- */
let _sc = null, _scx = null, _scKey = '';
function staticLayerKey(W, H, dpr, v, b) {
  return [W, H, dpr, v.scale.toFixed(4), v.ox.toFixed(2), v.oy.toFixed(2),
    b.minX, b.minY, b.maxX, b.maxY,
    state._mapVer || 0, state._wallVer || 0, state._nogoVer || 0].join('|');
}
function buildStaticLayer(W, H, dpr, v, b) {
  if (!_sc) { _sc = document.createElement('canvas'); _scx = _sc.getContext('2d'); }
  _sc.width = Math.max(1, Math.round(W * dpr));
  _sc.height = Math.max(1, Math.round(H * dpr));
  const c = _scx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#0a0f1c'; c.fillRect(0, 0, W, H);
  // soft map panel behind the floor plan so it reads as a clean surface
  const mx = v.ox, my = v.oy, mw = (b.maxX - b.minX) * v.scale, mh = (b.maxY - b.minY) * v.scale;
  c.save();
  c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 16; c.shadowOffsetY = 5;
  c.fillStyle = '#0f1626';
  roundRect(c, mx, my, mw, mh, 10); c.fill();
  c.restore();
  for (const entry of state.mapCache.values()) {
    const t = entry.tile;
    const tx = v.ox + (t.realX - b.minX) * v.scale;
    const ty = v.oy + (t.realY - b.minY) * v.scale;
    c.drawImage(entry.canvas, tx, ty, t.dimX * t.res * v.scale, t.dimY * t.res * v.scale);
  }
  // subtle border around the mapped area
  c.strokeStyle = 'rgba(125,146,186,.28)'; c.lineWidth = 1;
  roundRect(c, mx, my, mw, mh, 10); c.stroke();
  drawWalls(c, v, b, null);
  drawNoGo(c, v, b, null);
  _scKey = staticLayerKey(W, H, dpr, v, b);
  return _sc;
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
  state._wallVer++;
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
  state._wallVer++;
  setWallBank();
  drawMap$();
  ctrlMsg('walls cleared — tap Save to send', false);
}

/* ================= no-go (forbidden) zones ================= */
function setNoGoBank() {
  const el = $('nogo-status');
  if (!el) return;
  el.textContent = (state.noGoDirty ? '● unsaved · ' : '') + state.noGo.length + ' zone' + (state.noGo.length === 1 ? '' : 's') + (state.noGoMode ? ' — drag a box, tap a zone to delete' : '') + (state.noGo.length && !state.noGoDirty ? ' · experimental send' : '');
  const save = $('btn-nogo-save');
  const clear = $('btn-nogo-clear');
  if (save) save.disabled = !state.noGoDirty;
  if (clear) clear.disabled = !state.noGo.length && !state.noGoDirty;
}

function toggleNoGoMode() {
  if (!state.mqttOk) { ctrlMsg('Connect first', true); return; }
  state.noGoMode = !state.noGoMode;
  if (state.noGoMode) {
    if (state.wallMode) {
      state.wallMode = false;
      const wb = $('btn-wall');
      if (wb) { wb.textContent = '＋ Wall'; wb.classList.remove('active'); }
      state.wallDraft = null;
      setWallBank();
    }
    if (state.spot) {
      state.spot = false;
      $('btn-spot').textContent = 'Spot region';
      state.spotCur = null;
    }
  }
  const btn = $('btn-nogo');
  if (btn) { btn.textContent = state.noGoMode ? 'Cancel' : '＋ Zone'; btn.classList.toggle('active', state.noGoMode); }
  state.noGoDraft = null;
  setNoGoBank();
  drawMap$();
}

function finishNoGoDraft() {
  const d = state.noGoDraft;
  if (!d || d.x1 === undefined) return;
  if (Math.abs(d.x1 - d.x0) < 0.15 || Math.abs(d.y1 - d.y0) < 0.15) {
    ctrlMsg('Zone too small (drag a box)', true);
    return;
  }
  const id = state.noGo.reduce((m, z) => Math.max(m, z.id), -1) + 1;
  state.noGo.push({ id, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
  state.noGoDirty = true;
  state._nogoVer++;
  ctrlMsg('no-go zone added — tap Save to send', false);
  setNoGoBank();
  drawMap$();
}

function noGoToRegion(z) {
  // Sweep-region objects carry a type: 0 normal, 1 forbidden (no-go), 2 mop.
  return {
    label: 'PWA no-go',
    rad: 0.05,
    type: 1,
    points: [
      { x: z.x0, y: z.y0 }, { x: z.x1, y: z.y0 },
      { x: z.x1, y: z.y1 }, { x: z.x0, y: z.y1 }
    ]
  };
}

function saveNoGo() {
  if (!state.mqttOk) { ctrlMsg('Not connected', true); return; }
  if (!state.noGo.length) { ctrlMsg('No zones to save', true); return; }
  sendCmd(CMD.CREATE_SWEEP_REGION, state.noGo.map(noGoToRegion));
  state.noGoDirty = false;
  setNoGoBank();
  ctrlMsg('no-go zones sent to robot (experimental)', false);
}

function clearNoGo() {
  state.noGo = [];
  state.noGoDirty = true;
  state._nogoVer++;
  setNoGoBank();
  drawMap$();
  ctrlMsg('zones cleared — tap Save to send', false);
}

function nearestNoGo(p) {
  let best = null;
  for (const z of state.noGo) {
    const a = worldToScreen(Math.min(z.x0, z.x1), Math.min(z.y0, z.y1));
    const c = worldToScreen(Math.max(z.x0, z.x1), Math.max(z.y0, z.y1));
    if (p.x >= a.x && p.x <= c.x && p.y >= a.y && p.y <= c.y) best = z;
  }
  return best;
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
      if (state.noGoMode) {
        const w = screenToWorld(p.x, p.y);
        if (w) state.noGoDraft = { draft: true, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
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
    } else if (state.noGoMode) {
      const w = screenToWorld(p.x, p.y);
      if (w && state.noGoDraft) { state.noGoDraft.x1 = w.x; state.noGoDraft.y1 = w.y; }
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
          state._wallVer++;
          setWallBank();
          ctrlMsg('wall removed — tap Save to send', false);
          drawMap$();
        }
      } else if (state.spot) {
        // tap with no drag = nothing to send
      } else if (state.noGoMode && state.worldBounds) {
        const hit = nearestNoGo(p);
        if (hit) {
          state.noGo = state.noGo.filter(z => z.id !== hit.id);
          state.noGoDirty = true;
          state._nogoVer++;
          setNoGoBank();
          ctrlMsg('zone removed — tap Save to send', false);
          drawMap$();
        }
      }
    } else if (state.wallMode) {
      finishWallDraft();
    } else if (state.noGoMode) {
      finishNoGoDraft();
    } else if (state.spot && state.worldBounds) {
      endSpotRegion(p);
    }
    down = null;
    state.wallDraft = null;
    state.noGoDraft = null;
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
  if (state.noGoMode) toggleNoGoMode();
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

async function copyDiag() {
  const g = (id) => { const el = $(id); return el ? el.textContent : '?'; };
  const parts = [
    'build ' + APP_VER,
    'status: ' + g('pill-online'),
    'dev: ' + g('dev-sub'),
    'action: ' + g('action-line'),
    'wifi: ' + g('wifi-line'),
    'banner: ' + (g('banner') || '').slice(0, 200),
    '--- log ---',
    g('log-box')
  ].join('\n');
  try {
    await navigator.clipboard.writeText(parts);
    ctrlMsg('diagnostics copied — paste it to me', false);
  } catch (e) {
    ctrlMsg('copy failed: ' + e.message, true);
  }
}

function on(id, fn) { const el = $(id); if (el) el.onclick = fn; }
function onEvent(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }

function pulseBtn(el) {
  if (!el) return;
  el.classList.remove('pressed');
  void el.offsetWidth; // restart animation
  el.classList.add('pressed');
  clearTimeout(el._pulseT);
  el._pulseT = setTimeout(() => el.classList.remove('pressed'), 260);
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* noop */ } }
}
function wirePressFeedback() {
  document.querySelectorAll('.ctrl, .zoom, #login-btn').forEach(b => {
    b.addEventListener('pointerdown', () => pulseBtn(b));
    b.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') pulseBtn(b); });
  });
}

function clearMapLocal() {
  state.maps = [];
  state.mapCache = new Map();
  _scKey = ''; // force a fresh static layer on the next render
  state.mapKind = null;
  state.mapSource = 'live';
  state.mapLabel = '';
  state.savedDock = null;
  state.worldBounds = null;
  state.hasEntireMap = false;
  state._lastEntireReq = 0;
  state._lastMapMsg = 0;
  state._mapLogged = false;
  state.trail = [];
  state.view = { scale: 0, ox: 0, oy: 0, fit: true };
  _livePending = null;
  if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
  const ms = $('map-status');
  if (ms) ms.textContent = 'Waiting for map…';
  updateMapSourceUI();
  drawMap$();
}

function resetAndExplore() {
  if (!state.mqtt.connected) { ctrlMsg('Not connected (robot offline?)', true); return; }
  if (!window.confirm('Reset the saved map and build a new one?\n\nThe robot will wipe its floor plan and drive around to map the room again. Best to put it on the dock first.')) return;
  ctrlMsg('resetting map…', false);
  sendCmd(CMD.CLEAR_MAP);
  clearMapLocal();
  log('remap: sent CLEAR_MAP; starting auto-explore in 3s');
  clearTimeout(state._remapTimer);
  state._remapTimer = setTimeout(() => {
    sendCmd(CMD.START_AUTO_EXPLORING);
    ctrlMsg('map reset — mapping a new floor plan (let it do a full lap)', false);
  }, 3000);
}

/* ================= saved & cloud maps ================= */
// Namespaced per account so maps never leak between users on a shared browser.
function savedKey() { return 'jarvis.maps:' + (store.email || 'anon'); }

function loadSavedIndex() {
  try { state.savedMaps = JSON.parse(localStorage.getItem(savedKey()) || '[]'); }
  catch (e) { state.savedMaps = []; }
  if (!Array.isArray(state.savedMaps)) state.savedMaps = [];
  renderSavedList();
}
function persistSavedIndex() {
  localStorage.setItem(savedKey(), JSON.stringify(state.savedMaps));
}

function currentPayloads() {
  const out = [];
  for (const e of state.mapCache.values()) if (e && e.raw) out.push(e.raw);
  return out;
}

function saveCurrentMap() {
  const payloads = currentPayloads();
  if (!payloads.length) { ctrlMsg('No map on screen to save yet', true); return; }
  const def = 'Map ' + new Date().toLocaleString();
  const name = (window.prompt('Name this map:', state.mapLabel || def) || '').trim();
  if (!name) return;
  const snap = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.slice(0, 40),
    savedAt: Date.now(),
    kind: state.mapKind || 'live',
    dock: state.dock || null,
    tiles: payloads
  };
  const next = [snap, ...state.savedMaps];
  if (next.length > 30) next.length = 30;
  const prev = state.savedMaps;
  state.savedMaps = next;
  try { persistSavedIndex(); }
  catch (e) { state.savedMaps = prev; ctrlMsg('Could not save map (browser storage full)', true); return; }
  renderSavedList();
  ctrlMsg('map saved: ' + snap.name, false);
}

function deleteSavedMap(id) {
  const snap = state.savedMaps.find(s => s.id === id);
  if (snap && !window.confirm('Delete saved map "' + snap.name + '"?')) return;
  state.savedMaps = state.savedMaps.filter(s => s.id !== id);
  persistSavedIndex();
  renderSavedList();
}

function renameSavedMap(id) {
  const s = state.savedMaps.find(x => x.id === id);
  if (!s) return;
  const name = (window.prompt('Rename map:', s.name) || '').trim();
  if (!name) return;
  s.name = name.slice(0, 40);
  persistSavedIndex();
  renderSavedList();
}

function loadSavedMap(id) {
  const snap = state.savedMaps.find(s => s.id === id);
  if (!snap || !snap.tiles || !snap.tiles.length) { ctrlMsg('saved map is empty', true); return; }
  const when = new Date(snap.savedAt).toLocaleDateString();
  if (!showMapFromPayloads(snap.tiles, snap.name + ' · saved ' + when, snap.dock)) {
    ctrlMsg('this saved map could not be decoded', true);
    return;
  }
  ctrlMsg('showing saved map: ' + snap.name, false);
}

function renderSavedList() {
  const el = $('saved-maps');
  if (!el) return;
  el.innerHTML = '';
  if (!state.savedMaps.length) { el.innerHTML = '<div class="muted small">No saved maps yet.</div>'; return; }
  for (const s of state.savedMaps) {
    el.appendChild(mapRow(s.name, new Date(s.savedAt).toLocaleString(), [
      { label: 'Load', cls: 'xs', fn: () => loadSavedMap(s.id) },
      { label: '✎', cls: 'xs', fn: () => renameSavedMap(s.id) },
      { label: '✕', cls: 'xs warn', fn: () => deleteSavedMap(s.id) }
    ]));
  }
}

function mapRow(name, meta, buttons) {
  const row = document.createElement('div');
  row.className = 'map-item';
  const text = document.createElement('div');
  text.className = 'map-text';
  const nm = document.createElement('div');
  nm.className = 'map-name';
  nm.textContent = name;
  const mt = document.createElement('div');
  mt.className = 'muted small';
  mt.textContent = meta;
  text.appendChild(nm);
  text.appendChild(mt);
  row.appendChild(text);
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'ctrl ' + b.cls;
    btn.textContent = b.label;
    btn.onclick = b.fn;
    // Rows are created after wirePressFeedback() ran, so wire feedback here.
    btn.addEventListener('pointerdown', () => pulseBtn(btn));
    row.appendChild(btn);
  }
  return row;
}

function cloudNameFor(mapId) {
  const d = (state.device && state.device.properties) || {};
  for (const n of [1, 2, 3]) {
    if (d['fav_map_' + n + '_id'] === mapId) return d['fav_map_' + n + '_name'] || ('Favourite ' + n);
  }
  if (state.device && state.device.current_map === mapId) return 'Current map';
  return null;
}

async function loadCloudMaps() {
  const el = $('cloud-maps');
  if (state._cloudBusy) return;
  state._cloudBusy = true;
  if (el) el.innerHTML = '<div class="muted small">Loading…</div>';
  try {
    await ensureAccess();
    const res = await http('/api/maps?user=' + encodeURIComponent(store.email), {
      headers: { 'Accept': 'application/vnd.slamtec.maplist-v1.0+json' }
    });
    if (!res.ok) { if (el) el.innerHTML = '<div class="muted small">HTTP ' + res.status + '</div>'; return; }
    let list = safeJson(res.body);
    if (!Array.isArray(list)) list = (list && (list.content || list.maps)) || [];
    state.cloudMaps = list;
    state._cloudCap = 20;
    renderCloudList();
    ctrlMsg('found ' + list.length + ' map(s) on the robot', false);
  } catch (e) {
    if (el) el.innerHTML = '<div class="muted small">' + (e && e.message) + '</div>';
  } finally {
    state._cloudBusy = false;
  }
}

function renderCloudList() {
  const el = $('cloud-maps');
  if (!el) return;
  el.innerHTML = '';
  if (!state.cloudMaps.length) { el.innerHTML = '<div class="muted small">No maps stored on the robot.</div>'; return; }

  const byId = new Map(state.cloudMaps.map(m => [m.map_id || m.id, m]));
  const fmt = (m) => {
    const dx = m.dimensionX, dy = m.dimensionY;
    const when = String(m.last_updated || m.created || '').slice(0, 10);
    return (dx && dy ? dx + '×' + dy + ' · ' : '') + when;
  };
  const rows = [];
  const used = new Set();
  const d = (state.device && state.device.properties) || {};

  // Favourites first (the 3 named slots on the robot).
  for (const n of [1, 2, 3]) {
    const id = d['fav_map_' + n + '_id'];
    const m = id && byId.get(id);
    if (m) { rows.push({ name: d['fav_map_' + n + '_name'] || ('Favourite ' + n), m }); used.add(id); }
  }
  // Then the map the robot is currently using.
  const cur = state.device && state.device.current_map;
  if (cur && byId.get(cur) && !used.has(cur)) { rows.push({ name: 'Current map', m: byId.get(cur) }); used.add(cur); }

  // Then the rest, newest first (the account keeps a long history).
  const rest = state.cloudMaps
    .filter(m => !used.has(m.map_id || m.id))
    .sort((a, b) => String(b.last_updated || b.created || '').localeCompare(String(a.last_updated || a.created || '')));
  const cap = state._cloudCap || 20;
  for (const m of rest.slice(0, cap)) {
    const id = m.map_id || m.id;
    rows.push({ name: cloudNameFor(id) || ('Map ' + String(id).slice(0, 8)), m });
  }

  for (const r of rows) {
    const id = r.m.map_id || r.m.id;
    el.appendChild(mapRow(r.name, fmt(r.m), [
      { label: 'Load', cls: 'xs', fn: () => loadCloudMap(id, r.name) }
    ]));
  }
  const hidden = state.cloudMaps.length - rows.length;
  if (hidden > 0) {
    const more = document.createElement('button');
    more.className = 'ctrl sm ghost';
    more.style.marginTop = '6px';
    more.textContent = 'Show ' + Math.min(hidden, 20) + ' more (of ' + hidden + ')';
    more.onclick = () => { state._cloudCap = cap + 20; renderCloudList(); };
    el.appendChild(more);
  }
}

async function loadCloudMap(id, name) {
  ctrlMsg('loading map from robot…', false);
  try {
    await ensureAccess();
    const metaRes = await http('/api/maps/' + id, {
      headers: { 'Accept': 'application/vnd.slamtec.map-v1.0+json' }
    });
    if (!metaRes.ok) { ctrlMsg('map fetch failed (HTTP ' + metaRes.status + ')', true); return; }
    const meta = safeJson(metaRes.body) || {};
    const dx = Number(meta.dimensionX), dy = Number(meta.dimensionY);
    const rx = Number(meta.realX), ry = Number(meta.realY);
    if (!isFinite(dx) || !isFinite(dy) || !isFinite(rx) || !isFinite(ry) || dx <= 0 || dy <= 0) {
      ctrlMsg('map metadata incomplete — cannot render', true);
      log('cloud map meta: ' + JSON.stringify(meta).slice(0, 200));
      return;
    }
    const binRes = await http('/api/maps/' + id + '/binary');
    if (!binRes.ok) { ctrlMsg('map binary failed (HTTP ' + binRes.status + ')', true); return; }
    const mapData = (binRes.body || '').replace(/\s+/g, '');
    if (!mapData) { ctrlMsg('empty map data', true); return; }
    const payload = {
      dimension_x: dx, dimension_y: dy,
      resolution: Number(meta.resolutionX || meta.resolution) || 0.05,
      real_x: rx, real_y: ry,
      map_data: mapData
    };
    const dp = meta.dock_pose;
    const dock = (dp && typeof dp === 'object' && isFinite(Number(dp.x)) && isFinite(Number(dp.y)))
      ? { x: Number(dp.x), y: Number(dp.y), yaw: Number(dp.yaw) || 0 } : null;
    if (!showMapFromPayloads([payload], name + ' · robot', dock)) {
      ctrlMsg('this robot map could not be decoded', true);
      return;
    }
    ctrlMsg('showing robot map: ' + name, false);
  } catch (e) {
    ctrlMsg('map load error: ' + (e && e.message), true);
  }
}

/* Render a set of raw map payloads as a standalone (saved/cloud) layer. Live
   robot tiles are ignored until the user taps "Back to live". Returns the number
   of tiles actually decoded, so the caller can detect a bad payload. */
function showMapFromPayloads(payloads, label, dock) {
  state.mapSource = 'saved';
  state.mapKind = null;   // force storeMapTile to reset the layer cache
  state.view.fit = true;
  let n = 0;
  for (const p of payloads) { if (storeMapTile(p, 'saved')) n++; }
  if (!n) {
    // Nothing decoded — don't strand the user on an empty "saved" layer.
    state.mapSource = 'live';
    state.mapKind = null;
    clearMapLocal();
    return 0;
  }
  state.mapLabel = label || '';
  state.savedDock = dock || null;
  updateMapSourceUI();
  drawMap$();
  return n;
}

function goLiveMap() {
  state.mapSource = 'live';
  state.mapLabel = '';
  state.savedDock = null;
  clearMapLocal();
  updateMapSourceUI();
  requestEntireMap();
  ctrlMsg('back to live map', false);
}

function updateMapSourceUI() {
  const viewing = state.mapSource === 'saved';
  const label = $('map-label');
  if (label) label.textContent = viewing ? ('Viewing: ' + (state.mapLabel || 'saved map')) : '';
  const btn = $('btn-live-map');
  if (btn) btn.classList.toggle('hidden', !viewing);
}

/* ================= cleaning history & stats ================= */
function historyKey() { return 'jarvis.history:' + (store.email || 'anon'); }
function loadHistory() {
  try { state.history = JSON.parse(localStorage.getItem(historyKey()) || '[]'); }
  catch (e) { state.history = []; }
  if (!Array.isArray(state.history)) state.history = [];
  renderHistory();
}
function persistHistory() {
  try { localStorage.setItem(historyKey(), JSON.stringify(state.history)); } catch (e) { /* noop */ }
}
function currentRunType() {
  const act = state.action;
  const an = act && act.an;
  if (an === 4) return 'Sweep';
  if (an === 0) return 'Mapping';
  if (an === 5) return 'Spot';
  if (an === 6) return 'Edge';
  const st = state.status;
  if (st === 6) return 'Sweep';
  if (st === 11 || st === 12) return 'Spot';
  if (st === 20) return 'Mapping';
  if (st === 22) return 'Edge';
  const t = state.statusText || '';
  if (/return|dock|charg|idle|complete/i.test(t)) return null;
  if (/sweep/i.test(t)) return 'Sweep';
  if (/explor/i.test(t)) return 'Mapping';
  if (/edge/i.test(t)) return 'Edge';
  if (/spot/i.test(t)) return 'Spot';
  return null;
}
function trackRun() {
  const type = currentRunType();
  const r = state.run;
  if (!type) { if (r) finalizeRun(); return; }
  if (!r || r.type !== type) {
    if (r) finalizeRun();
    state.run = {
      type, startTs: Date.now(),
      startArea: state.area || 0, maxArea: state.area || 0, maxTime: state.sweepTime || 0
    };
  } else {
    r.maxArea = Math.max(r.maxArea, state.area || 0);
    r.maxTime = Math.max(r.maxTime, state.sweepTime || 0);
  }
}
function finalizeRun() {
  const r = state.run;
  state.run = null;
  if (!r) return;
  const durSec = Math.round((Date.now() - r.startTs) / 1000);
  const area = r.maxArea || 0;
  if (durSec < 15 && area < 1) return; // ignore blips / false starts
  state.history.unshift({
    ts: r.startTs,
    type: r.type,
    durSec,
    areaM2: Math.round(area * 100) / 100,
    sweepSec: Math.round(r.maxTime || 0),
    batt: state.battery
  });
  if (state.history.length > 50) state.history.length = 50;
  persistHistory();
  renderHistory();
}
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
}
function renderHistory() {
  const el = $('history-list');
  const sum = $('history-summary');
  if (!el) return;
  el.innerHTML = '';
  if (!state.history.length) {
    el.innerHTML = '<div class="muted small">No cleaning recorded yet. Runs are logged automatically while sweeping, mapping, spot or edge cleaning.</div>';
    if (sum) sum.textContent = '';
    return;
  }
  let area = 0, dur = 0;
  for (const e of state.history) { area += e.areaM2 || 0; dur += e.durSec || 0; }
  if (sum) sum.textContent = state.history.length + ' runs · ' + area.toFixed(1) + ' m² · ' + fmtDur(dur) + ' total';
  for (const e of state.history) {
    const row = document.createElement('div');
    row.className = 'map-item';
    const txt = document.createElement('div');
    txt.className = 'map-text';
    const nm = document.createElement('div');
    nm.className = 'map-name';
    nm.textContent = e.type + '  ·  ' + new Date(e.ts).toLocaleString();
    const mt = document.createElement('div');
    mt.className = 'muted small';
    mt.textContent = (e.areaM2 ? e.areaM2 + ' m²' : '—') + '  ·  ' + fmtDur(e.sweepSec || e.durSec) + (e.batt != null ? '  ·  ' + e.batt + '%' : '');
    txt.appendChild(nm);
    txt.appendChild(mt);
    row.appendChild(txt);
    el.appendChild(row);
  }
}
function clearHistory() {
  if (!state.history.length) return;
  if (!window.confirm('Clear all cleaning history?')) return;
  state.history = [];
  persistHistory();
  renderHistory();
}

function wireControls() {
  on('btn-sweep', () => sendCmd(CMD.SWEEP));
  on('btn-edge', () => sendCmd(CMD.START_EDGE_SWEEPING));
  on('btn-stop', () => sendCmd(CMD.STOP));
  on('btn-home', () => sendCmd(CMD.GO_HOME));
  on('btn-find', () => sendCmd(CMD.FIND_ME));
  on('btn-spot', toggleSpot);
  on('btn-all-clear', () => {
    if (window.confirm('Reset (clear) the robot mapping? This wipes the saved floor plan and starts a new map.')) {
      sendCmd(CMD.CLEAR_MAP);
      clearMapLocal();
    }
  });
  on('btn-wall', toggleWallMode);
  on('btn-wall-save', saveWalls);
  on('btn-wall-clear', clearWalls);
  on('btn-nogo', toggleNoGoMode);
  on('btn-nogo-save', saveNoGo);
  on('btn-nogo-clear', clearNoGo);
  on('btn-history-clear', clearHistory);
  on('btn-remap', resetAndExplore);
  on('btn-save-map', saveCurrentMap);
  on('btn-load-robot', loadCloudMaps);
  on('btn-live-map', goLiveMap);
  on('btn-zoom-in', zoomIn);
  on('btn-zoom-out', zoomOut);
  on('btn-zoom-fit', resetView);
  on('btn-map-refresh', () => requestEntireMap(true));
  on('btn-add-sched', addSchedule);
  on('btn-logout', logout);
  on('btn-copy-log', copyDiag);
  onEvent('sched-time', 'change', () => $('sched-msg').textContent = '');
  onEvent('carpet-boost', 'change', (e) => toggleCarpetBoost(!!e.target.checked));
  on('btn-check-now', async () => {
    const btn = $('btn-check-now');
    const b = $('banner');
    const stamp = () => new Date().toLocaleTimeString();
    try {
      if (btn) { btn.textContent = 'Checking…'; btn.disabled = true; btn.classList.add('checking'); }
      if (!state.mqtt.connected && !state.mqttConnecting && !state.mqttReconnecting && state.deviceId) {
        connectMqtt(state.deviceId);
        sendProbes();
      } else {
        sendProbes();
      }
      const ok = state.reachable ? true : await waitReach(12000);
      if (btn) { btn.disabled = false; btn.classList.remove('checking'); }
      if (ok) {
        if (btn) { btn.textContent = 'Online'; btn.classList.add('ok'); }
        if (b) {
          b.textContent = 'Checked ' + stamp() + ': robot is ONLINE. WiFi: ' + (state.wifi && state.wifi.ssid ? state.wifi.ssid : '(no network info yet)');
          b.className = 'banner online';
        }
        setTimeout(() => { if (btn) btn.textContent = 'Check robot now'; btn.classList.remove('ok'); updateBadgeState(state.reachable); }, 6000);
        $('ctrl-msg').textContent = 'robot is online (checked ' + stamp() + ')';
        $('ctrl-msg').className = 'msg ok';
      } else {
        if (btn) { btn.textContent = 'Offline'; btn.classList.add('err'); }
        const why = state.mqtt.connected
          ? 'Robot was asked 3 ways but answered nothing in 12 s.'
          : 'Cloud/MQTT link is not established yet (see log).';
        if (b) {
          b.textContent = 'Checked ' + stamp() + ': robot is OFFLINE. ' + why + ' Power it on and check its 2.4 GHz WiFi, then retry.';
          b.className = 'banner';
        }
        setTimeout(() => { if (btn) btn.textContent = 'Check robot now'; btn.classList.remove('err'); updateBadgeState(state.reachable); }, 8000);
        $('ctrl-msg').textContent = 'robot is OFFLINE (checked ' + stamp() + ')';
        $('ctrl-msg').className = 'msg err';
      }
      log('check result: ' + (ok ? 'ONLINE' : 'OFFLINE'));
    } catch (e) {
      if (btn) { btn.textContent = 'Check robot now'; btn.disabled = false; btn.classList.remove('checking'); }
      $('ctrl-msg').textContent = 'check failed: ' + e.message;
      $('ctrl-msg').className = 'msg err';
      log('check error: ' + e.message);
    }
  });
  const fan = $('fan-mode');
  if (fan) fan.addEventListener('change', () => {
    if (fan.value !== '') sendFanMode(parseInt(fan.value, 10));
  });
}

/* ================= screens ================= */
function show(id) {
  ['screen-login', 'screen-main'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
}

function clearState() {
  if (state.run) finalizeRun();
  state.history = [];
  state.maps = [];
  state.hasEntireMap = false;
  state.mapKind = null;
  state.mapSource = 'live';
  state.mapLabel = '';
  state._lastEntireReq = 0;
  state._lastMapMsg = 0;
  state.mapCache = new Map();
  _scKey = ''; // force a fresh static layer (map reset / account switch)
  state.worldBounds = null;
  state.pose = null;
  state.poseTs = 0;
  state._poseLogged = false;
  state.trail = [];
  state._mapLogged = false;
  state.action = null;
  state.device = null;
  state.devices = [];
  state.deviceId = null;
  state.battery = null;
  state.charging = null;
  state.status = null;
  state.statusText = '';
  state.dock = null;
  state.area = null;
  state.sweepTime = null;
  state.fanMode = null;
  state.carpetBoost = null;
  const cbEl = $('carpet-boost');
  if (cbEl) cbEl.checked = false;
  state.wifi = null;
  state.wifiTs = 0;
  state.lastContact = 0;
  state.reachable = false;
  state.ctrlEnabled = false;
  clearReachTimer();
  if (reachWaitResolve) { reachWaitResolve(false); }
  renderWifi();
  state.walls = [];
  state.wallDirty = false;
  state.wallMode = false;
  state.noGo = [];
  state.noGoDirty = false;
  state.noGoMode = false;
  state.noGoDraft = null;
  state.headingFlip = false;
  state._headDone = false;
  state._headN = 0;
  state._headScore1 = 0;
  state._headScore2 = 0;
  state.spot = false;
  state.spotCur = null;
  state.view = { scale: 0, ox: 0, oy: 0, fit: true };
  const sp = $('btn-spot');
  if (sp) sp.textContent = 'Spot region';
  const wb = $('btn-wall');
  if (wb) { wb.textContent = '＋ Wall'; wb.classList.remove('active'); }
  const nb = $('btn-nogo');
  if (nb) { nb.textContent = '＋ Zone'; nb.classList.remove('active'); }
  setNoGoBank();
}

function logout() {
  stopStatusPoll();
  stopPoseTick();
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  clearTimeout(mqttConnTimer);
  state.mqtt.disconnect();
  state.mqttOk = false;
  clearTimeout(state.retry.timer);
  store.refresh = null;
  store.email = null;
  access = null;
  clearState();
  setCtrlEnabled(false);
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
  loadSavedIndex();
  loadHistory();
  try {
    await fetchUser();
    const deviceId = await fetchDevices();
    connectMqtt(deviceId);
    pingLoop();
    startStatusPoll();
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
  wirePressFeedback();
  setupMap();
  setWallBank();
  setNoGoBank();
  renderWifi();
  startPoseTick();
  log('build ' + APP_VER + ' · ' + (typeof MapRLE !== 'undefined' && MapRLE.VER ? MapRLE.VER : 'rle-OLD'));
  try {
    const st = MapRLE.selfTest();
    log('decoder self-test: ' + (st.ok ? 'PASS' : 'FAIL') + ' ' + st.detail);
  } catch (e) { log('decoder self-test threw: ' + e.message); }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => log('service worker ready'))
      .catch((e) => log('service worker failed: ' + e.message));
  }
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

  const ccBtn = $('btn-clear-cache');
  if (ccBtn) ccBtn.addEventListener('click', async () => {
    ccBtn.disabled = true;
    ccBtn.textContent = 'Clearing…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (self.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) { /* ignore */ }
    location.reload(true);
  });

  bootstrap();
}

init();