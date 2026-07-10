const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : `${window.location.protocol}//${window.location.hostname}:3000`;

const WEBRTC_BASE = (() => {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1')
    ? 'http://localhost:8889'
    : `${window.location.protocol}//${h}:8889`;
})();

// ── Auth state ───────────────────────────────────────────
const TOKEN_KEY = 'cctv_token';
let token = localStorage.getItem(TOKEN_KEY);
let socket = null;
let authMode = 'login';

function authedFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...opts, headers }).then(async (r) => {
    if (r.status === 401) { logout(); throw new Error('unauthorized'); }
    return r;
  });
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  token = null;
  if (socket) { socket.disconnect(); socket = null; }
  document.getElementById('app').style.display = 'none';
  showLogin();
}

function showLogin()  { document.getElementById('login-overlay').style.display = 'flex'; }
function hideLogin()  { document.getElementById('login-overlay').style.display = 'none'; }

function decodeJwt(t) {
  try { return JSON.parse(atob(t.split('.')[1])); } catch { return {}; }
}

function setUserChip() {
  const { username = 'user' } = decodeJwt(token);
  document.getElementById('user-name').textContent = username;
  document.getElementById('user-avatar').textContent = (username[0] || '?').toUpperCase();
}

// ── Cameras (live, in-memory) ────────────────────────────
const cameras = new Map(); // streamId -> { tile/video/canvas/etc., status }
const grid = document.getElementById('grid');

// Detection events arrive at T + AI_processing (~250ms). The same frame is
// shown to the user at T + display_latency (WebRTC ~150ms, HLS ~1500ms).
// To make boxes line up with the visible frame, we delay drawing by
// (display_latency - AI_processing) — never negative.
const AI_PROCESSING_OFFSET_MS = 250;

function detectionSyncDelay(cam) {
  if (!cam) return 0;
  if (cam.transport === 'webrtc') {
    // WebRTC display ≈ AI offset, so boxes already align without extra wait.
    return 50;
  }
  if (cam.transport === 'hls' && cam.hls && typeof cam.hls.latency === 'number') {
    return Math.max(0, Math.round(cam.hls.latency * 1000) - AI_PROCESSING_OFFSET_MS);
  }
  // Transport not yet decided — match the old conservative HLS default.
  return 1200;
}

const DETECTION_COLORS = {
  recognized: '#10b981',
  face:       '#3b82f6',
  person:     '#f59e0b',
  incident:   '#ef4444',
  loitering:  '#fb923c',   // orange — attention but softer than fire red
  vehicle:    '#94a3b8',
  plate:      '#22d3ee',   // cyan — reads well over both dark and light plates
};

// Box color when a recognized face has an enrollment category. Falls back to
// the generic "recognized" green when type is missing or 'standard'.
const PERSON_TYPE_COLORS = {
  threat:   '#ef4444',
  vip:      '#f59e0b',
  staff:    '#3b82f6',
  visitor:  '#a1a1aa',
  standard: '#10b981',
};

function colorForDetection(d) {
  if (d.loitering) return DETECTION_COLORS.loitering;
  if (d.label === 'plate')   return DETECTION_COLORS.plate;
  if (d.label === 'vehicle') return DETECTION_COLORS.vehicle;
  if (d.name && d.label === 'face') {
    return PERSON_TYPE_COLORS[d.personType] || DETECTION_COLORS.recognized;
  }
  return d.label === 'person' ? DETECTION_COLORS.person : DETECTION_COLORS.face;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtTimestamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const date = d.toISOString().slice(0, 10);
  const time = d.toLocaleTimeString([], { hour12: true });
  return `${date} ${time}`;
}

// Compact absolute "May 10, 1:42:18 PM" — for stat tiles where the user wants
// the precise moment something happened (not just "12 minutes ago").
function fmtAbsoluteShort(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
// Full "Monday, May 10, 2026 1:42:18 PM" — used as a hover tooltip.
function fmtAbsoluteFull(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' });
}

function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ── Socket lifecycle ─────────────────────────────────────
function connectSocket() {
  socket = io(API, { auth: { token } });

  socket.on('connect_error', (err) => {
    if (err && /unauthorized/i.test(err.message || '')) logout();
  });

  socket.on('face_detections', ({ streamId, detections }) => {
    const cam = cameras.get(streamId);
    if (!cam) return;
    setTimeout(() => {
      if (cam.removed) return;
      cam.lastDetections = detections;
      cam.lastUpdate = Date.now();
      drawDetections(cam);
    }, detectionSyncDelay(cam));
  });

  socket.on('incident_detections', ({ streamId, incidents }) => {
    const cam = cameras.get(streamId);
    if (!cam) return;
    setTimeout(() => {
      if (cam.removed) return;
      cam.lastIncidents = incidents;
      cam.lastIncidentUpdate = Date.now();
      drawDetections(cam);
    }, detectionSyncDelay(cam));
  });

  socket.on('incident_logged', (row) => {
    // Dashboard "Recent Events" card shows all detection types.
    prependEvent(row);
    // "Recent Incidents" rail + bell + nav badge are strictly fire/smoke.
    if (isIncident(row)) {
      prependAlert(row);
      bumpBadge('bell-badge');
      bumpBadge('nav-incidents-badge');
    }
  });

  socket.on('agent_status', ({ message }) => {
    const modal = document.getElementById('agent-modal');
    if (modal && modal.style.display === 'flex') {
      const desc = modal.querySelector('.modal-desc');
      if (desc) desc.textContent = message;
    }
  });

  // Offline video analyzer progress. The analyze module (below) is a plain
  // object we hang on window so this listener works even when the Analyze
  // page hasn't been rendered yet in the DOM.
  socket.on('analyze_progress', (msg) => {
    if (window.analyzeModule) window.analyzeModule.onProgress(msg);
  });
}

// ── Camera tile ──────────────────────────────────────────
function makeTile(streamId, cameraName, rawHlsUrl) {
  let hlsUrl = rawHlsUrl;
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    hlsUrl = hlsUrl.replace('localhost', window.location.hostname).replace('127.0.0.1', window.location.hostname);
  }

  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.innerHTML = `
    <div class="tile-head">
      <span class="tile-name"></span>
      <span class="tile-status connecting">
        <span class="dot"></span>
        <span class="status-label">Connecting</span>
        <span class="tile-latency" title="Latency behind live"></span>
      </span>
      <button class="tile-more" title="Camera options"><svg><use href="#i-more-vert"/></svg></button>
    </div>
    <div class="video-wrap">
      <video autoplay muted playsinline crossorigin="anonymous"></video>
      <canvas></canvas>
      <div class="tile-timestamp">—</div>
      <div class="tile-rec-badge"><span class="rec-dot"></span>REC <span class="rec-elapsed">0:00</span></div>
      <div class="tile-controls">
        <button class="rec" title="Start recording"><svg><use href="#i-record"/></svg></button>
        <button class="screenshot" title="Screenshot"><svg><use href="#i-screenshot"/></svg></button>
        <button class="fullscreen" title="Fullscreen"><svg><use href="#i-fullscreen"/></svg></button>
      </div>
    </div>
  `;
  tile.querySelector('.tile-name').textContent = cameraName;
  grid.appendChild(tile);

  const video = tile.querySelector('video');
  const canvas = tile.querySelector('canvas');
  const statusPill = tile.querySelector('.tile-status');
  const statusLabel = tile.querySelector('.status-label');
  const latencyEl = tile.querySelector('.tile-latency');
  const tsEl = tile.querySelector('.tile-timestamp');
  const recButton = tile.querySelector('.rec');
  const recBadge = tile.querySelector('.tile-rec-badge');
  const recElapsed = tile.querySelector('.rec-elapsed');

  const cam = {
    streamId, cameraName, tile, video, canvas, statusPill, statusLabel, latencyEl, tsEl,
    recButton, recBadge, recElapsed,
    hlsUrl, transport: null,
    state: 'connecting',
    lastDetections: [], lastUpdate: 0,
    lastIncidents: [], lastIncidentUpdate: 0,
  };
  cameras.set(streamId, cam);

  video.addEventListener('playing', () => setTileStatus(cam, 'live'));
  video.addEventListener('waiting', () => setTileStatus(cam, 'connecting'));
  video.addEventListener('error',   () => setTileStatus(cam, 'offline'));

  tile.querySelector('.tile-more').addEventListener('click', (e) => openTileMenu(streamId, e.currentTarget));
  tile.querySelector('.fullscreen').addEventListener('click', () => fullscreenTile(streamId));
  tile.querySelector('.screenshot').addEventListener('click', () => screenshotTile(streamId));
  recButton.addEventListener('click', () => toggleRecording(streamId));

  // Choose transport: WebRTC first, HLS fallback. Stored on cam so the
  // reconnect/ICE handlers can re-trigger startStream without re-deriving them.
  const pathName = (rawHlsUrl.match(/\/([^/]+)\/?$/) || [])[1];
  cam.pathName = pathName;
  startStream(cam, hlsUrl, pathName);

  video.addEventListener('loadedmetadata', () => resizeCanvas(cam));
  video.addEventListener('playing',        () => resizeCanvas(cam));
  window.addEventListener('resize',         () => resizeCanvas(cam));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => resizeCanvas(cam));
    ro.observe(video);
    cam.resizeObserver = ro;
  }

  cam.tsTimer = setInterval(() => { tsEl.textContent = fmtTimestamp(); }, 1000);

  cam.latencyTimer = setInterval(() => updateLatency(cam), 1000);
  updateLatency(cam);

  cam.clearTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    if (now - cam.lastUpdate > 1000 && cam.lastDetections.length) {
      cam.lastDetections = []; changed = true;
    }
    if (now - cam.lastIncidentUpdate > 2000 && cam.lastIncidents.length) {
      cam.lastIncidents = []; changed = true;
    }
    if (changed) drawDetections(cam);
  }, 500);

  refreshCameraStatus();
  return cam;
}

// ── Stream transport: WebRTC primary, HLS fallback, with retry/upgrade ─
const RECONNECT_DELAY_MS = 5000;  // when both transports fail, retry whole flow this often
const PROMOTE_DELAY_MS   = 8000;  // while on HLS, retry WebRTC this often (free upgrade if it works)

async function probeManifest(hlsUrl) {
  try {
    const r = await fetch(hlsUrl + 'index.m3u8', { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

function teardownTransports(cam) {
  teardownWebRTC(cam);
  if (cam.hls) { try { cam.hls.destroy(); } catch {} cam.hls = null; }
  if (cam.stallWatchdog) { clearInterval(cam.stallWatchdog); cam.stallWatchdog = null; }
}

function clearReconnectTimers(cam) {
  if (cam.reconnectTimer) { clearTimeout(cam.reconnectTimer); cam.reconnectTimer = null; }
  if (cam.promoteTimer)   { clearTimeout(cam.promoteTimer);   cam.promoteTimer   = null; }
}

function scheduleReconnect(cam, hlsUrl, pathName, delay = RECONNECT_DELAY_MS) {
  if (cam.removed) return;
  clearTimeout(cam.reconnectTimer);
  cam.reconnectTimer = setTimeout(() => startStream(cam, hlsUrl, pathName), delay);
}

function schedulePromote(cam, hlsUrl, pathName) {
  if (cam.removed) return;
  clearTimeout(cam.promoteTimer);
  cam.promoteTimer = setTimeout(async () => {
    if (cam.removed || cam.transport !== 'hls') return;
    try {
      // Probe WebRTC silently; on success, srcObject takes over and we kill HLS.
      await startWebRTC(cam, pathName);
      if (cam.hls) { try { cam.hls.destroy(); } catch {} cam.hls = null; }
      if (cam.stallWatchdog) { clearInterval(cam.stallWatchdog); cam.stallWatchdog = null; }
      cam.transport = 'webrtc';
      console.log(`[${cam.cameraName}] upgraded HLS → WebRTC`);
    } catch {
      teardownWebRTC(cam);
      schedulePromote(cam, hlsUrl, pathName);
    }
  }, PROMOTE_DELAY_MS);
}

async function startStream(cam, hlsUrl, pathName) {
  if (cam.removed) return;
  clearReconnectTimers(cam);
  teardownTransports(cam);
  cam.transport = null;

  // 1. WebRTC
  if (window.RTCPeerConnection && pathName) {
    try {
      await startWebRTC(cam, pathName);
      cam.transport = 'webrtc';
      console.log(`[${cam.cameraName}] using WebRTC`);
      return;
    } catch (err) {
      console.warn(`[${cam.cameraName}] WebRTC unavailable (${err.message})`);
      teardownWebRTC(cam);
    }
  }

  // 2. HLS — only attach if the manifest is actually there, to avoid hls.js
  // spinning on 404s when there's no publisher.
  if (await probeManifest(hlsUrl)) {
    startHLS(cam, hlsUrl);
    cam.transport = 'hls';
    console.log(`[${cam.cameraName}] using HLS`);
    schedulePromote(cam, hlsUrl, pathName);
    return;
  }

  // 3. Nothing available — keep retrying quietly.
  console.log(`[${cam.cameraName}] no stream yet; retrying in ${RECONNECT_DELAY_MS / 1000}s`);
  scheduleReconnect(cam, hlsUrl, pathName);
}

async function startWebRTC(cam, pathName) {
  const url = `${WEBRTC_BASE}/${pathName}/whep`;
  // Empty iceServers = host-candidate-only ICE. Works on the same LAN with no
  // internet (same machine or same WiFi). For deployments behind NAT or across
  // the public internet, add a STUN/TURN server here.
  const pc = new RTCPeerConnection({ iceServers: [] });
  cam.pc = pc;

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const trackPromise = new Promise((resolve) => {
    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) {
        cam.video.srcObject = ev.streams[0];
        // Minimum jitter buffer — saves ~200-500ms of glass-to-glass latency
        // on a healthy LAN. Browsers may ignore values they consider unsafe.
        try { ev.receiver.playoutDelayHint = 0; } catch {}
        resolve();
      }
    };
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering with a hard cap so failure is fast.
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(resolve, 1500);
  });

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  if (!r.ok) throw new Error(`WHEP HTTP ${r.status}`);
  const answer = await r.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  // If the connection drops mid-stream, kick the unified retry loop.
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.warn(`[${cam.cameraName}] WebRTC ICE ${pc.iceConnectionState} — reconnecting`);
      scheduleReconnect(cam, cam.hlsUrl, cam.pathName, 1000);
    }
  });

  // Wait until a track actually arrives, otherwise treat as failure.
  await Promise.race([
    trackPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no track within 4s')), 4000)),
  ]);
}

function teardownWebRTC(cam) {
  if (cam.pc) { try { cam.pc.close(); } catch {} cam.pc = null; }
  if (cam.video) cam.video.srcObject = null;
}

function startHLS(cam, hlsUrl) {
  const video = cam.video;
  const src = hlsUrl + 'index.m3u8';
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: true, enableWorker: true,
      backBufferLength: 0, maxBufferLength: 4, maxMaxBufferLength: 8,
      liveSyncDuration: 0.5, liveMaxLatencyDuration: 2,
      liveDurationInfinity: true, maxLiveSyncPlaybackRate: 2.0,
      manifestLoadingMaxRetry: 10,
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    cam.hls = hls;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      // Network or other fatal: punt to the unified reconnect flow.
      // probeManifest() will gate when we re-attach hls.js, avoiding 404 spam.
      console.warn(`[${cam.cameraName}] HLS fatal (${data.type}); reconnecting`);
      scheduleReconnect(cam, cam.hlsUrl, cam.pathName, 2000);
    });
    let lastT = 0, stalled = 0;
    cam.stallWatchdog = setInterval(() => {
      if (video.paused || video.ended) return;
      if (video.currentTime === lastT) {
        stalled += 1;
        if (stalled >= 4 && hls.liveSyncPosition != null) {
          video.currentTime = hls.liveSyncPosition;
          video.play().catch(() => {});
          stalled = 0;
        }
      } else { stalled = 0; lastT = video.currentTime; }
    }, 1000);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
  }
}

function setTileStatus(cam, state) {
  cam.state = state;
  cam.statusPill.classList.remove('live', 'connecting', 'offline');
  cam.statusPill.classList.add(state);
  cam.statusLabel.textContent = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline';
  updateLatency(cam);
  refreshCameraStatus();
}

async function updateLatency(cam) {
  if (!cam.latencyEl) return;
  cam.latencyEl.classList.remove('warn', 'bad');

  if (cam.state !== 'live') {
    cam.latencyEl.textContent = '';
    return;
  }

  if (cam.transport === 'webrtc' && cam.pc) {
    let rtt = null, jitter = null;
    try {
      const stats = await cam.pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
          rtt = report.currentRoundTripTime;
        } else if (report.type === 'inbound-rtp' && report.kind === 'video' && report.jitter != null) {
          jitter = report.jitter;
        }
      });
    } catch { /* ignore */ }
    if (rtt == null) { cam.latencyEl.textContent = 'RTC · —'; return; }
    const ms = Math.round(rtt * 1000);
    cam.latencyEl.textContent = `RTC · ${ms} ms`;
    if (ms > 800) cam.latencyEl.classList.add('bad');
    else if (ms > 300) cam.latencyEl.classList.add('warn');
    return;
  }

  if (cam.transport === 'hls' && cam.hls && typeof cam.hls.latency === 'number' && isFinite(cam.hls.latency)) {
    const s = cam.hls.latency;
    cam.latencyEl.textContent = s < 1 ? `HLS · ${Math.round(s * 1000)} ms` : `HLS · ${s.toFixed(1)} s`;
    if (s > 5) cam.latencyEl.classList.add('bad');
    else if (s > 2) cam.latencyEl.classList.add('warn');
    return;
  }

  cam.latencyEl.textContent = '';
}

function resizeCanvas(cam) {
  const rect = cam.video.getBoundingClientRect();
  if (!rect.width) return;
  cam.canvas.width = rect.width;
  cam.canvas.height = rect.height;
  drawDetections(cam);
}

function drawBox(ctx, x, y, w, h, color) {
  ctx.lineWidth = 1.5; ctx.strokeStyle = color;
  ctx.strokeRect(x, y, w, h);
}
function drawLabel(ctx, x, y, text, color, height = 18) {
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  const padX = 6;
  const tw = ctx.measureText(text).width;
  const ly = Math.max(0, y - height);
  ctx.fillStyle = color;
  ctx.fillRect(x, ly, tw + padX * 2, height);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, ly + height / 2);
}
function drawDetections(cam) {
  const { canvas, lastDetections, lastIncidents, tile } = cam;
  // Self-heal: if the canvas hasn't been sized yet (e.g., WebRTC track arrived
  // after our initial sizing pass), size it now before we try to draw.
  if (!canvas.width || !canvas.height) resizeCanvas(cam);
  if (!canvas.width || !canvas.height) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const d of lastDetections) {
    const x = d.x * canvas.width, y = d.y * canvas.height;
    const w = d.w * canvas.width, h = d.h * canvas.height;
    const color = colorForDetection(d);
    // Threats get a thicker, more attention-grabbing border.
    if (d.personType === 'threat') ctx.lineWidth = 3; else ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    let tag;
    if (d.loitering) {
      tag = `LOITERING ${d.dwellSeconds != null ? d.dwellSeconds + 's' : ''}`.trim();
    } else if (d.label === 'plate') {
      tag = d.name ? `PLATE ${d.name}` : 'PLATE';
    } else if (d.label === 'vehicle') {
      tag = d.vehicleType || 'vehicle';
    } else if (d.name && d.personType && d.personType !== 'standard') {
      tag = `${d.name} · ${d.personType}`;
    } else {
      tag = d.name || d.label;
    }
    const label = `${tag} · ${Math.round(d.confidence * 100)}%`;
    drawLabel(ctx, x, y, label, color);
  }
  for (const inc of lastIncidents) {
    const [x1, y1, x2, y2] = inc.box;
    const x = x1 * canvas.width, y = y1 * canvas.height;
    const w = (x2 - x1) * canvas.width, h = (y2 - y1) * canvas.height;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = DETECTION_COLORS.incident;
    ctx.strokeRect(x, y, w, h);
    drawLabel(ctx, x, y, `${inc.type} · ${Math.round((inc.confidence || 0) * 100)}%`, DETECTION_COLORS.incident, 20);
  }
  tile.classList.toggle('incident-alert', lastIncidents.length > 0);
}

// ── Tile context menu ────────────────────────────────────
const tileMenu = document.getElementById('tile-menu');
let menuStreamId = null;
function openTileMenu(streamId, anchor) {
  menuStreamId = streamId;
  const r = anchor.getBoundingClientRect();
  tileMenu.style.display = 'flex';
  tileMenu.style.top = `${r.bottom + 4}px`;
  tileMenu.style.left = `${Math.max(8, r.right - tileMenu.offsetWidth)}px`;
}
function closeTileMenu() { tileMenu.style.display = 'none'; menuStreamId = null; }
document.addEventListener('click', (e) => {
  if (!tileMenu.contains(e.target) && !e.target.closest('.tile-more')) closeTileMenu();
});
tileMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !menuStreamId) return;
  const action = btn.dataset.action;
  const sid = menuStreamId;
  closeTileMenu();
  if (action === 'remove') await removeCamera(sid);
  else if (action === 'screenshot') screenshotTile(sid);
  else if (action === 'fullscreen') fullscreenTile(sid);
});

function fullscreenTile(streamId) {
  const cam = cameras.get(streamId);
  if (!cam) return;
  const wrap = cam.video.parentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  // Toggle: same wrap already fullscreen → exit; otherwise enter. Without
  // this, clicking the button while fullscreen is a no-op (the user's
  // "minimize doesn't work" report).
  if (fsEl === wrap) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen)?.call(wrap);
  }
}

// Swap each tile's button icon between expand/minimize based on the current
// fullscreen element. Covers ESC-to-exit as well as the button click path.
function syncTileFullscreenIcons() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  document.querySelectorAll('.video-wrap .fullscreen').forEach((btn) => {
    const wrap = btn.closest('.video-wrap');
    const isFs = wrap && wrap === fsEl;
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', isFs ? '#i-minimize' : '#i-fullscreen');
    btn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
  });
}
document.addEventListener('fullscreenchange', syncTileFullscreenIcons);
document.addEventListener('webkitfullscreenchange', syncTileFullscreenIcons);
// ── Recording (browser-side via MediaRecorder) ───────────
const REC_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

function pickRecordingMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of REC_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function getStreamFromVideo(video) {
  // WebRTC: video.srcObject is already a MediaStream
  if (video.srcObject instanceof MediaStream) return video.srcObject;
  // HLS via MSE: synthesize a MediaStream from the playing video element
  if (typeof video.captureStream === 'function')    return video.captureStream();
  if (typeof video.mozCaptureStream === 'function') return video.mozCaptureStream();
  return null;
}

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toggleRecording(streamId) {
  const cam = cameras.get(streamId);
  if (!cam) return;
  if (cam.recorder && cam.recorder.state === 'recording') stopRecording(cam);
  else startRecording(cam);
}

function startRecording(cam) {
  if (typeof MediaRecorder === 'undefined') {
    alert('Your browser does not support MediaRecorder.');
    return;
  }
  if (cam.state !== 'live' || !cam.video.videoWidth) {
    alert('Camera is not live yet — wait until you see the video before recording.');
    return;
  }
  const stream = getStreamFromVideo(cam.video);
  if (!stream) {
    alert('Recording is not supported for this stream type in this browser.');
    return;
  }
  const mime = pickRecordingMime();
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (err) {
    alert(`Could not start recorder: ${err.message}`);
    return;
  }

  cam.recorder = recorder;
  cam.recordChunks = [];
  cam.recordStartedAt = Date.now();
  cam.recordMime = mime || 'video/webm';

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) cam.recordChunks.push(e.data);
  };
  recorder.onerror = (e) => {
    console.error('[Recorder] error', e);
    alert(`Recording error: ${e.error?.message || 'unknown'}`);
    stopRecording(cam);
  };
  recorder.onstop = () => {
    finalizeRecording(cam);
  };

  recorder.start(1000); // chunks every 1s — keeps memory bounded for long recordings
  cam.recButton.classList.add('recording');
  cam.recButton.title = 'Stop recording';
  cam.recBadge.classList.add('show');
  cam.recElapsed.textContent = '0:00';
  cam.recTimer = setInterval(() => {
    cam.recElapsed.textContent = fmtElapsed(Date.now() - cam.recordStartedAt);
  }, 500);
}

function stopRecording(cam) {
  if (cam.recTimer) { clearInterval(cam.recTimer); cam.recTimer = null; }
  cam.recButton.classList.remove('recording');
  cam.recButton.title = 'Start recording';
  cam.recBadge.classList.remove('show');
  if (cam.recorder && cam.recorder.state !== 'inactive') {
    try { cam.recorder.stop(); } catch { /* already stopped */ }
  }
}

function finalizeRecording(cam) {
  const chunks = cam.recordChunks || [];
  cam.recorder = null;
  cam.recordChunks = [];
  if (chunks.length === 0) return;
  const blob = new Blob(chunks, { type: cam.recordMime });
  const url = URL.createObjectURL(blob);
  const ext = (cam.recordMime || '').includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date(cam.recordStartedAt).toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${cam.cameraName.replace(/\s+/g, '_')}-${stamp}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function screenshotTile(streamId) {
  const cam = cameras.get(streamId);
  if (!cam) return;
  const v = cam.video;
  if (!v.videoWidth || !v.videoHeight) {
    alert('Stream not playing yet — try again once the tile shows Live.');
    return;
  }

  const cnv = document.createElement('canvas');
  cnv.width = v.videoWidth;
  cnv.height = v.videoHeight;
  const ctx = cnv.getContext('2d');

  try {
    ctx.drawImage(v, 0, 0, cnv.width, cnv.height);
    // Layer detection overlays at video resolution so they look right in the export.
    if (cam.canvas.width && cam.canvas.height) {
      ctx.drawImage(cam.canvas, 0, 0, cnv.width, cnv.height);
    }
  } catch (err) {
    console.error('[Screenshot] drawImage failed:', err);
    alert('Could not capture frame: the video is cross-origin tainted. Reload the page and try again — the fix is now live.');
    return;
  }

  // Burn-in caption
  const caption = `${cam.cameraName} · ${fmtTimestamp()}`;
  ctx.font = 'bold 16px Inter, system-ui, sans-serif';
  const padX = 12, padY = 8;
  const textW = ctx.measureText(caption).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, cnv.height - 36, textW + padX * 2, 28);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption, 8 + padX, cnv.height - 36 + 14);

  try {
    cnv.toBlob((blob) => {
      if (!blob) { alert('Screenshot failed.'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${cam.cameraName.replace(/\s+/g, '_')}-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }, 'image/png');
  } catch (err) {
    console.error('[Screenshot] toBlob failed:', err);
    alert('Could not export PNG (canvas tainted). Reload the page after the latest update and try again.');
  }
}

async function addCamera({ cameraName, rtspUrl, lat, lng }) {
  const r = await authedFetch(`${API}/add-camera`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraName, rtspUrl, lat, lng }),
  });
  if (!r.ok) { alert(`Add camera failed: ${await r.text()}`); return; }
  const { streamId, hlsUrl, streamKey, agentStarted } = await r.json();
  makeTile(streamId, cameraName, hlsUrl);
  showAgentModal(streamKey, rtspUrl, agentStarted);
  refreshCamerasTable();
}

async function removeCamera(streamId) {
  const cam = cameras.get(streamId);
  if (!cam) return;
  cam.removed = true;
  // Stop & download any in-progress recording before tearing the stream down,
  // so the user doesn't lose the footage they were capturing.
  if (cam.recorder && cam.recorder.state === 'recording') stopRecording(cam);
  clearReconnectTimers(cam);
  await authedFetch(`${API}/camera/${streamId}`, { method: 'DELETE' });
  teardownTransports(cam);
  if (cam.resizeObserver) { cam.resizeObserver.disconnect(); cam.resizeObserver = null; }
  if (cam.clearTimer) clearInterval(cam.clearTimer);
  if (cam.tsTimer) clearInterval(cam.tsTimer);
  if (cam.latencyTimer) clearInterval(cam.latencyTimer);
  cam.tile.remove();
  cameras.delete(streamId);
  refreshCameraStatus();
  refreshCamerasTable();
}

// ── Camera status donut & legend ─────────────────────────
function refreshCameraStatus() {
  const counts = { live: 0, connecting: 0, offline: 0 };
  for (const cam of cameras.values()) counts[cam.state] = (counts[cam.state] || 0) + 1;
  const total = counts.live + counts.connecting + counts.offline;
  document.getElementById('cam-total').textContent = total;
  document.getElementById('cam-live').textContent = counts.live;
  document.getElementById('cam-connecting').textContent = counts.connecting;
  document.getElementById('cam-offline').textContent = counts.offline;

  document.getElementById('cam-online-label').textContent =
    `${counts.live} ${counts.live === 1 ? 'camera' : 'cameras'} online`;
  document.getElementById('sb-cams-online').textContent = counts.live;
  document.getElementById('sb-cams-total').textContent  = total;

  drawDonut('cam-donut', total === 0
    ? [{ value: 1, color: 'rgba(255,255,255,0.06)' }]
    : [
        { value: counts.live,       color: 'var(--success)' },
        { value: counts.connecting, color: 'var(--warning)' },
        { value: counts.offline,    color: '#3a3a40' },
      ].filter(s => s.value > 0));
}

// ── Donut renderer (segmented) ───────────────────────────
function drawDonut(svgId, segments) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  const cx = 50, cy = 50, r = 38, sw = 14;
  // Background ring
  const bg = document.createElementNS(NS, 'circle');
  bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke', 'rgba(255,255,255,0.04)');
  bg.setAttribute('stroke-width', sw);
  svg.appendChild(bg);

  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const c = 2 * Math.PI * r;
  let offset = 0;
  for (const seg of segments) {
    const len = (seg.value / total) * c;
    const arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', cx); arc.setAttribute('cy', cy); arc.setAttribute('r', r);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', seg.color);
    arc.setAttribute('stroke-width', sw);
    arc.setAttribute('stroke-dasharray', `${len} ${c - len}`);
    arc.setAttribute('stroke-dashoffset', `${-offset}`);
    arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    svg.appendChild(arc);
    offset += len;
  }
}

// ── Recent events (dashboard card) ───────────────────────
const MAX_EVENTS = 5;
const EVENT_TITLES = {
  fire:      'Fire Detected',
  smoke:     'Smoke Detected',
  face:      'Face Detected',
  person:    'Motion Detected',
  loitering: 'Loitering Detected',
  plate:     'License Plate Read',
};

// Shared tile-layer config for every Leaflet map in the app. CartoDB's Dark
// Matter palette matches the dashboard's dark theme and ships from a
// different CDN than tile.openstreetmap.org (which is sometimes throttled
// or blocked by ad blockers / corporate firewalls — symptom: black map).
const DARK_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const DARK_TILE_OPTS = {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '© OpenStreetMap, © CARTO',
};
function attachDarkTiles(map) {
  const layer = L.tileLayer(DARK_TILE_URL, DARK_TILE_OPTS);
  // On failure, log once so we can spot blocked-tile-CDN cases instead of
  // staring at a black square.
  let warned = false;
  layer.on('tileerror', () => {
    if (!warned) {
      warned = true;
      console.warn('[Leaflet] tile load failed — check network / firewall. Map shows fallback colour.');
    }
  });
  layer.addTo(map);
  return layer;
}

function eventIconHtml(type) {
  const symId = type === 'fire' || type === 'smoke' ? '#i-fire'
    : type === 'face' ? '#i-users'
    : type === 'person' ? '#i-running'
    : type === 'loitering' ? '#i-running'
    : type === 'plate' ? '#i-car'
    : '#i-bell';
  return `<span class="event-icon ${type}"><svg><use href="${symId}"/></svg></span>`;
}

function snapshotUrl(snapshot) {
  if (!snapshot) return null;
  // snapshot path comes from the AI worker as "<streamId>/<file>.jpg".
  // Route mounts on /snapshot/:streamId/:file so we just concat.
  return `${API}/snapshot/${snapshot}?token=${encodeURIComponent(token)}`;
}

// Lightboxes for full-size snapshot view on click.
function openSnapshotLightbox(url, caption) {
  let box = document.getElementById('snapshot-lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'snapshot-lightbox';
    box.className = 'modal-overlay';
    box.innerHTML = `
      <div class="snapshot-lightbox-box">
        <img alt="Snapshot">
        <div class="snapshot-lightbox-cap"></div>
      </div>`;
    box.addEventListener('click', () => { box.style.display = 'none'; });
    document.body.appendChild(box);
  }
  box.querySelector('img').src = url;
  box.querySelector('.snapshot-lightbox-cap').textContent = caption || '';
  box.style.display = 'flex';
}

function snapshotThumbEl(snapshot, caption) {
  if (!snapshot) return null;
  const img = document.createElement('img');
  img.className = 'event-thumb';
  img.src = snapshotUrl(snapshot);
  img.alt = caption || 'snapshot';
  img.title = caption || 'Snapshot';
  img.loading = 'lazy';
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    openSnapshotLightbox(img.src, caption);
  });
  return img;
}

function buildEventRow(row) {
  const li = document.createElement('li');
  li.innerHTML = `
    ${eventIconHtml(row.type)}
    <span class="event-text"></span>
    <span class="event-time"></span>
  `;
  const text = li.querySelector('.event-text');
  const title = document.createElement('span');
  title.textContent = EVENT_TITLES[row.type] || row.type;
  text.appendChild(title);
  if (row.cameraName || row.name) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = '· ' + (row.name ? `${row.name} @ ${row.cameraName || ''}` : row.cameraName);
    text.appendChild(sub);
  }
  const thumb = snapshotThumbEl(row.snapshot,
    `${EVENT_TITLES[row.type] || row.type} · ${row.cameraName || ''}`);
  if (thumb) li.insertBefore(thumb, li.querySelector('.event-time'));
  li.querySelector('.event-time').textContent = fmtTime(row.createdAt);
  return li;
}

function prependEvent(row) {
  const ul = document.getElementById('event-list');
  ul.querySelector('.event-empty')?.remove();
  ul.prepend(buildEventRow(row));
  while (ul.children.length > MAX_EVENTS) ul.removeChild(ul.lastChild);
}

// ── Recent alerts (right rail) ───────────────────────────
const MAX_ALERTS = 4;
function buildAlertRow(row) {
  const li = document.createElement('li');
  li.innerHTML = `
    ${eventIconHtml(row.type)}
    <div class="alert-meta">
      <div class="alert-title"></div>
      <div class="alert-sub"></div>
    </div>
    <div class="alert-time"></div>
  `;
  li.querySelector('.alert-title').textContent = EVENT_TITLES[row.type] || row.type;
  const sub = li.querySelector('.alert-sub');
  sub.textContent = row.name ? `${row.name} · ${row.cameraName || ''}` : (row.cameraName || row.streamId);
  const thumb = snapshotThumbEl(row.snapshot,
    `${EVENT_TITLES[row.type] || row.type} · ${row.cameraName || ''}`);
  if (thumb) li.insertBefore(thumb, li.querySelector('.alert-time'));
  li.querySelector('.alert-time').textContent = fmtTime(row.createdAt);
  return li;
}
function prependAlert(row) {
  const ul = document.getElementById('alerts-list');
  ul.querySelector('.event-empty')?.remove();
  ul.prepend(buildAlertRow(row));
  while (ul.children.length > MAX_ALERTS) ul.removeChild(ul.lastChild);
}

// ── Badges ───────────────────────────────────────────────
function bumpBadge(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = (parseInt(el.textContent) || 0) + 1;
  el.textContent = n;
  el.dataset.zero = 'false';
}
function setBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n;
  el.dataset.zero = n === 0 ? 'true' : 'false';
}

// ── Cameras table page ───────────────────────────────────
function fmtLatency(s) {
  if (typeof s !== 'number' || !isFinite(s)) return '—';
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`;
}

async function refreshCamerasTable() {
  const tbody = document.querySelector('#cameras-table tbody');
  if (!tbody) return;
  const list = await (await authedFetch(`${API}/cameras`)).json();
  tbody.innerHTML = '';
  for (const c of list) {
    const cam = cameras.get(c.streamId);
    const state = cam?.state || 'connecting';
    const latency = cam?.hls?.latency;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td></td>
      <td><code style="color:var(--text-muted);font-size:12px"></code></td>
      <td><span class="status-pill ${state}"><span class="dot"></span><span></span></span></td>
      <td style="font-variant-numeric:tabular-nums"></td>
      <td><button class="row-action">Remove</button></td>
    `;
    tr.children[0].textContent = c.cameraName;
    tr.children[1].querySelector('code').textContent = c.rtspUrl;
    tr.children[2].querySelector('span > span').textContent = state[0].toUpperCase() + state.slice(1);
    tr.children[3].textContent = state === 'live' ? fmtLatency(latency) : '—';
    tr.querySelector('button').addEventListener('click', () => removeCamera(c.streamId));
    tbody.appendChild(tr);
  }
}

// ── Enrollments page ─────────────────────────────────────
const PERSON_TYPES = [
  { value: 'standard', label: 'Standard' },
  { value: 'staff',    label: 'Staff'    },
  { value: 'vip',      label: 'VIP'      },
  { value: 'visitor',  label: 'Visitor'  },
  { value: 'threat',   label: 'Threat'   },
];
const PERSON_TYPE_LABEL = Object.fromEntries(PERSON_TYPES.map((t) => [t.value, t.label]));

async function refreshEnrollments() {
  const ul = document.getElementById('enrollments');
  if (!ul) return;
  const list = await (await authedFetch(`${API}/enrollments`)).json();
  ul.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'enroll-empty';
    empty.textContent = 'No people enrolled yet. Add a person to enable face recognition.';
    ul.appendChild(empty);
    return;
  }
  for (const p of list) {
    ul.appendChild(buildEnrollmentCard(p));
  }
}

function buildEnrollmentCard(p) {
  const li = document.createElement('li');
  li.className = 'enroll-card';
  const niceName = p.name.replace(/_/g, ' ');

  const img = document.createElement('img');
  img.src = `${API}/enrollment/${encodeURIComponent(p.name)}/image?token=${encodeURIComponent(token)}`;
  img.alt = niceName;

  const meta = document.createElement('div');
  meta.className = 'enroll-meta';
  const nameEl = document.createElement('div');
  nameEl.className = 'enroll-name';
  nameEl.textContent = niceName;
  const sub = document.createElement('div');
  sub.className = 'enroll-sub';
  const typeBadge = document.createElement('span');
  typeBadge.className = `type-badge type-${p.type}`;
  typeBadge.textContent = PERSON_TYPE_LABEL[p.type] || p.type;
  const photos = document.createElement('span');
  photos.className = 'enroll-photo-count';
  photos.textContent = `${p.photoCount} photo${p.photoCount === 1 ? '' : 's'}`;
  sub.append(typeBadge, photos);
  meta.append(nameEl, sub);

  const actions = document.createElement('div');
  actions.className = 'enroll-actions';
  const actBtn = document.createElement('button');
  actBtn.className = 'enroll-action';
  actBtn.title = 'View activity history';
  actBtn.textContent = 'Activity';
  actBtn.addEventListener('click', () => openPersonActivity(p));

  const editBtn = document.createElement('button');
  editBtn.className = 'enroll-action';
  editBtn.title = 'Edit category';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => openEditEnrollment(p));
  const addBtn = document.createElement('button');
  addBtn.className = 'enroll-action';
  addBtn.title = 'Add more photos';
  addBtn.textContent = '+ Photos';
  addBtn.addEventListener('click', () => openAddPhotos(p));
  const delBtn = document.createElement('button');
  delBtn.className = 'enroll-action danger';
  delBtn.title = 'Remove person';
  delBtn.textContent = 'Remove';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Remove ${niceName} and all photos?`)) return;
    await authedFetch(`${API}/enrollment/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
    refreshEnrollments();
  });
  actions.append(actBtn, editBtn, addBtn, delBtn);

  li.append(img, meta, actions);
  return li;
}

// ── Add / Edit Person modal flows ────────────────────────
let enrollMode = 'add';   // 'add' | 'add-photos' | 'edit-type'
let enrollTarget = null;  // existing enrollment object when editing

function openAddPerson() {
  enrollMode = 'add';
  enrollTarget = null;
  const form = document.getElementById('enroll-form');
  form.reset();
  form.elements.name.disabled = false;
  document.getElementById('enroll-type').value = 'standard';
  document.getElementById('person-modal-title').textContent = 'Add person';
  document.getElementById('person-modal-desc').textContent =
    'Upload one or more clear front-facing photos. Multiple photos per person significantly improve recognition.';
  document.getElementById('enroll-submit').textContent = 'Enroll';
  document.getElementById('enroll-file-list').innerHTML = '';
  form.elements.images.required = true;
  openModal('add-person-modal');
}

function openEditEnrollment(p) {
  enrollMode = 'edit-type';
  enrollTarget = p;
  const form = document.getElementById('enroll-form');
  form.reset();
  form.elements.name.value = p.name.replace(/_/g, ' ');
  form.elements.name.disabled = true;
  document.getElementById('enroll-type').value = p.type || 'standard';
  document.getElementById('person-modal-title').textContent = 'Edit person';
  document.getElementById('person-modal-desc').textContent =
    'Change the category. Photos are unchanged — use “+ Photos” on the card to add more.';
  document.getElementById('enroll-submit').textContent = 'Save';
  document.getElementById('enroll-file-list').innerHTML = '';
  form.elements.images.required = false;
  openModal('add-person-modal');
}

function openAddPhotos(p) {
  enrollMode = 'add-photos';
  enrollTarget = p;
  const form = document.getElementById('enroll-form');
  form.reset();
  form.elements.name.value = p.name.replace(/_/g, ' ');
  form.elements.name.disabled = true;
  document.getElementById('enroll-type').value = p.type || 'standard';
  document.getElementById('person-modal-title').textContent = `Add photos — ${p.name.replace(/_/g, ' ')}`;
  document.getElementById('person-modal-desc').textContent =
    'Upload more reference photos. More photos under varied lighting/angles = stronger recognition.';
  document.getElementById('enroll-submit').textContent = 'Add photos';
  document.getElementById('enroll-file-list').innerHTML = '';
  form.elements.images.required = true;
  openModal('add-person-modal');
}

function readFilesAsDataURLs(fileList) {
  return Promise.all([...fileList].map((f) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(f);
  })));
}

// ── Events / Alerts page ─────────────────────────────────
function incidentTitle(row) {
  if (row.type === 'face' && row.name) return `Face Recognized`;
  if (row.type === 'plate' && row.name) return `Plate: ${row.name}`;
  return EVENT_TITLES[row.type] || row.type;
}
function incidentIconSym(row) {
  if (row.type === 'fire' || row.type === 'smoke') return '#i-fire';
  if (row.type === 'face') return '#i-users';
  if (row.type === 'loitering') return '#i-running';
  if (row.type === 'plate') return '#i-car';
  return '#i-bell';
}

async function refreshIncidentsTable() {
  const tbody = document.querySelector('#incidents-table tbody');
  if (!tbody) return;
  const list = await (await authedFetch(`${API}/incidents?limit=200&incidentsOnly=true`)).json();
  tbody.innerHTML = '';
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;font-style:italic">No incidents recorded yet — fire, smoke and recognized-face alerts will appear here.</td></tr>`;
    return;
  }
  for (const row of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td></td><td></td><td></td><td></td><td></td>`;

    const thumb = snapshotThumbEl(row.snapshot,
      `${incidentTitle(row)} · ${row.cameraName || ''}`);
    if (thumb) {
      thumb.classList.add('event-thumb-cell');
      tr.children[0].appendChild(thumb);
    } else {
      tr.children[0].textContent = '—';
      tr.children[0].style.color = 'var(--text-muted)';
    }

    const typeCell = document.createElement('span');
    typeCell.className = `event-icon ${row.type}`;
    typeCell.style.display = 'inline-grid';
    typeCell.innerHTML = `<svg><use href="${incidentIconSym(row)}"/></svg>`;
    tr.children[1].appendChild(typeCell);
    tr.children[1].appendChild(document.createTextNode(' ' + incidentTitle(row)));
    tr.children[2].textContent = row.cameraName || row.streamId;
    tr.children[3].textContent = row.name || '—';
    tr.children[4].textContent = row.confidence != null ? `${Math.round(row.confidence * 100)}%` : '—';
    tr.children[5].textContent = fmtTime(row.createdAt);
    tbody.appendChild(tr);
  }
}

// ── Features page (settings) ─────────────────────────────
function prettyFeatureName(slug) {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function refreshFeatures() {
  const ul = document.getElementById('features-list');
  if (!ul) return;
  const list = await (await authedFetch(`${API}/features`)).json();
  ul.innerHTML = '';
  for (const f of list) {
    const li = document.createElement('li');
    li.className = 'feature-item';
    li.innerHTML = `
      <label class="feature-toggle">
        <span class="feature-name"></span>
        <input type="checkbox" ${f.enabled ? 'checked' : ''}>
        <span class="switch"></span>
      </label>
      <small class="feature-desc"></small>
    `;
    li.querySelector('.feature-name').textContent = prettyFeatureName(f.name);
    li.querySelector('.feature-desc').textContent = f.description || '';
    li.querySelector('input').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const r = await authedFetch(`${API}/features/${encodeURIComponent(f.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) { e.target.checked = !enabled; alert('Toggle failed'); }
    });
    ul.appendChild(li);
  }
}

// ── Initial-load fillers for events & alerts ─────────────
async function loadInitialEvents() {
  // Dashboard "Recent Events" card: all detection types (face/person/fire/smoke).
  const allList = await (await authedFetch(`${API}/incidents?limit=20`)).json();
  // Recent Incidents rail + badges: fire/smoke OR recognized faces.
  const incidentList = await (await authedFetch(`${API}/incidents?limit=20&incidentsOnly=true`)).json();

  const ev = document.getElementById('event-list');
  const al = document.getElementById('alerts-list');
  ev.innerHTML = ''; al.innerHTML = '';

  if (allList.length === 0) {
    ev.innerHTML = '<li class="event-empty">No events yet.</li>';
  } else {
    for (const row of allList.slice(0, MAX_EVENTS)) ev.appendChild(buildEventRow(row));
  }
  if (incidentList.length === 0) {
    al.innerHTML = '<li class="event-empty">No incidents yet.</li>';
  } else {
    for (const row of incidentList.slice(0, MAX_ALERTS)) al.appendChild(buildAlertRow(row));
  }
  setBadge('bell-badge', incidentList.length);
  setBadge('nav-incidents-badge', incidentList.length);
}

// ── Analytics ────────────────────────────────────────────
function setStat(id, value, deltaPct) {
  document.getElementById(id).textContent = value.toLocaleString();
  const d = document.getElementById(`${id}-delta`);
  if (!d) return;
  d.classList.remove('up', 'down', 'flat');
  if (Math.abs(deltaPct) < 0.5) {
    d.classList.add('flat');
    d.textContent = '0%';
  } else if (deltaPct > 0) {
    d.classList.add('up');
    d.textContent = `${deltaPct.toFixed(1)}%`;
  } else {
    d.classList.add('down');
    d.textContent = `${Math.abs(deltaPct).toFixed(1)}%`;
  }
}

async function refreshAnalytics() {
  const period = document.getElementById('analytics-period').value;
  const r = await (await authedFetch(`${API}/analytics?period=${period}`)).json();
  setStat('stat-people',     r.counts.people,     r.deltas.people);
  setStat('stat-recognized', r.counts.recognized, r.deltas.recognized);
  setStat('stat-events',     r.counts.events,     r.deltas.events);
  setStat('stat-alerts',     r.counts.alerts,     r.deltas.alerts);
}

// ── System health ────────────────────────────────────────
async function refreshSystemHealth() {
  let health = null;
  try { health = await (await authedFetch(`${API}/system-health`)).json(); }
  catch { return; }

  const mediamtx = health.mediamtx ? 100 : 0;
  const ai = health.aiWorker ? 100 : 0;
  const storagePct = health.storage ? Math.round((health.storage.used / health.storage.total) * 100) : 0;

  const setBar = (id, pct, severity) => {
    const bar = document.getElementById(`${id}-bar`);
    bar.style.width = `${pct}%`;
    bar.classList.remove('warning', 'danger', 'success');
    bar.classList.add(severity);
    document.getElementById(`${id}-pct`).textContent = `${pct}%`;
  };
  setBar('health-mediamtx', mediamtx, mediamtx === 100 ? 'success' : 'danger');
  setBar('health-ai', ai, ai === 100 ? 'success' : 'danger');
  setBar('health-storage', storagePct,
    storagePct >= 90 ? 'danger' : storagePct >= 75 ? 'warning' : 'success');

  const allUp = mediamtx === 100 && ai === 100 && storagePct < 90;
  const anyDown = mediamtx === 0 || ai === 0;
  const status = document.getElementById('health-status');
  const txt = document.getElementById('health-status-text');
  status.classList.remove('degraded', 'down');
  if (anyDown) { status.classList.add('down'); txt.textContent = 'Service degraded'; }
  else if (!allUp) { status.classList.add('degraded'); txt.textContent = 'Storage near capacity'; }
  else { txt.textContent = 'All systems operational'; }

  // Sidebar status card: storage + (synthetic) CPU from worker presence
  if (health.storage) {
    document.getElementById('sb-storage').textContent =
      `${fmtBytes(health.storage.used)} / ${fmtBytes(health.storage.total)}`;
    const sb = document.getElementById('sb-storage-bar');
    sb.style.width = `${storagePct}%`;
    sb.classList.remove('warning', 'danger', 'success');
    sb.classList.add(storagePct >= 90 ? 'danger' : storagePct >= 75 ? 'warning' : 'success');

    document.getElementById('storage-used').textContent  = fmtBytes(health.storage.used);
    document.getElementById('storage-total').textContent = fmtBytes(health.storage.total);
    document.getElementById('storage-free').textContent  = fmtBytes(health.storage.free);
    document.getElementById('storage-pct').textContent   = `${storagePct}%`;
    drawDonut('storage-donut', [
      { value: health.storage.used, color: storagePct >= 90 ? 'var(--danger)' : storagePct >= 75 ? 'var(--warning)' : 'var(--accent)' },
      { value: health.storage.free, color: '#2a2a30' },
    ]);
  }
  // CPU placeholder (we don't measure host CPU; show worker liveness as a rough proxy)
  const cpuPct = ai === 100 ? 45 : 0;
  document.getElementById('sb-cpu').textContent = `${cpuPct}%`;
  document.getElementById('sb-cpu-bar').style.width = `${cpuPct}%`;
}

// ── Analytics page (SVG charts) ──────────────────────────
const TYPE_COLORS = {
  fire:   'var(--danger)',
  smoke:  'var(--danger)',
  face:   'var(--success)',
  person: 'var(--warning)',
};

function heatmapColor(n, max) {
  if (n === 0 || max === 0) return 'rgba(255,255,255,0.04)';
  const t = Math.min(n / max, 1);
  // Mid-range = indigo, hot tail = red. Two-stop gradient.
  if (t < 0.7) return `rgba(99, 102, 241, ${(0.18 + t * 0.85).toFixed(2)})`;
  return `rgba(239, 68, 68, ${(0.45 + (t - 0.7) * 1.5).toFixed(2)})`;
}

function renderHeatmap(rows) {
  const el = document.getElementById('chart-heatmap');
  if (!el) return;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const r of rows || []) {
    if (r.dow >= 0 && r.dow <= 6 && r.hour >= 0 && r.hour <= 23) {
      const n = Number(r.n);
      grid[r.dow][r.hour] = n;
      if (n > max) max = n;
    }
  }
  const cellW = 26, cellH = 22, gap = 2;
  const labelLeft = 36, labelTop = 18;
  const W = labelLeft + 24 * (cellW + gap);
  const H = labelTop + 7 * (cellH + gap);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const pieces = [];
  pieces.push(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`);
  for (let h = 0; h < 24; h += 3) {
    pieces.push(`<text x="${labelLeft + h * (cellW + gap) + cellW / 2}" y="${labelTop - 4}" text-anchor="middle" class="chart-label">${h}</text>`);
  }
  for (let d = 0; d < 7; d++) {
    const y = labelTop + d * (cellH + gap);
    pieces.push(`<text x="0" y="${y + cellH / 2 + 4}" class="chart-label">${days[d]}</text>`);
    for (let h = 0; h < 24; h++) {
      const x = labelLeft + h * (cellW + gap);
      const n = grid[d][h];
      pieces.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" fill="${heatmapColor(n, max)}"><title>${days[d]} ${h}:00 — ${n} event${n === 1 ? '' : 's'}</title></rect>`);
    }
  }
  pieces.push('</svg>');
  el.innerHTML = pieces.join('');
}

function renderDailyTrend(daily) {
  const el = document.getElementById('chart-daily');
  if (!el) return;
  if (!daily || daily.length === 0) {
    el.innerHTML = '<div class="chart-empty">No data yet.</div>';
    return;
  }
  const W = 720, H = 200, padX = 36, padY = 28;
  const max = Math.max(...daily.map((d) => d.n), 1);
  const innerW = W - 2 * padX, innerH = H - 2 * padY;
  const dx = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const xy = (i, val) => [padX + i * dx, H - padY - (val / max) * innerH];

  const pts = daily.map((d, i) => xy(i, d.n));
  const linePath = pts.map(([x, y], i) => (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaPath = `M ${padX} ${H - padY} ` + pts.map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ` L ${padX + innerW} ${H - padY} Z`;

  const ticks = [0, Math.ceil(max / 2), max];
  const tickLines = ticks.map((t) => {
    const y = H - padY - (t / max) * innerH;
    return `<line x1="${padX}" x2="${W - padX}" y1="${y}" y2="${y}" class="chart-grid"/><text x="${padX - 8}" y="${y + 4}" text-anchor="end" class="chart-label">${t}</text>`;
  }).join('');

  const dots = daily.map((d, i) => {
    const [x, y] = xy(i, d.n);
    const alert = d.alerts > 0
      ? `<circle cx="${x}" cy="${y}" r="6" fill="rgba(239,68,68,0.18)"/>`
      : '';
    return `${alert}<circle cx="${x}" cy="${y}" r="3" fill="var(--accent)"><title>${d.day} — ${d.n} events${d.alerts ? `, ${d.alerts} alert${d.alerts === 1 ? '' : 's'}` : ''}</title></circle>`;
  }).join('');

  // X labels — show ~7 evenly spaced
  const everyNth = Math.max(1, Math.ceil(daily.length / 7));
  const xLabels = daily.map((d, i) => {
    if (i % everyNth !== 0 && i !== daily.length - 1) return '';
    const [x] = xy(i, d.n);
    const lbl = new Date(d.day).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<text x="${x}" y="${H - 8}" text-anchor="middle" class="chart-label">${lbl}</text>`;
  }).join('');

  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
       ${tickLines}
       <path d="${areaPath}" fill="rgba(59,130,246,0.18)"/>
       <path d="${linePath}" stroke="var(--accent)" stroke-width="2" fill="none" stroke-linejoin="round"/>
       ${dots}
       ${xLabels}
     </svg>`;
}

function renderTypeDonut(byType) {
  const total = (byType || []).reduce((s, r) => s + Number(r.n), 0);
  document.getElementById('chart-type-total').textContent = total;
  const segments = (byType || [])
    .filter((r) => Number(r.n) > 0)
    .map((r) => ({ value: Number(r.n), color: TYPE_COLORS[r.type] || 'var(--accent)' }));
  drawDonut('chart-type-donut', segments.length ? segments : [{ value: 1, color: 'rgba(255,255,255,0.06)' }]);

  const legend = document.getElementById('chart-type-legend');
  legend.innerHTML = '';
  if (!byType?.length) {
    const li = document.createElement('li');
    li.className = 'chart-empty';
    li.textContent = 'No detections yet.';
    legend.appendChild(li);
    return;
  }
  for (const r of byType) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'leg-dot';
    dot.style.background = TYPE_COLORS[r.type] || 'var(--accent)';
    const label = document.createElement('span');
    label.className = 'leg-label';
    const n = document.createElement('b');
    n.textContent = r.n;
    label.append(n, ' ' + r.type);
    li.append(dot, label);
    legend.appendChild(li);
  }
}

function renderHorizontalBars(elId, rows, labelKey, valueKey) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = '<div class="chart-empty">No data yet.</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r[valueKey])), 1);
  el.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const lbl = document.createElement('span');
    lbl.className = 'hbar-label';
    lbl.textContent = r[labelKey];
    lbl.title = r[labelKey];
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = `${(Number(r[valueKey]) / max) * 100}%`;
    track.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'hbar-value';
    val.textContent = r[valueKey];
    row.append(lbl, track, val);
    el.appendChild(row);
  }
}

// ── Person Activity (drill-down from People page) ────────
let paCurrentName = null;
// When set (YYYY-MM-DD), the activity page is scoped to a single calendar
// day instead of the rolling N-day window. Cleared by the chip's × button.
let paDateOverride = null;

function openPersonActivity(p, opts = {}) {
  paCurrentName = p.name;
  paDateOverride = opts.date || null;
  // Update header chrome before the fetch so the user sees something instant.
  document.getElementById('pa-name').textContent = p.name.replace(/_/g, ' ');
  document.getElementById('pa-avatar').src =
    `${API}/enrollment/${encodeURIComponent(p.name)}/image?token=${encodeURIComponent(token)}`;
  const badge = document.getElementById('pa-type');
  badge.className = `type-badge type-${p.type}`;
  badge.textContent = PERSON_TYPE_LABEL[p.type] || p.type;
  document.getElementById('pa-notes').textContent = p.notes || '';
  document.getElementById('pa-period').value = '30';
  syncPaDateChip();
  // Route to the page (uses the standard router but it's a hidden route).
  showRoute('person-activity');
  refreshPersonActivity();
}

// Swap between the period dropdown and the "Showing <date>" chip depending
// on whether the page is in single-day mode.
function syncPaDateChip() {
  const wrap = document.getElementById('pa-period-wrap');
  const chip = document.getElementById('pa-date-chip');
  const label = document.getElementById('pa-date-chip-label');
  if (!wrap || !chip || !label) return;
  if (paDateOverride) {
    wrap.style.display = 'none';
    chip.style.display = '';
    const d = new Date(`${paDateOverride}T00:00:00`);
    label.textContent = `Showing ${Number.isNaN(d.getTime()) ? paDateOverride
      : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}`;
  } else {
    wrap.style.display = '';
    chip.style.display = 'none';
  }
}

async function refreshPersonActivity() {
  if (!paCurrentName) return;
  const params = paDateOverride
    ? `date=${encodeURIComponent(paDateOverride)}`
    : `days=${Number(document.getElementById('pa-period').value || 30)}`;
  let data;
  try {
    const r = await authedFetch(`${API}/person/${encodeURIComponent(paCurrentName)}/activity?${params}`);
    if (!r.ok) {
      document.getElementById('pa-timeline').innerHTML = `<li class="event-empty">Could not load activity (${r.status}).</li>`;
      return;
    }
    data = await r.json();
  } catch (err) {
    console.error('[activity]', err);
    return;
  }

  // Stat tiles — simple counts on the left, dual-line timestamps on the right.
  document.getElementById('pa-stat-total').textContent = data.summary.total;
  document.getElementById('pa-stat-cams').textContent  = data.summary.distinctCameras;
  document.getElementById('pa-stat-days').textContent  = data.summary.distinctDays;
  renderTimestampTile('pa-stat-first', data.summary.firstSeen);
  renderTimestampTile('pa-stat-last',  data.summary.lastSeen);

  renderPersonHourly(data.byHour);
  renderDailyTrend(data.byDay.map((d) => ({ day: d.day, n: d.n, alerts: 0 })));
  // The line chart writes to #chart-daily — re-target.
  document.getElementById('pa-chart-daily').innerHTML =
    document.getElementById('chart-daily').innerHTML;

  renderHorizontalBars('pa-chart-camera', data.byCamera, 'camera', 'n');
  renderPersonPathMap(data.timeline);
  renderPersonTimeline(data.timeline.slice(0, 40));
}

// Renders an exact wall-clock value as the main line + relative time below.
function renderTimestampTile(id, iso) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  if (!iso) { el.textContent = '—'; return; }

  const abs = document.createElement('div');
  abs.className = 'stat-tile-datetime';
  abs.textContent = fmtAbsoluteShort(iso);
  abs.title = fmtAbsoluteFull(iso);

  const rel = document.createElement('div');
  rel.className = 'stat-tile-sub';
  rel.textContent = fmtTime(iso);

  el.append(abs, rel);
}

// Build chronological "stops" from a newest-first timeline. Consecutive
// detections at the same camera collapse into a single stop with a count
// and a time range — much cleaner on the map than dozens of overlapping pins.
function buildPersonStops(timeline) {
  const chrono = [...timeline].reverse();    // backend returns DESC; flip
  const stops = [];
  for (const t of chrono) {
    if (t.lat == null || t.lng == null) continue;
    const last = stops[stops.length - 1];
    if (last && last.camera === t.cameraName) {
      last.count++;
      last.lastAt = t.createdAt;
      if (t.snapshot && !last.snapshot) last.snapshot = t.snapshot;
    } else {
      stops.push({
        camera: t.cameraName,
        lat: t.lat,
        lng: t.lng,
        firstAt: t.createdAt,
        lastAt: t.createdAt,
        count: 1,
        snapshot: t.snapshot,
      });
    }
  }
  return stops;
}

let pa_mapInstance = null;
let pa_mapLayers = [];

function ensurePaMap() {
  if (pa_mapInstance) return pa_mapInstance;
  if (typeof L === 'undefined') return null;
  pa_mapInstance = L.map('pa-map', { zoomControl: true, worldCopyJump: true }).setView([0, 0], 2);
  attachDarkTiles(pa_mapInstance);
  return pa_mapInstance;
}

function clearPaMapLayers() {
  for (const l of pa_mapLayers) l.remove();
  pa_mapLayers = [];
}

// Numbered Leaflet divIcon so each stop carries its order on the path.
function pathStopIcon(n, isStart, isEnd) {
  const cls = `path-stop ${isStart ? 'is-start' : ''} ${isEnd ? 'is-end' : ''}`.trim();
  return L.divIcon({
    className: 'path-stop-wrap',
    html: `<div class="${cls}">${n}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function renderPersonPathMap(timeline) {
  const stops = buildPersonStops(timeline);
  const empty = document.getElementById('pa-map-empty');
  const mapEl = document.getElementById('pa-map');
  if (stops.length === 0) {
    if (mapEl) mapEl.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }
  if (mapEl) mapEl.style.display = '';
  if (empty) empty.style.display = 'none';

  const map = ensurePaMap();
  if (!map) return;
  // Leaflet needs the container to have its final size before it lays out
  // tiles. Hit it a few times because page transitions / responsive grid
  // changes can resize the container after the first frame.
  [50, 200, 600].forEach((t) => setTimeout(() => map.invalidateSize(), t));
  clearPaMapLayers();

  // Polyline first so markers sit on top.
  if (stops.length >= 2) {
    const line = L.polyline(stops.map((s) => [s.lat, s.lng]), {
      color: '#6366f1',
      weight: 3,
      opacity: 0.85,
      dashArray: '6 6',
    }).addTo(map);
    pa_mapLayers.push(line);
  }

  stops.forEach((s, i) => {
    const isStart = i === 0;
    const isEnd   = i === stops.length - 1;
    const m = L.marker([s.lat, s.lng], { icon: pathStopIcon(i + 1, isStart, isEnd) }).addTo(map);

    // Show the exact wall-clock time as the primary info (CCTV use case)
    // and keep relative ("21m ago") underneath for at-a-glance recency.
    const absRange = s.firstAt === s.lastAt
      ? fmtAbsoluteShort(s.firstAt)
      : `${fmtAbsoluteShort(s.firstAt)} → ${fmtAbsoluteShort(s.lastAt)}`;
    const relRange = s.firstAt === s.lastAt
      ? fmtTime(s.firstAt)
      : `${fmtTime(s.firstAt)} → ${fmtTime(s.lastAt)}`;

    m.bindPopup(`
      <div class="map-popup">
        <div class="map-popup-title">${escapeHtml(s.camera)} <small>· stop ${i + 1}</small></div>
        <div class="map-popup-time" title="${escapeHtml(fmtAbsoluteFull(s.firstAt) || '')}">${escapeHtml(absRange)}</div>
        <div class="map-popup-sub">${s.count} detection${s.count === 1 ? '' : 's'} · ${escapeHtml(relRange)}</div>
      </div>
    `);
    pa_mapLayers.push(m);
  });

  const bounds = L.latLngBounds(stops.map((s) => [s.lat, s.lng]));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
}

function renderPersonHourly(byHour) {
  const el = document.getElementById('pa-chart-hour');
  if (!el) return;
  const max = Math.max(...byHour, 1);
  const cellW = 28, gap = 3, padLeft = 22, padBottom = 24, top = 12, h = 110;
  const W = padLeft + 24 * (cellW + gap);
  const innerH = h - top - padBottom;

  const bars = byHour.map((n, i) => {
    const bh = n > 0 ? Math.max(2, (n / max) * innerH) : 0;
    const x = padLeft + i * (cellW + gap);
    const y = top + (innerH - bh);
    const color = n === 0 ? 'rgba(255,255,255,0.05)'
                : `rgba(99,102,241,${(0.30 + (n / max) * 0.65).toFixed(2)})`;
    return `<rect x="${x}" y="${y}" width="${cellW}" height="${bh || 2}" rx="2" fill="${color}"><title>${i}:00 — ${n} detection${n === 1 ? '' : 's'}</title></rect>`;
  }).join('');

  const xLabels = [0, 6, 12, 18].map((hr) => {
    const x = padLeft + hr * (cellW + gap) + cellW / 2;
    return `<text x="${x}" y="${h - 8}" text-anchor="middle" class="chart-label">${hr}:00</text>`;
  }).join('');

  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="xMidYMid meet">
       <text x="0" y="${top + innerH / 2 + 4}" class="chart-label">Hits</text>
       ${bars}
       ${xLabels}
     </svg>`;
}

function renderPersonTimeline(rows) {
  const ul = document.getElementById('pa-timeline');
  if (!ul) return;
  if (!rows || rows.length === 0) {
    ul.innerHTML = '<li class="event-empty">No detections in this period yet.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'pa-timeline-row';
    const thumb = snapshotThumbEl(row.snapshot, `${paCurrentName.replace(/_/g, ' ')} · ${row.cameraName || ''}`);
    if (thumb) li.appendChild(thumb);
    else {
      const ph = document.createElement('span');
      ph.className = 'pa-thumb-placeholder';
      ph.textContent = '—';
      li.appendChild(ph);
    }
    const meta = document.createElement('div');
    meta.className = 'pa-timeline-meta';
    const cam = document.createElement('div');
    cam.className = 'pa-timeline-cam';
    cam.textContent = row.cameraName || '—';
    const sub = document.createElement('div');
    sub.className = 'pa-timeline-sub';
    const conf = row.confidence != null ? `${Math.round(row.confidence * 100)}%` : '—';
    sub.textContent = `${conf} · ${fmtTime(row.createdAt)}`;
    meta.append(cam, sub);
    li.appendChild(meta);
    ul.appendChild(li);
  }
}

document.getElementById('pa-period')?.addEventListener('change', refreshPersonActivity);
document.getElementById('pa-back')?.addEventListener('click', () => showRoute('users'));
// Clearing the "Showing <date>" chip drops back to the standard 30-day window
// without leaving the page — fetches a wider dataset, swaps the UI back.
document.getElementById('pa-date-chip-clear')?.addEventListener('click', () => {
  paDateOverride = null;
  syncPaDateChip();
  refreshPersonActivity();
});

// ── Maps page (Leaflet) ──────────────────────────────────
let mapInstance = null;
let mapMarkers = [];

function ensureMap() {
  if (mapInstance) return mapInstance;
  if (typeof L === 'undefined') {
    document.getElementById('map-container').innerHTML =
      '<div class="chart-empty">Leaflet failed to load.</div>';
    return null;
  }
  mapInstance = L.map('map-container', {
    zoomControl: true,
    worldCopyJump: true,
  }).setView([0, 0], 2);
  attachDarkTiles(mapInstance);
  return mapInstance;
}

function clearMapMarkers() {
  for (const m of mapMarkers) m.remove();
  mapMarkers = [];
}

async function refreshMapPage() {
  const list = await (await authedFetch(`${API}/cameras`)).json();
  const located = list.filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number');
  const empty = document.getElementById('map-empty');
  const wrap = document.getElementById('map-container').parentElement;

  if (located.length === 0) {
    if (empty) empty.style.display = '';
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (wrap) wrap.style.display = '';

  const map = ensureMap();
  if (!map) return;
  // Leaflet only sizes correctly once the container has width — invalidate
  // after the first paint so the tiles render in the right place.
  // Leaflet needs the container to have its final size before it lays out
  // tiles. Hit it a few times because page transitions / responsive grid
  // changes can resize the container after the first frame.
  [50, 200, 600].forEach((t) => setTimeout(() => map.invalidateSize(), t));

  clearMapMarkers();
  const bounds = L.latLngBounds([]);
  for (const c of located) {
    const live = cameras.get(c.streamId);
    const state = live?.state || 'unknown';
    const marker = L.marker([c.lat, c.lng]).addTo(map);
    const popup = `
      <div class="map-popup">
        <div class="map-popup-title">${escapeHtml(c.cameraName)}</div>
        <div class="map-popup-sub">
          <span class="status-pill ${state}"><span class="dot"></span>${stateLabel(state)}</span>
        </div>
        <div class="map-popup-rtsp"><code>${escapeHtml(c.rtspUrl)}</code></div>
      </div>`;
    marker.bindPopup(popup);
    mapMarkers.push(marker);
    bounds.extend([c.lat, c.lng]);
  }
  if (located.length === 1) {
    map.setView([located[0].lat, located[0].lng], 16);
  } else {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function stateLabel(s) {
  return s === 'live' ? 'Live' : s === 'connecting' ? 'Connecting' : s === 'offline' ? 'Offline' : '—';
}

document.getElementById('map-fit-all')?.addEventListener('click', () => {
  if (!mapInstance || mapMarkers.length === 0) return;
  const bounds = L.latLngBounds(mapMarkers.map((m) => m.getLatLng()));
  mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
});

async function refreshAnalyticsCharts() {
  const sel = document.getElementById('analytics-charts-period');
  const days = Number(sel?.value || 7);
  let data;
  try {
    data = await (await authedFetch(`${API}/analytics-charts?days=${days}`)).json();
  } catch { return; }
  renderHeatmap(data.heatmap);
  renderDailyTrend(data.daily);
  renderTypeDonut(data.byType);
  renderHorizontalBars('chart-camera', data.byCamera, 'camera', 'n');
  renderHorizontalBars('chart-people', data.byPerson, 'name', 'n');
  refreshDaywiseTable(days);
}

// Day-wise per-person table on the Analytics page. Each row links into the
// existing person-activity drill-down — we already have the underscored
// `nameKey` from the backend, so no enrollment lookup is needed.
let daywiseAllRows = []; // cached for the in-card date filter

function todayYmd() {
  // Local-date YYYY-MM-DD (avoid toISOString which is UTC and can roll a day).
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function refreshDaywiseTable(days) {
  const tbody = document.querySelector('#daywise-table tbody');
  if (!tbody) return;
  let data;
  try {
    data = await (await authedFetch(`${API}/analytics-daywise?days=${days}`)).json();
  } catch { return; }
  daywiseAllRows = data.rows || [];

  // Constrain the picker to the *window* (period dropdown), not to the days
  // that happen to have rows. If today has no incidents yet, today should
  // still be selectable — the empty state explains the "no data" case, but
  // greying it out makes the user think the picker is broken.
  const filterInput = document.getElementById('daywise-date-filter');
  if (filterInput) {
    const today = todayYmd();
    const minDate = new Date();
    minDate.setDate(minDate.getDate() - (Number(days) || 7));
    const mm = String(minDate.getMonth() + 1).padStart(2, '0');
    const dd = String(minDate.getDate()).padStart(2, '0');
    filterInput.min = `${minDate.getFullYear()}-${mm}-${dd}`;
    filterInput.max = today;
    if (!filterInput.value) {
      filterInput.value = today;
      document.getElementById('daywise-date-clear').style.display = '';
    }
  }
  renderDaywiseTable();
}

function renderDaywiseTable() {
  renderDaywiseInto({
    rows: daywiseAllRows,
    dateFilter: document.getElementById('daywise-date-filter')?.value || '',
    tableId: 'daywise-table',
    emptyId: 'daywise-empty',
  });
}

// Shared row renderer — used by both the Analytics "Daily activity" card and
// the Attendance page, so the table layout / cell formatting / drill-in
// behavior stay identical when we tweak one of them.
function renderDaywiseInto({ rows, dateFilter, tableId, emptyId }) {
  const table = document.getElementById(tableId);
  const tbody = table?.querySelector('tbody');
  const empty = document.getElementById(emptyId);
  if (!tbody) return;

  const filtered = dateFilter ? rows.filter((r) => r.day === dateFilter) : rows;
  tbody.innerHTML = '';
  if (filtered.length === 0) {
    table.style.display = 'none';
    if (empty) {
      empty.style.display = '';
      empty.textContent = dateFilter
        ? `No recognized people on ${dateFilter}.`
        : 'No recognized people in this window.';
    }
    return;
  }
  table.style.display = '';
  if (empty) empty.style.display = 'none';

  const fmtClock = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const fmtDay = (ymd) => {
    const d = new Date(ymd + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  };

  for (const r of filtered) {
    const tr = document.createElement('tr');
    const cameras = (r.cameras || []).map((c) =>
      `<span class="daywise-camera-pill">${escapeHtml(c)}</span>`).join('');
    // Enrollment avatar — same endpoint the People card and activity page
    // hero use. If the file is missing the <img> fires onerror and we drop
    // back to an initial bubble so the row stays balanced.
    const avatarUrl = `${API}/enrollment/${encodeURIComponent(r.nameKey)}/image?token=${encodeURIComponent(token)}`;
    const initial = escapeHtml((r.name || '?').trim().charAt(0).toUpperCase());
    tr.innerHTML = `
      <td>${escapeHtml(fmtDay(r.day))}</td>
      <td>
        <div class="person-cell">
          <span class="person-cell-avatar">
            <img src="${avatarUrl}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='grid';">
            <span class="person-cell-initial" style="display:none">${initial}</span>
          </span>
          <span>${escapeHtml(r.name)}</span>
        </div>
      </td>
      <td>${r.n}</td>
      <td>${cameras || '—'}</td>
      <td>${fmtClock(r.firstSeen)}</td>
      <td>${fmtClock(r.lastSeen)}</td>
      <td><button class="row-action view">View details</button></td>
    `;
    tr.querySelector('.row-action').addEventListener('click', () => {
      openPersonActivity({ name: r.nameKey, type: 'standard', notes: '' }, { date: r.day });
    });
    tbody.appendChild(tr);
  }
}

// ── Attendance page ──────────────────────────────────────
// Reuses /analytics-daywise: one row per (day, recognized person). The
// summary tiles show *today's* totals (or the filtered day's totals when a
// date is picked) so the page works as a daily attendance roster.
let attendanceAllRows = [];

async function refreshAttendance() {
  const sel = document.getElementById('attendance-period');
  const days = Number(sel?.value || 7);
  let data;
  try {
    data = await (await authedFetch(`${API}/analytics-daywise?days=${days}`)).json();
  } catch { return; }
  attendanceAllRows = data.rows || [];

  const filterInput = document.getElementById('attendance-date-filter');
  if (filterInput) {
    const today = todayYmd();
    const minDate = new Date();
    minDate.setDate(minDate.getDate() - days);
    const mm = String(minDate.getMonth() + 1).padStart(2, '0');
    const dd = String(minDate.getDate()).padStart(2, '0');
    filterInput.min = `${minDate.getFullYear()}-${mm}-${dd}`;
    filterInput.max = today;
    if (!filterInput.value) {
      filterInput.value = today;
      document.getElementById('attendance-date-clear').style.display = '';
    }
  }
  renderAttendance();
}

function renderAttendance() {
  const dateFilter = document.getElementById('attendance-date-filter')?.value || '';
  renderDaywiseInto({
    rows: attendanceAllRows,
    dateFilter,
    tableId: 'attendance-table',
    emptyId: 'attendance-empty',
  });
  // Summary tiles roll up the visible rows. With a date filter active they
  // describe a single day; with no filter they describe the whole window.
  const visible = dateFilter
    ? attendanceAllRows.filter((r) => r.day === dateFilter)
    : attendanceAllRows;
  const uniquePeople = new Set(visible.map((r) => r.name)).size;
  const totalDetections = visible.reduce((s, r) => s + (Number(r.n) || 0), 0);
  let firstIso = null, lastIso = null;
  for (const r of visible) {
    if (r.firstSeen && (!firstIso || new Date(r.firstSeen) < new Date(firstIso))) firstIso = r.firstSeen;
    if (r.lastSeen  && (!lastIso  || new Date(r.lastSeen)  > new Date(lastIso)))  lastIso  = r.lastSeen;
  }
  const fmtAt = (iso) => iso
    ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
  document.getElementById('att-stat-people').textContent = uniquePeople;
  document.getElementById('att-stat-total').textContent  = totalDetections;
  document.getElementById('att-stat-first').textContent  = fmtAt(firstIso);
  document.getElementById('att-stat-last').textContent   = fmtAt(lastIso);
}

document.getElementById('attendance-period')?.addEventListener('change', refreshAttendance);
document.getElementById('attendance-date-filter')?.addEventListener('change', () => {
  const v = document.getElementById('attendance-date-filter').value;
  document.getElementById('attendance-date-clear').style.display = v ? '' : 'none';
  renderAttendance();
});
document.getElementById('attendance-date-clear')?.addEventListener('click', () => {
  document.getElementById('attendance-date-filter').value = '';
  document.getElementById('attendance-date-clear').style.display = 'none';
  renderAttendance();
});

document.getElementById('daywise-date-filter')?.addEventListener('change', () => {
  const v = document.getElementById('daywise-date-filter').value;
  document.getElementById('daywise-date-clear').style.display = v ? '' : 'none';
  renderDaywiseTable();
});
document.getElementById('daywise-date-clear')?.addEventListener('click', () => {
  const input = document.getElementById('daywise-date-filter');
  input.value = '';
  document.getElementById('daywise-date-clear').style.display = 'none';
  renderDaywiseTable();
});

document.getElementById('analytics-charts-period')?.addEventListener('change', refreshAnalyticsCharts);

// ── Routing (stub-friendly) ──────────────────────────────
const PAGES = {
  dashboard: 'page-dashboard',
  cameras:   'page-cameras',
  users:     'page-users',
  incidents: 'page-incidents',
  analytics: 'page-analytics',
  attendance:'page-attendance',
  maps:      'page-maps',
  settings:  'page-settings',
  analyze:   'page-analyze',
  // Hidden routes (not in sidebar; entered via in-page actions).
  'person-activity': 'page-person-activity',
};
// "Incident" rules — what shows up on the Incidents page and Recent
// Incidents rail. Fire/smoke always count; face detections count only when
// the recognizer matched a name. Unnamed faces and motion (person) events
// flow into the dashboard's "Recent Events" card but not here.
const isIncident = (row) =>
  !!row && (row.type === 'fire' || row.type === 'smoke' ||
            row.type === 'loitering' || row.type === 'plate' ||
            (row.type === 'face' && !!row.name));

function showRoute(route) {
  const target = PAGES[route] || 'page-stub';
  document.querySelectorAll('.page').forEach((p) => { p.style.display = (p.id === target) ? '' : 'none'; });
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));

  if (target === 'page-stub') {
    document.getElementById('stub-title').textContent = `${route[0].toUpperCase() + route.slice(1)} — coming soon`;
    document.getElementById('stub-desc').textContent  = 'This section is on the roadmap. We\'ll build it out next.';
  }
  if (route === 'cameras')   refreshCamerasTable();
  if (route === 'users')     refreshEnrollments();
  if (route === 'settings')  refreshFeatures();
  if (route === 'analytics') refreshAnalyticsCharts();
  if (route === 'attendance') refreshAttendance();
  if (route === 'maps')      refreshMapPage();
  if (route === 'analyze')   window.analyzeModule?.wire();
  if (route === 'incidents') {
    refreshIncidentsTable();
    setBadge('bell-badge', 0);
    setBadge('nav-incidents-badge', 0);
  }
}

document.querySelectorAll('.nav-item').forEach((n) => {
  n.addEventListener('click', (e) => {
    if (n.classList.contains('disabled')) { e.preventDefault(); return; }
    showRoute(n.dataset.route);
  });
});
document.querySelectorAll('.link[data-route]').forEach((a) => {
  a.addEventListener('click', () => showRoute(a.dataset.route));
});

// ── Modal helpers ────────────────────────────────────────
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => closeModal(b.dataset.close));
});
document.querySelectorAll('.modal-overlay').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) m.style.display = 'none'; });
});

document.getElementById('add-camera-btn')?.addEventListener('click', () => openModal('add-camera-modal'));
document.getElementById('add-camera-btn-2')?.addEventListener('click', () => openModal('add-camera-modal'));
document.getElementById('add-person-btn')?.addEventListener('click', openAddPerson);

document.getElementById('add-camera-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const latRaw = fd.get('lat');
  const lngRaw = fd.get('lng');
  await addCamera({
    cameraName: fd.get('cameraName'),
    rtspUrl:    fd.get('rtspUrl'),
    lat:        latRaw === '' || latRaw == null ? null : Number(latRaw),
    lng:        lngRaw === '' || lngRaw == null ? null : Number(lngRaw),
  });
  e.target.reset();
  closeModal('add-camera-modal');
});

// "Use my location" — fills lat/lng from the browser's geolocation API.
document.getElementById('use-my-location')?.addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('This browser does not expose geolocation.');
    return;
  }
  const btn = document.getElementById('use-my-location');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const form = document.getElementById('add-camera-form');
      form.elements.lat.value = pos.coords.latitude.toFixed(6);
      form.elements.lng.value = pos.coords.longitude.toFixed(6);
      btn.disabled = false;
      btn.innerHTML = old;
    },
    (err) => {
      alert(`Location unavailable: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = old;
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

document.getElementById('enroll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const name = fd.get('name');
  const type = fd.get('type') || 'standard';
  const fileInput = form.elements.images;
  const files = fileInput?.files || [];
  const submit = document.getElementById('enroll-submit');

  submit.disabled = true;
  const oldText = submit.textContent;
  submit.textContent = 'Working…';

  try {
    if (enrollMode === 'edit-type') {
      // Just update the category — no photos involved.
      const r = await authedFetch(`${API}/enrollment/${encodeURIComponent(enrollTarget.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      if (!r.ok) { alert(`Update failed: ${await r.text()}`); return; }
    } else {
      // Add new person OR add more photos to existing — both go through /enroll.
      if (files.length === 0) {
        alert('Pick at least one photo.');
        return;
      }
      const imagesBase64 = await readFilesAsDataURLs(files);
      const targetName = enrollMode === 'add-photos' ? enrollTarget.name : name;
      const body = { name: targetName, imagesBase64 };
      if (enrollMode === 'add') body.type = type;
      const r = await authedFetch(`${API}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { alert(`Enroll failed: ${await r.text()}`); return; }
    }
    closeModal('add-person-modal');
    refreshEnrollments();
  } finally {
    submit.disabled = false;
    submit.textContent = oldText;
  }
});

// Live preview of the picked files in the modal.
document.querySelector('#enroll-form input[name="images"]')?.addEventListener('change', (e) => {
  const list = document.getElementById('enroll-file-list');
  list.innerHTML = '';
  for (const f of e.target.files) {
    const chip = document.createElement('span');
    chip.className = 'enroll-file-chip';
    chip.textContent = f.name;
    list.appendChild(chip);
  }
});

// ── Analyze Video page ───────────────────────────────────
// Offline pipeline: upload → backend spawns face-ai/analyze_video.py →
// Socket.IO `analyze_progress` events flow back keyed by jobId → we render
// a progress bar, then swap in the annotated MP4 for playback.
window.analyzeModule = (() => {
  const state = { jobId: null, file: null };

  const $file      = () => document.getElementById('analyze-file');
  const $drop      = () => document.getElementById('analyze-drop');
  const $selected  = () => document.getElementById('analyze-selected');
  const $submit    = () => document.getElementById('analyze-submit');
  const $result    = () => document.getElementById('analyze-result');
  const $placeholder = () => document.getElementById('analyze-placeholder');
  const $progress  = () => document.getElementById('analyze-progress');
  const $progFill  = () => document.getElementById('analyze-progress-fill');
  const $progPct   = () => document.getElementById('analyze-progress-pct');
  const $progFrames= () => document.getElementById('analyze-progress-frames');
  const $progFps   = () => document.getElementById('analyze-progress-fps');
  const $progEta   = () => document.getElementById('analyze-progress-eta');
  const $error     = () => document.getElementById('analyze-error');
  const $videoWrap = () => document.getElementById('analyze-video-wrap');
  const $video     = () => document.getElementById('analyze-video');
  const $download  = () => document.getElementById('analyze-download');

  function selectFile(f) {
    if (!f) return;
    if (!f.type.startsWith('video/')) {
      alert('Please choose a video file.');
      return;
    }
    state.file = f;
    const sel = $selected();
    sel.style.display = 'flex';
    sel.innerHTML = `<span><b>${f.name}</b></span><span>${fmtBytes(f.size)}</span>`;
    $submit().disabled = false;
  }

  function reset() {
    state.jobId = null;
    state.file = null;
    $file().value = '';
    $selected().style.display = 'none';
    $selected().innerHTML = '';
    $submit().disabled = true;
    $placeholder().style.display = '';
    $progress().style.display = 'none';
    $error().style.display = 'none';
    $error().textContent = '';
    $videoWrap().style.display = 'none';
    const v = $video();
    v.pause();
    if (v.src && v.src.startsWith('blob:')) URL.revokeObjectURL(v.src);
    v.src = '';
    $progFill().style.width = '0%';
    const summaryEl = document.getElementById('analyze-summary');
    if (summaryEl) { summaryEl.style.display = 'none'; summaryEl.querySelectorAll(':scope > div').forEach(d => d.innerHTML = ''); }
  }

  async function submit() {
    if (!state.file) return;
    const btn = $submit();
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    $placeholder().style.display = 'none';
    $progress().style.display = '';
    $error().style.display = 'none';
    $videoWrap().style.display = 'none';
    const summaryEl0 = document.getElementById('analyze-summary');
    if (summaryEl0) summaryEl0.style.display = 'none';
    $progFill().style.width = '0%';
    $progPct().textContent = '0%';
    $progFrames().textContent = 'frame 0 / 0';
    $progFps().textContent = '— fps';
    $progEta().textContent = 'ETA —';

    const fd = new FormData();
    fd.append('video', state.file);
    fd.append('loiteringSeconds', document.getElementById('analyze-loitering').value || '10');
    fd.append('downscale', document.getElementById('analyze-downscale').value || '0.5');
    fd.append('useEnrollment', document.getElementById('analyze-enrollment').checked ? 'true' : 'false');
    fd.append('detectFire',    document.getElementById('analyze-fire').checked ? 'true' : 'false');
    fd.append('personSensitivity', document.getElementById('analyze-person-sensitivity').value || 'balanced');
    fd.append('detectionQuality',  document.getElementById('analyze-detection-quality').value || 'fast');

    try {
      const resp = await fetch(`${API}/analyze-video`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, // multer needs no Content-Type override
        body: fd,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'upload failed' }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const { jobId } = await resp.json();
      state.jobId = jobId;
      btn.textContent = 'Analyzing…';
    } catch (e) {
      showError(e.message || 'Upload failed');
      btn.textContent = 'Analyze';
      btn.disabled = false;
    }
  }

  function showError(msg) {
    $progress().style.display = 'none';
    const el = $error();
    el.textContent = msg;
    el.style.display = '';
    $submit().textContent = 'Analyze';
    $submit().disabled = !state.file;
  }

  function onProgress(msg) {
    if (!msg || msg.jobId !== state.jobId) return;
    if (msg.status === 'running') {
      if (msg.phase === 'loading') {
        // Pre-detection warmup: model downloads (~52 MB for "Best" preset on
        // first use) + weights load. No frame progress yet — show an indeterminate
        // "Loading models…" state so 0/0 doesn't look like a hang.
        $progFill().style.width = '20%';
        $progPct().textContent = 'Loading models…';
        $progFrames().textContent = 'First "Best" run downloads ~52 MB';
        $progFps().textContent = '';
        $progEta().textContent = '';
        return;
      }
      if (msg.phase === 'encoding') {
        // Frame loop finished; ffmpeg re-encode is running (can be a minute+
        // on 4K CPU). Keep the bar full and swap labels so it doesn't look frozen.
        $progFill().style.width = '100%';
        $progPct().textContent = 'Finalizing…';
        $progFrames().textContent = 'Re-encoding to H.264';
        $progFps().textContent = '';
        $progEta().textContent = '';
        return;
      }
      // Phase === 'detecting' (or omitted) — regular per-frame progress below.
      const pct = Math.max(0, Math.min(1, msg.progress || 0));
      $progFill().style.width = `${(pct * 100).toFixed(1)}%`;
      $progPct().textContent = `${(pct * 100).toFixed(1)}%`;
      $progFrames().textContent = `frame ${msg.frame} / ${msg.totalFrames}`;
      $progFps().textContent = msg.fps != null ? `${msg.fps.toFixed(2)} fps` : '— fps';
      $progEta().textContent = msg.etaSeconds != null && msg.etaSeconds > 0
        ? `ETA ${Math.round(msg.etaSeconds)}s` : 'ETA —';
    } else if (msg.status === 'done') {
      $progFill().style.width = '100%';
      $progPct().textContent = '100%';
      finish(msg.outputUrl, msg.summary);
    } else if (msg.status === 'error') {
      showError(msg.error || 'Analyzer failed');
    }
  }

  function finish(outputUrl, summary) {
    // Point <video> straight at the backend URL with the JWT as a query param
    // — the backend supports Range requests, so the browser streams chunks and
    // seeks natively instead of us slurping the whole file as a blob (which
    // aborts on large files and can't do preflighted-CORS with the Auth header).
    const url = `${API}${outputUrl}?token=${encodeURIComponent(token)}`;
    $progress().style.display = 'none';
    $videoWrap().style.display = '';
    const v = $video();
    v.src = url;
    v.load();
    // The Download button needs a separate URL that forces attachment
    // behaviour: the plain <a download> attribute is ignored cross-origin,
    // so we ask the backend to send Content-Disposition: attachment via
    // `?download=1`. The video player uses the plain URL so streaming +
    // Range requests still work.
    $download().href = url + '&download=1';
    $download().download = 'annotated.mp4';
    $submit().textContent = 'Analyze';
    $submit().disabled = !state.file;
    renderSummary(summary);
  }

  function snapUrl(fname) {
    if (!fname || !state.jobId) return null;
    return `${API}/analyze-video/${state.jobId}/snapshot/${encodeURIComponent(fname)}?token=${encodeURIComponent(token)}`;
  }

  function fmtSecondsClock(s) {
    // "0:42", "1:03:45" — MM:SS or HH:MM:SS as appropriate.
    if (s == null) return '';
    const total = Math.max(0, Math.round(s));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  function seekVideoTo(seconds) {
    // Move the player head to the given moment in the annotated clip.
    // Clamps to [0, duration] because Chrome throws on out-of-range set.
    const v = $video();
    if (!v || !isFinite(seconds)) return;
    const dur = isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.max(0, Math.min(dur, seconds));
    v.play?.().catch(() => { /* autoplay may be blocked; user can click play */ });
    v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Per-event visual metadata — must match the box colors burned into the video.
  const EVENT_META = {
    face:      { label: 'Face Recognized',  cls: 'ev-face' },
    plate:     { label: 'Plate Read',       cls: 'ev-plate' },
    loitering: { label: 'Loitering',        cls: 'ev-loit' },
    fire:      { label: 'Fire / Smoke',     cls: 'ev-fire' },
  };

  function buildIncidentRow(item) {
    // Single unified row: Snapshot | Event badge | Subject | Detail | Time.
    // Modelled on the Incidents page — the event badge is what tells the user
    // at a glance which detector fired (loitering vs face vs plate vs fire),
    // without them having to read the section header.
    const meta = EVENT_META[item.event] || { label: item.event, cls: '' };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="analyze-row-thumb"></td>
      <td class="analyze-row-event"></td>
      <td class="analyze-row-title"></td>
      <td class="analyze-row-sub"></td>
      <td class="analyze-row-time"></td>
    `;
    if (item.snap) {
      const img = document.createElement('img');
      img.src = snapUrl(item.snap);
      img.alt = item.title;
      img.loading = 'lazy';
      img.className = 'analyze-row-img';
      img.addEventListener('click', () => openSnapshotLightbox(img.src, `${meta.label}: ${item.title}`));
      tr.querySelector('.analyze-row-thumb').appendChild(img);
    } else {
      tr.querySelector('.analyze-row-thumb').textContent = '—';
    }
    const badge = document.createElement('span');
    badge.className = `analyze-event-badge ${meta.cls}`;
    badge.textContent = meta.label;
    tr.querySelector('.analyze-row-event').appendChild(badge);
    tr.querySelector('.analyze-row-title').textContent = item.title;
    tr.querySelector('.analyze-row-sub').textContent = item.subtitle || '';
    const timeBtn = document.createElement('button');
    timeBtn.className = 'analyze-time-btn';
    timeBtn.textContent = fmtSecondsClock(item.first_s);
    timeBtn.title = 'Jump to this moment in the video';
    timeBtn.addEventListener('click', () => seekVideoTo(item.first_s));
    tr.querySelector('.analyze-row-time').appendChild(timeBtn);
    return tr;
  }

  function renderSummary(summary) {
    const root = document.getElementById('analyze-summary');
    if (!root) return;
    root.querySelectorAll('.analyze-summary-section, #analyze-summary-counts')
        .forEach((el) => { el.innerHTML = ''; });
    if (!summary || !summary.counts) { root.style.display = 'none'; return; }
    root.style.display = '';

    // Six count tiles across the top — same shape as the Analytics Overview
    // cards on the sidebar so the visual language matches.
    const counts = summary.counts || {};
    const countTiles = [
      { label: 'Persons',          value: counts.persons },
      { label: 'Vehicles',         value: counts.vehicles },
      { label: 'Faces recognized', value: counts.faces_recognized },
      { label: 'Plates read',      value: counts.plates_read },
      { label: 'Loitering events', value: counts.loitering_events },
      { label: 'Fire / smoke',     value: counts.fire_events },
    ];
    const countsEl = document.getElementById('analyze-summary-counts');
    for (const t of countTiles) {
      const el = document.createElement('div');
      el.className = 'analyze-count';
      el.innerHTML = `<div class="analyze-count-value"></div><div class="analyze-count-label"></div>`;
      el.querySelector('.analyze-count-value').textContent = t.value ?? 0;
      el.querySelector('.analyze-count-label').textContent = t.label;
      countsEl.appendChild(el);
    }

    // Flatten all four event types into a single chronologically-sorted list
    // so the reader sees "what happened, and when" in reading order — same
    // pattern as the Incidents page. The `event` tag drives the coloured
    // badge in each row.
    const rows = [];
    for (const f of summary.faces || []) rows.push({
      event: 'face', snap: f.snap, title: f.name,
      subtitle: `${f.count} frame${f.count === 1 ? '' : 's'}`,
      first_s: f.first_s,
    });
    for (const p of summary.plates || []) rows.push({
      event: 'plate', snap: p.snap, title: p.plate,
      subtitle: p.vehicleType || 'vehicle',
      first_s: p.first_s,
    });
    for (const l of summary.loitering || []) rows.push({
      event: 'loitering', snap: l.snap, title: `Track #${l.trackId}`,
      subtitle: `Peak dwell ${l.peak_dwell_s}s`,
      first_s: l.first_s,
    });
    for (let i = 0; i < (summary.fire || []).length; i++) {
      const f = summary.fire[i];
      rows.push({
        event: 'fire', snap: f.snap, title: `Event ${i + 1}`,
        subtitle: '', first_s: f.first_s,
      });
    }
    rows.sort((a, b) => (a.first_s || 0) - (b.first_s || 0));

    const eventsSection = document.getElementById('analyze-summary-events');
    if (rows.length) {
      eventsSection.innerHTML = `
        <div class="analyze-summary-title">Detected Events</div>
        <table class="analyze-summary-table">
          <thead>
            <tr>
              <th>Snapshot</th>
              <th>Event</th>
              <th>Subject</th>
              <th>Detail</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      `;
      const tbody = eventsSection.querySelector('tbody');
      for (const r of rows) tbody.appendChild(buildIncidentRow(r));
    }
  }

  // Wire event handlers once — the page may be revisited many times but the
  // DOM elements are static, so single listeners are enough.
  function wire() {
    const drop = $drop();
    if (!drop || drop.dataset.wired) return;
    drop.dataset.wired = '1';
    drop.addEventListener('click', () => $file().click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drag-over');
      const f = e.dataTransfer.files?.[0];
      if (f) selectFile(f);
    });
    $file().addEventListener('change', (e) => selectFile(e.target.files?.[0]));
    $submit().addEventListener('click', submit);
    document.getElementById('analyze-new').addEventListener('click', reset);
  }

  return { wire, reset, onProgress };
})();

// ── Top bar wiring ───────────────────────────────────────
const userMenuBtn = document.getElementById('user-menu-btn');
const userMenu = document.getElementById('user-menu');
userMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (userMenu.style.display === 'flex') {
    userMenu.style.display = 'none';
    return;
  }
  const r = userMenuBtn.getBoundingClientRect();
  userMenu.style.display = 'flex';
  userMenu.style.top = `${r.bottom + 6}px`;
  userMenu.style.left = `${Math.max(8, r.right - 180)}px`;
});
document.addEventListener('click', (e) => {
  if (!userMenu.contains(e.target) && !e.target.closest('#user-menu-btn')) {
    userMenu.style.display = 'none';
  }
});
document.getElementById('logout-btn').addEventListener('click', () => {
  userMenu.style.display = 'none';
  logout();
});
document.getElementById('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
document.getElementById('bell-btn').addEventListener('click', () => showRoute('incidents'));
document.getElementById('grid-size').addEventListener('change', (e) => {
  grid.classList.remove('grid-1', 'grid-2', 'grid-3', 'grid-4', 'grid-auto');
  grid.classList.add(`grid-${e.target.value}`);
  for (const cam of cameras.values()) resizeCanvas(cam);
});
document.getElementById('analytics-period').addEventListener('change', refreshAnalytics);

// ── Auth tabs ────────────────────────────────────────────
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('auth-heading').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  document.getElementById('auth-desc').textContent = mode === 'signup'
    ? 'Pick a username and password — your cameras and people stay private to you.'
    : 'Enter your credentials to access the dashboard.';
  document.getElementById('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  document.querySelector('#auth-form input[name="password"]').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  document.getElementById('login-error').textContent = '';
}
document.querySelectorAll('.auth-tab').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const path = authMode === 'signup' ? '/signup' : '/login';
  try {
    const r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      errEl.textContent = error || (authMode === 'signup' ? 'Sign up failed' : 'Login failed');
      return;
    }
    const data = await r.json();
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    e.target.reset();
    bootAuthedUI();
  } catch (err) { errEl.textContent = err.message; }
});

// ── Boot ─────────────────────────────────────────────────
async function bootAuthedUI() {
  hideLogin();
  document.getElementById('app').style.display = '';
  setUserChip();
  connectSocket();

  // Initial pulls
  refreshCameraStatus();
  await Promise.all([
    refreshSystemHealth().catch(() => {}),
    refreshAnalytics().catch(() => {}),
    loadInitialEvents().catch(() => {}),
  ]);

  // Load existing cameras
  const list = await (await authedFetch(`${API}/cameras`)).json();
  for (const { streamId, cameraName, hlsUrl } of list) {
    if (!cameras.has(streamId)) makeTile(streamId, cameraName, hlsUrl);
  }

  // Periodic refreshers
  setInterval(refreshSystemHealth, 15000);
  setInterval(refreshAnalytics, 60000);
}

// ── Agent modal ──────────────────────────────────────────
function showAgentModal(streamKey, rtspUrl, agentStarted = false) {
  const isWindows = navigator.userAgent.includes('Win');
  const ffmpegInstall = isWindows
    ? 'winget install -e --id Gyan.FFmpeg'
    : 'sudo apt install ffmpeg   # Debian/Ubuntu\n# brew install ffmpeg          # macOS';
  document.getElementById('ffmpeg-cmd').textContent = ffmpegInstall;
  document.getElementById('agent-cmd').textContent = `python agent/agent.py ${API} ${streamKey} ${rtspUrl}`;
  const desc = document.querySelector('#agent-modal .modal-desc');
  if (desc) {
    desc.innerHTML = agentStarted
      ? `The system has automatically started a local FFmpeg bridge. <strong>You don't need to do anything</strong> — but here's the manual command if your camera lives on a different machine:`
      : `Your camera is registered. Run <strong>agent.py</strong> on a machine that can reach your camera.`;
  }
  openModal('agent-modal');
}

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    navigator.clipboard.writeText(target.textContent).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
});

if (token) bootAuthedUI();
else showLogin();
