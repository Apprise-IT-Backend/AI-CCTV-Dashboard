require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const INCIDENT_THROTTLE_MS = Number(process.env.INCIDENT_THROTTLE_MS || 10000);
const MEDIAMTX_API = 'http://127.0.0.1:9997';
const HLS_BASE = 'http://127.0.0.1:8888';
const PYTHON = process.env.PYTHON || 'python';
const DETECTOR = path.join(__dirname, '..', 'face-ai', 'detect.py');
const ENROLLMENT_ROOT = path.join(__dirname, '..', 'face-ai', 'enrollments');
const AGENT_SCRIPT = path.join(__dirname, '..', 'agent', 'agent.py');
const ANALYZER = path.join(__dirname, '..', 'face-ai', 'analyze_video.py');

// Offline video analyzer — uploads + annotated outputs live here.
// Files are per-user under an `<userId>` folder so the download route can do
// a strict ownership check by prefix without touching a DB table.
const ANALYZE_ROOT = path.join(__dirname, '..', 'face-ai', 'analyze_jobs');
fs.mkdirSync(ANALYZE_ROOT, { recursive: true });

fs.mkdirSync(ENROLLMENT_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
io.use(auth.socketAuth);
io.on('connection', (socket) => {
  // Each authenticated socket joins a room scoped to its user_id.
  if (socket.user?.uid) socket.join(`user:${socket.user.uid}`);
});

// streamId -> { userId, cameraName, rtspUrl, pathName, hlsUrl }
const activeStreams = new Map();
// streamId -> child process
const activeAgents = new Map();

function emitToUser(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

// ── Per-user enrollment type cache (name → type) ─────────────
// Loaded lazily on first detection for that user; busted on every enroll/
// edit/delete so detection events always carry a fresh personType.
const enrollmentTypeCache = new Map(); // userId -> Map<name, type>

async function getEnrollmentTypes(userId) {
  let map = enrollmentTypeCache.get(userId);
  if (map) return map;
  map = new Map();
  try {
    const [rows] = await db.getPool().query(
      'SELECT name, type FROM enrollments WHERE user_id = ?', [userId],
    );
    for (const r of rows) map.set(r.name, r.type);
  } catch (err) {
    console.error('[enrollment-types] cache load failed:', err.message);
  }
  enrollmentTypeCache.set(userId, map);
  return map;
}

function invalidateEnrollmentTypes(userId) { enrollmentTypeCache.delete(userId); }

function augmentDetections(types, detections) {
  if (!Array.isArray(detections)) return detections;
  return detections.map((d) =>
    d.name && types.has(d.name) ? { ...d, personType: types.get(d.name) } : d,
  );
}

// ── Per-user feature cache (in-memory mirror of `features` table) ─
const featureCache = new Map(); // userId -> Map<name, boolean>

async function refreshFeatures(userId) {
  const [rows] = await db.getPool().query(
    'SELECT name, enabled FROM features WHERE user_id = ?', [userId],
  );
  const map = new Map();
  for (const r of rows) map.set(r.name, !!r.enabled);
  featureCache.set(userId, map);
  return map;
}

async function getUserFeatures(userId) {
  return featureCache.get(userId) || (await refreshFeatures(userId));
}

// ── Incident persistence with per-(stream,type,name) throttle ─
const SNAPSHOT_ROOT = path.join(__dirname, '..', 'face-ai', 'snapshots');
const lastIncidentAt = new Map();
async function persistIncidents(streamId, detections, incidents, snapshotPath) {
  const stream = activeStreams.get(streamId);
  if (!stream) return;
  const { userId, cameraName } = stream;
  const features = await getUserFeatures(userId);
  const isEnabled = (n) => features.get(n) === true;
  const now = Date.now();

  const candidates = [];

  if (Array.isArray(detections)) {
    for (const d of detections) {
      if (d.label === 'face' && d.name && isEnabled('face_detection')) {
        candidates.push({ type: 'face', name: d.name, confidence: d.confidence, bbox: { x: d.x, y: d.y, w: d.w, h: d.h } });
      } else if (d.label === 'person' && isEnabled('person_detection')) {
        candidates.push({ type: 'person', name: null, confidence: d.confidence, bbox: { x: d.x, y: d.y, w: d.w, h: d.h } });
      }
    }
  }

  if (Array.isArray(incidents)) {
    for (const inc of incidents) {
      if ((inc.type === 'fire' || inc.type === 'smoke') && isEnabled('fire_detection')) {
        candidates.push({ type: inc.type, name: null, confidence: inc.confidence, bbox: inc.box });
      } else if (inc.type === 'loitering' && isEnabled('loitering_detection')) {
        // Track ID goes into `name` so the incidents rail can group per-person.
        // Include dwellSeconds inside the bbox JSON blob for later inspection.
        const bbox = { box: inc.box, dwellSeconds: inc.dwellSeconds, trackId: inc.trackId };
        candidates.push({
          type: 'loitering', name: inc.trackId != null ? `Track #${inc.trackId}` : null,
          confidence: inc.confidence, bbox,
        });
      } else if (inc.type === 'plate' && isEnabled('plate_detection')) {
        // The plate string itself is the incident's `name` — surfaces on the
        // Incidents page in the Name column so a user can search their history.
        const bbox = { box: inc.box, trackId: inc.trackId, vehicleType: inc.vehicleType };
        candidates.push({
          type: 'plate', name: inc.plate || null,
          confidence: inc.confidence, bbox,
        });
      }
    }
  }

  for (const c of candidates) {
    const key = `${streamId}:${c.type}:${c.name || '_'}`;
    const last = lastIncidentAt.get(key) || 0;
    if (now - last < INCIDENT_THROTTLE_MS) continue;
    lastIncidentAt.set(key, now);
    try {
      await db.getPool().query(
        'INSERT INTO incidents (user_id, stream_id, camera_name, type, name, confidence, bbox_json, snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, streamId, cameraName, c.type, c.name, c.confidence ?? null, JSON.stringify(c.bbox), snapshotPath || null],
      );
      emitToUser(userId, 'incident_logged', {
        streamId, cameraName, type: c.type, name: c.name,
        snapshot: snapshotPath || null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[DB] Insert incident failed:', err.message);
    }
  }
}

// ── Single shared AI worker process ──────────────────────────
let masterWorker = null;
let workerBuf = '';

function startMasterWorker() {
  console.log('[AI] Starting master detection worker...');
  masterWorker = spawn(PYTHON, ['-u', DETECTOR], {
    cwd: path.dirname(DETECTOR),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  masterWorker.stdout.on('data', (chunk) => {
    workerBuf += chunk.toString();
    let nl;
    while ((nl = workerBuf.indexOf('\n')) >= 0) {
      const line = workerBuf.slice(0, nl).trim();
      workerBuf = workerBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'detections') {
          const stream = activeStreams.get(msg.streamId);
          if (stream) {
            // Look up enrollment types so the frontend can color recognized
            // faces by category (threat/vip/staff/...). Cached per user.
            getEnrollmentTypes(stream.userId).then((types) => {
              const detections = augmentDetections(types, msg.detections);
              emitToUser(stream.userId, 'face_detections', { streamId: msg.streamId, detections });
              if (msg.incidents && msg.incidents.length > 0) {
                emitToUser(stream.userId, 'incident_detections', { streamId: msg.streamId, incidents: msg.incidents });
              }
            }).catch((err) => console.error('[detections] augment failed:', err.message));
          }
          persistIncidents(msg.streamId, msg.detections, msg.incidents, msg.snapshot).catch(() => {});
        } else {
          console.log(`[AI] ${msg.type}: ${msg.message || line}`);
        }
      } catch {
        console.log(`[AI] ${line}`);
      }
    }
  });

  masterWorker.stderr.on('data', (d) => {
    const txt = d.toString().trim();
    if (!txt.includes('INFO:') && !txt.includes('XNNPACK') && !txt.includes('feedback')) {
      console.error(`[AI stderr] ${txt}`);
    }
  });

  masterWorker.on('exit', (code) => {
    console.log(`[AI] Worker exited (${code}) — restarting in 3s`);
    masterWorker = null;
    setTimeout(() => {
      startMasterWorker();
      // Re-register all active streams after restart, with their per-user enrollment dirs
      for (const [streamId, s] of activeStreams) {
        sendWorkerCmd({
          cmd: 'add',
          streamId,
          rtspUrl: `rtsp://127.0.0.1:8554/${s.pathName}`,
          enrollmentDir: db.userEnrollmentDir(s.userId),
        });
      }
    }, 3000);
  });
}

function sendWorkerCmd(obj) {
  if (masterWorker && masterWorker.stdin.writable) {
    masterWorker.stdin.write(JSON.stringify(obj) + '\n');
  }
}

// ── Public routes ─────────────────────────────────────────────
app.post('/login', auth.login);
app.post('/signup', auth.signup);

// Stream key check is hit by the local agent (no token); keep public.
app.get('/streams/:key', (req, res) => {
  const found = [...activeStreams.values()].some(s => s.pathName === req.params.key);
  if (found) return res.json({ ok: true });
  res.status(404).json({ ok: false });
});

// Everything below requires a valid JWT.
app.use(auth.httpAuth);

app.get('/me', (req, res) => {
  res.json({ id: req.user.uid, username: req.user.username });
});

// ── Offline video analyzer ────────────────────────────────────
// One-shot pipeline that runs `face-ai/analyze_video.py` on an uploaded video
// and produces an annotated MP4. Progress is streamed to the user's Socket.IO
// room as `analyze_progress` events keyed by jobId.
//
// Flow:
//   POST /analyze-video     multipart form with `video` file → { jobId }
//   GET  /analyze-video/:id status/metadata JSON
//   GET  /analyze-video/:id/output   streams the annotated MP4 when ready
//   DELETE /analyze-video/:id        removes input + output from disk
const analyzeJobs = new Map(); // jobId -> { userId, status, progress, inputPath, outputPath, error, proc }

const analyzeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const userDir = path.join(ANALYZE_ROOT, String(req.user.uid));
      fs.mkdirSync(userDir, { recursive: true });
      cb(null, userDir);
    },
    filename: (req, file, cb) => {
      // Keep the original extension so ffmpeg/opencv can dispatch the right demuxer.
      const jobId = uuidv4();
      req._analyzeJobId = jobId;
      const ext = (path.extname(file.originalname || '') || '.mp4').toLowerCase();
      cb(null, `${jobId}_in${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB, generous for testing
  fileFilter: (req, file, cb) => {
    // Multer inspects the client-provided MIME + extension. OpenCV can open
    // most containers so we're lenient; only rejecting the truly obvious mistakes.
    const okExt = /\.(mp4|mov|mkv|avi|webm|m4v|mpg|mpeg)$/i.test(file.originalname || '');
    const okMime = /^video\//.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('Only video files are accepted'));
  },
});

app.post('/analyze-video', analyzeUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'video file required (field name "video")' });
  const jobId = req._analyzeJobId;
  const userId = req.user.uid;
  const inputPath = req.file.path;
  const outputPath = path.join(path.dirname(inputPath), `${jobId}_out.mp4`);

  // Options the client can pass alongside the file. All optional.
  //   loiteringSeconds: dwell time override
  //   downscale: 0..1 processing scale
  //   useEnrollment: 'true' → run face recognition against the user's enrolled faces
  const opts = req.body || {};
  const loiteringSeconds = Math.max(1, Math.min(600, Number(opts.loiteringSeconds) || 30));
  const downscale = Math.max(0.2, Math.min(1.0, Number(opts.downscale) || 0.5));
  const useEnrollment = String(opts.useEnrollment || 'true') === 'true';
  // Fire detection is off by default in the offline analyzer — the HSV
  // heuristic false-positives on brake lights and daytime warm surfaces,
  // which is the exact kind of footage users tend to upload for testing.
  const detectFire = String(opts.detectFire || 'false') === 'true';
  // Person sensitivity presets — expose a curated dropdown rather than raw numbers.
  const PERSON_PRESETS = {
    high:     { conf: 0.30, minArea: 0.002 },
    balanced: { conf: 0.40, minArea: 0.005 },  // default — tuned for wide street shots
    strict:   { conf: 0.60, minArea: 0.05  },  // near-camera CCTV (original detect.py values)
  };
  const preset = PERSON_PRESETS[opts.personSensitivity] || PERSON_PRESETS.balanced;

  const args = [
    '-u', ANALYZER, inputPath,
    '-o', outputPath,
    '--downscale', String(downscale),
    '--loitering-seconds', String(loiteringSeconds),
    '--person-conf', String(preset.conf),
    '--person-min-area', String(preset.minArea),
    '--progress-json',
  ];
  if (!detectFire) args.push('--no-fire');
  if (useEnrollment) {
    args.push('--enrollment-dir', db.userEnrollmentDir(userId));
  }

  const job = {
    userId, status: 'running', progress: 0, frame: 0, totalFrames: 0,
    fps: 0, etaSeconds: null, error: null,
    inputPath, outputPath, originalName: req.file.originalname || 'video',
    startedAt: Date.now(), finishedAt: null, proc: null,
    lastEmitAt: 0,
  };
  analyzeJobs.set(jobId, job);
  res.status(202).json({ jobId });

  console.log(`[analyze] job ${jobId} user ${userId} — ${req.file.originalname} (${req.file.size} bytes)`);

  // Spawn the analyzer. Same Python interpreter as detect.py.
  const proc = spawn(PYTHON, args, {
    cwd: path.dirname(ANALYZER),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.proc = proc;

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // Progress JSON lines look like: {"type":"progress","frame":N,"total":M,"fps":X,"eta":Y}
      // Anything else is human-readable and printed to the console.
      if (line.startsWith('{')) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'progress') {
            job.frame = msg.frame; job.totalFrames = msg.total;
            job.progress = msg.total ? msg.frame / msg.total : 0;
            job.fps = msg.fps; job.etaSeconds = msg.eta;
            // Throttle wire chatter — a 4 FPS analyzer would otherwise flood the socket.
            const now = Date.now();
            if (now - job.lastEmitAt >= 250 || msg.frame === msg.total) {
              job.lastEmitAt = now;
              emitToUser(userId, 'analyze_progress', {
                jobId, status: 'running', frame: job.frame, totalFrames: job.totalFrames,
                progress: job.progress, fps: job.fps, etaSeconds: job.etaSeconds,
              });
            }
            continue;
          }
          if (msg.type === 'phase') {
            // Post-detection stages (ffmpeg re-encode) — bar stays at 100% but
            // we swap the label so the UI doesn't look frozen.
            job.phase = msg.name;
            emitToUser(userId, 'analyze_progress', {
              jobId, status: 'running', phase: msg.name,
              progress: job.progress || 1,
              frame: job.frame, totalFrames: job.totalFrames,
            });
            continue;
          }
        } catch { /* fall through to raw log */ }
      }
      console.log(`[analyze:${jobId.slice(0,8)}] ${line}`);
    }
  });

  proc.stderr.on('data', (d) => {
    const txt = d.toString().trim();
    if (txt) console.error(`[analyze:${jobId.slice(0,8)}] ${txt}`);
  });

  proc.on('exit', (code) => {
    job.finishedAt = Date.now();
    job.proc = null;
    if (code === 0 && fs.existsSync(outputPath)) {
      job.status = 'done'; job.progress = 1;
      emitToUser(userId, 'analyze_progress', {
        jobId, status: 'done', progress: 1,
        outputUrl: `/analyze-video/${jobId}/output`,
      });
      console.log(`[analyze] job ${jobId} done — ${outputPath}`);
    } else {
      job.status = 'error';
      job.error = code === 0 ? 'analyzer produced no output' : `analyzer exited ${code}`;
      emitToUser(userId, 'analyze_progress', {
        jobId, status: 'error', error: job.error,
      });
      console.error(`[analyze] job ${jobId} failed (${job.error})`);
    }
  });
});

app.get('/analyze-video/:id', (req, res) => {
  const job = analyzeJobs.get(req.params.id);
  if (!job || job.userId !== req.user.uid) return res.status(404).json({ error: 'not found' });
  const { proc, ...safe } = job; // don't leak the process handle
  res.json({
    jobId: req.params.id,
    ...safe,
    outputUrl: job.status === 'done' ? `/analyze-video/${req.params.id}/output` : null,
  });
});

app.get('/analyze-video/:id/output', (req, res) => {
  const job = analyzeJobs.get(req.params.id);
  if (!job || job.userId !== req.user.uid) return res.status(404).json({ error: 'not found' });
  if (job.status !== 'done') return res.status(409).json({ error: 'not ready' });
  // Constrain path to ANALYZE_ROOT so a spoofed jobId can't traverse.
  const abs = path.resolve(job.outputPath);
  if (!abs.startsWith(path.resolve(ANALYZE_ROOT))) return res.status(403).json({ error: 'forbidden' });
  const stat = (() => { try { return fs.statSync(abs); } catch { return null; } })();
  if (!stat) return res.status(410).json({ error: 'output missing' });

  const size = stat.size;
  const range = req.headers.range;
  // Range support is what lets <video> stream + seek without slurping the whole
  // file. Chrome in particular refuses to play videos > ~100 MB delivered as
  // one big blob without Range, and reports "Failed to fetch" for the client
  // fetch() variant. Standard `bytes=start-end` (or `bytes=start-`) suffix.
  const commonHeaders = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start >= size || end < start) {
      return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }
    res.writeHead(206, {
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', (err) => { console.error('[analyze] stream err:', err.message); res.destroy(); });
    stream.pipe(res);
    return;
  }

  // Full-file response.
  res.writeHead(200, { ...commonHeaders, 'Content-Length': size });
  const stream = fs.createReadStream(abs);
  stream.on('error', (err) => { console.error('[analyze] stream err:', err.message); res.destroy(); });
  stream.pipe(res);
});

app.delete('/analyze-video/:id', (req, res) => {
  const job = analyzeJobs.get(req.params.id);
  if (!job || job.userId !== req.user.uid) return res.status(404).json({ error: 'not found' });
  if (job.proc) try { job.proc.kill(); } catch {}
  for (const p of [job.inputPath, job.outputPath]) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  analyzeJobs.delete(req.params.id);
  res.json({ ok: true });
});

// ── Camera helpers ────────────────────────────────────────────
async function spawnCameraStack({ userId, streamId, pathName, rtspUrl, cameraName }) {
  // 1. Tell MediaMTX to register the path
  try {
    await axios.post(`${MEDIAMTX_API}/v3/config/paths/add/${pathName}`, {});
  } catch (err) {
    // If the path already exists (warm restart), ignore.
    const detail = err.response?.data || {};
    if (detail.error && /already/i.test(detail.error)) {
      // ok — already registered
    } else {
      throw err;
    }
  }

  const localRtspUrl = `rtsp://127.0.0.1:8554/${pathName}`;
  activeStreams.set(streamId, { userId, cameraName, rtspUrl, pathName, hlsUrl: `${HLS_BASE}/${pathName}/` });

  sendWorkerCmd({
    cmd: 'add',
    streamId,
    rtspUrl: localRtspUrl,
    enrollmentDir: db.userEnrollmentDir(userId),
  });

  const backendUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[Backend] Auto-starting agent for: ${cameraName} (user ${userId})`);
  const agentProc = spawn(PYTHON, [AGENT_SCRIPT, backendUrl, pathName, rtspUrl]);

  agentProc.stdout.on('data', (d) => {
    const txt = d.toString().trim();
    if (txt) {
      console.log(`[Agent ${pathName}] ${txt}`);
      if (txt.includes('[Agent]')) {
        emitToUser(userId, 'agent_status', { streamId, message: txt });
      }
    }
  });
  agentProc.stderr.on('data', (d) => console.error(`[Agent ${pathName} Error] ${d.toString()}`));
  agentProc.on('error', (err) => console.error(`[Backend] agent spawn failed for ${cameraName}:`, err));

  activeAgents.set(streamId, agentProc);
}

async function teardownCameraStack(streamId) {
  const stream = activeStreams.get(streamId);
  sendWorkerCmd({ cmd: 'remove', streamId });

  const agentProc = activeAgents.get(streamId);
  if (agentProc) { agentProc.kill(); activeAgents.delete(streamId); }

  if (stream) {
    try {
      await axios.post(`${MEDIAMTX_API}/v3/config/paths/remove/${stream.pathName}`);
    } catch (err) {
      console.warn(`MediaMTX remove failed: ${err.message}`);
    }
  }
  activeStreams.delete(streamId);
}

// ── Camera routes (user-scoped) ───────────────────────────────
function parseCoord(v, min, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) return null;
  return n;
}

app.post('/add-camera', async (req, res) => {
  const userId = req.user.uid;
  const { rtspUrl, cameraName } = req.body || {};
  if (!rtspUrl || !cameraName) {
    return res.status(400).json({ error: 'rtspUrl and cameraName are required' });
  }
  // Coordinates are optional but, if supplied, must be valid WGS-84 ranges.
  const lat = parseCoord(req.body.lat, -90, 90);
  const lng = parseCoord(req.body.lng, -180, 180);

  const streamId = uuidv4();
  const pathName = `camera_${streamId.replace(/-/g, '_')}`;

  try {
    await db.getPool().query(
      'INSERT INTO cameras (user_id, stream_id, camera_name, rtsp_url, path_name, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, streamId, cameraName, rtspUrl, pathName, lat, lng],
    );
  } catch (err) {
    return res.status(500).json({ error: `db insert failed: ${err.message}` });
  }

  try {
    await spawnCameraStack({ userId, streamId, pathName, rtspUrl, cameraName });
  } catch (err) {
    console.error('[Backend] MediaMTX/agent setup failed:', err.response?.data || err.message);
    await db.getPool().query('DELETE FROM cameras WHERE stream_id = ?', [streamId]);
    return res.status(502).json({
      error: `setup failed: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
    });
  }

  const hlsUrl = `${HLS_BASE}/${pathName}/`;
  res.json({ streamId, cameraName, hlsUrl, streamKey: pathName, rtspUrl, agentStarted: true });
});

app.delete('/camera/:id', async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;

  // Verify ownership before doing anything destructive.
  const [rows] = await db.getPool().query(
    'SELECT stream_id FROM cameras WHERE stream_id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'stream not found' });

  await teardownCameraStack(id);
  await db.getPool().query('DELETE FROM cameras WHERE stream_id = ?', [id]);
  res.json({ ok: true });
});

app.get('/cameras', async (req, res) => {
  const userId = req.user.uid;
  const [rows] = await db.getPool().query(
    'SELECT stream_id AS streamId, camera_name AS cameraName, rtsp_url AS rtspUrl, path_name AS pathName, lat, lng FROM cameras WHERE user_id = ?',
    [userId],
  );
  res.json(rows.map((r) => ({
    ...r,
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    hlsUrl: `${HLS_BASE}/${r.pathName}/`,
  })));
});

// Update an existing camera's location (used by the map's "drag pin" UX
// or by editing the camera in the Cameras table).
app.put('/camera/:id', async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;
  const lat = parseCoord(req.body?.lat, -90, 90);
  const lng = parseCoord(req.body?.lng, -180, 180);
  try {
    const [r] = await db.getPool().query(
      'UPDATE cameras SET lat = ?, lng = ? WHERE stream_id = ? AND user_id = ?',
      [lat, lng, id, userId],
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'camera not found' });
    res.json({ streamId: id, lat, lng });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Enrollment routes (user-scoped) ───────────────────────────
function sanitizeName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function userDir(userId) {
  const dir = db.userEnrollmentDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Person types we support. Anything else falls back to 'standard' on write.
const ENROLLMENT_TYPES = new Set(['standard', 'staff', 'vip', 'visitor', 'threat']);
const normalizeType = (t) => (ENROLLMENT_TYPES.has(t) ? t : 'standard');

function nextEnrollmentSlot(dir, safe) {
  let i = 1;
  while (true) {
    const taken = ['jpg', 'jpeg', 'png'].some((e) =>
      fs.existsSync(path.join(dir, `${safe}_${i}.${e}`)),
    );
    if (!taken) return i;
    i++;
  }
}

function writeOnePhoto(dir, safe, base64) {
  const m = base64.match(/^data:image\/(\w+);base64,(.*)$/);
  const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
  const data = m ? m[2] : base64;
  if (!['jpg', 'jpeg', 'png'].includes(ext)) {
    throw new Error(`unsupported image type "${ext}" — must be jpg or png`);
  }
  const idx = nextEnrollmentSlot(dir, safe);
  const filePath = path.join(dir, `${safe}_${idx}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  return idx;
}

// POST /enroll
//   body: { name, type?, imagesBase64?: string[], imageBase64?: string }   <- legacy single
// Creates the person if missing, or appends photos to an existing person.
app.post('/enroll', async (req, res) => {
  const userId = req.user.uid;
  const { name, type, imageBase64, imagesBase64 } = req.body || {};
  const images = Array.isArray(imagesBase64) ? imagesBase64
               : imageBase64 ? [imageBase64]
               : [];
  if (!name || images.length === 0) {
    return res.status(400).json({ error: 'name and at least one image required' });
  }
  const safe = sanitizeName(name);
  if (!safe) return res.status(400).json({ error: 'invalid name' });

  const dir = userDir(userId);
  const written = [];
  try {
    for (const img of images) {
      written.push(writeOnePhoto(dir, safe, img));
    }
  } catch (err) {
    // Best-effort cleanup of any photos already written this call.
    for (const idx of written) {
      for (const ext of ['jpg', 'jpeg', 'png']) {
        const p = path.join(dir, `${safe}_${idx}.${ext}`);
        if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {}
      }
    }
    return res.status(500).json({ error: `save failed: ${err.message}` });
  }

  // Upsert the metadata row. Type defaults to 'standard' on first creation.
  try {
    await db.getPool().query(
      `INSERT INTO enrollments (user_id, name, type)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE type = IF(VALUES(type) = 'standard' AND type <> 'standard', type, VALUES(type))`,
      [userId, safe, normalizeType(type)],
    );
  } catch (err) {
    console.error('[enroll] DB upsert failed:', err.message);
  }

  invalidateEnrollmentTypes(userId);
  fs.utimesSync(dir, new Date(), new Date());
  res.json({ name: safe, photosAdded: written.length, slots: written });
});

// GET /enrollments
// Returns one entry per enrolled person with type + photo count. Auto-heals
// metadata: if photos exist on disk but no DB row, we lazy-insert one with
// the default 'standard' type so legacy enrollments show up correctly.
app.get('/enrollments', async (req, res) => {
  const userId = req.user.uid;
  const dir = userDir(userId);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  } catch { /* dir missing — empty list */ }

  // Group photos by base name (strip _<idx> suffix).
  const photosByName = new Map();
  for (const f of files) {
    const stem = path.parse(f).name;
    const base = stem.replace(/_\d+$/, '');
    if (!photosByName.has(base)) photosByName.set(base, []);
    photosByName.get(base).push(f);
  }

  let metaRows = [];
  try {
    const [r] = await db.getPool().query(
      'SELECT name, type, notes, created_at, updated_at FROM enrollments WHERE user_id = ?',
      [userId],
    );
    metaRows = r;
  } catch (err) {
    console.error('[enrollments] DB read failed:', err.message);
  }
  const metaByName = new Map(metaRows.map((m) => [m.name, m]));

  // Lazy-create rows for filesystem-only enrollments.
  const missing = [...photosByName.keys()].filter((n) => !metaByName.has(n));
  if (missing.length) {
    try {
      const values = missing.map((n) => [userId, n, 'standard']);
      await db.getPool().query(
        'INSERT IGNORE INTO enrollments (user_id, name, type) VALUES ?',
        [values],
      );
      for (const n of missing) metaByName.set(n, { name: n, type: 'standard' });
    } catch { /* race or readonly — tolerate */ }
  }

  const out = [...photosByName.entries()].map(([name, fs_]) => {
    const m = metaByName.get(name) || {};
    return {
      name,
      type: m.type || 'standard',
      notes: m.notes || null,
      photoCount: fs_.length,
      file: fs_[0], // primary photo, used for the avatar
    };
  });
  res.json(out.sort((a, b) => a.name.localeCompare(b.name)));
});

// PUT /enrollment/:name   body: { type?, notes? }
app.put('/enrollment/:name', async (req, res) => {
  const userId = req.user.uid;
  const safe = sanitizeName(req.params.name);
  if (!safe) return res.status(400).json({ error: 'invalid name' });

  const update = {};
  if (typeof req.body?.type === 'string')  update.type  = normalizeType(req.body.type);
  if (typeof req.body?.notes === 'string') update.notes = req.body.notes.slice(0, 500);
  if (!Object.keys(update).length) {
    return res.status(400).json({ error: 'nothing to update (type or notes)' });
  }

  const cols = Object.keys(update);
  const vals = Object.values(update);
  const setSql = cols.map((k) => `${k} = ?`).join(', ');
  try {
    await db.getPool().query(
      `INSERT INTO enrollments (user_id, name, ${cols.join(', ')})
       VALUES (?, ?, ${cols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${setSql}`,
      [userId, safe, ...vals, ...vals],
    );
    invalidateEnrollmentTypes(userId);
    // Bump dir mtime so the AI worker reloads the centroids+types map.
    try { fs.utimesSync(userDir(userId), new Date(), new Date()); } catch {}
    res.json({ name: safe, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/enrollment/:name', async (req, res) => {
  const userId = req.user.uid;
  const dir = userDir(userId);
  const safe = sanitizeName(req.params.name);
  let removed = 0;
  const files = fs.readdirSync(dir).filter((f) =>
    new RegExp(`^${safe}(_\\d+)?\\.(jpg|jpeg|png)$`, 'i').test(f),
  );
  for (const f of files) {
    fs.unlinkSync(path.join(dir, f));
    removed++;
  }
  try {
    await db.getPool().query('DELETE FROM enrollments WHERE user_id = ? AND name = ?', [userId, safe]);
  } catch (err) {
    console.error('[enrollment delete] DB failed:', err.message);
  }
  invalidateEnrollmentTypes(userId);
  if (removed) fs.utimesSync(dir, new Date(), new Date());
  res.json({ removed });
});

app.get('/enrollment/:name/image', (req, res) => {
  const userId = req.user.uid;
  const dir = userDir(userId);
  const safe = sanitizeName(req.params.name);
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const p1 = path.join(dir, `${safe}_1.${ext}`);
    if (fs.existsSync(p1)) return res.sendFile(p1);
    const p = path.join(dir, `${safe}.${ext}`);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

// ── Feature flags (user-scoped) ───────────────────────────────
app.get('/features', async (req, res) => {
  const userId = req.user.uid;
  try {
    const [rows] = await db.getPool().query(
      'SELECT name, enabled, description, updated_at FROM features WHERE user_id = ? ORDER BY name',
      [userId],
    );
    res.json(rows.map((r) => ({ ...r, enabled: !!r.enabled })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/features/:name', async (req, res) => {
  const userId = req.user.uid;
  const { name } = req.params;
  const enabled = req.body?.enabled ? 1 : 0;
  try {
    const [r] = await db.getPool().query(
      'UPDATE features SET enabled = ? WHERE user_id = ? AND name = ?',
      [enabled, userId, name],
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'unknown feature' });
    await refreshFeatures(userId);
    res.json({ name, enabled: !!enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Snapshot serving (ownership-checked) ──────────────────────
// Stored on disk as face-ai/snapshots/<streamId>/<ts>.jpg by the AI worker.
// We verify the requesting user owns the stream (live activeStreams first,
// then the cameras DB) before serving the file. Strict pathing so a bad
// streamId/filename can't escape SNAPSHOT_ROOT.
app.get('/snapshot/:streamId/:file', async (req, res) => {
  const userId = req.user.uid;
  const { streamId, file } = req.params;
  if (!/^[A-Za-z0-9._-]+$/.test(streamId) || !/^[\d._-]+\.jpg$/i.test(file)) {
    return res.status(400).json({ error: 'invalid path' });
  }

  // Ownership check: try in-memory first (covers live cameras + demo seeds),
  // fall back to DB so we still serve snapshots after a backend restart.
  let owned = activeStreams.get(streamId)?.userId === userId;
  if (!owned) {
    try {
      const [rows] = await db.getPool().query(
        'SELECT 1 FROM cameras WHERE stream_id = ? AND user_id = ? LIMIT 1',
        [streamId, userId],
      );
      owned = rows.length > 0;
    } catch { /* ignore */ }
  }
  if (!owned) {
    // Also tolerate snapshots written for cameras that have since been
    // removed: if any incident with this snapshot belongs to the user, allow.
    try {
      const [rows] = await db.getPool().query(
        'SELECT 1 FROM incidents WHERE user_id = ? AND snapshot_path = ? LIMIT 1',
        [userId, `${streamId}/${file}`],
      );
      owned = rows.length > 0;
    } catch { /* ignore */ }
  }
  if (!owned) return res.status(404).end();

  const abs = path.join(SNAPSHOT_ROOT, streamId, file);
  if (!abs.startsWith(SNAPSHOT_ROOT + path.sep)) return res.status(400).end();
  res.sendFile(abs, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── Incidents (user-scoped) ───────────────────────────────────
app.get('/incidents', async (req, res) => {
  const userId = req.user.uid;
  const { streamId, type, since } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const where = ['user_id = ?'];
  const params = [userId];
  if (streamId) { where.push('stream_id = ?'); params.push(streamId); }
  if (type) {
    // Accept comma-separated list so callers can ask for ?type=fire,smoke
    // without firing two requests. Single values still work as before.
    const types = String(type).split(',').map((t) => t.trim()).filter(Boolean);
    if (types.length === 1) {
      where.push('type = ?'); params.push(types[0]);
    } else if (types.length > 1) {
      where.push(`type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
  if (since)    { where.push('created_at >= ?'); params.push(new Date(since)); }
  // "Incidents" filter: fire/smoke OR a recognized (named) face. Unnamed
  // face detections and motion (person) events are excluded — those live
  // in the dashboard's general "Recent Events" feed instead.
  if (req.query.incidentsOnly === 'true' || req.query.incidentsOnly === '1') {
    where.push("(type IN ('fire','smoke') OR (type = 'face' AND name IS NOT NULL AND name <> ''))");
  }
  const sql = `SELECT id, stream_id AS streamId, camera_name AS cameraName, type, name, confidence, bbox_json AS bbox, snapshot_path AS snapshot, created_at AS createdAt
               FROM incidents WHERE ${where.join(' AND ')}
               ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  try {
    const [rows] = await db.getPool().query(sql, params);
    for (const r of rows) {
      try { r.bbox = r.bbox ? JSON.parse(r.bbox) : null; } catch { /* leave as string */ }
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── System health ─────────────────────────────────────────────
const SERVER_BOOT = Date.now();

app.get('/system-health', async (_req, res) => {
  let mediamtx = false;
  try {
    await axios.get(`${MEDIAMTX_API}/v3/config/global/get`, { timeout: 1500 });
    mediamtx = true;
  } catch { /* unreachable */ }

  const aiWorker = !!masterWorker && !masterWorker.killed;

  let storage = null;
  try {
    const stat = await fs.promises.statfs(path.join(__dirname, '..', 'mediamtx'));
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free  = Number(stat.bavail) * Number(stat.bsize);
    storage = { total, free, used: total - free };
  } catch { /* statfs not supported */ }

  const cameras = { live: 0, connecting: 0, offline: 0 };
  // Frontend tracks per-tile state; backend only knows what it spawned.
  for (const _ of activeStreams.values()) cameras.live++;

  res.json({
    uptimeMs: Date.now() - SERVER_BOOT,
    mediamtx,
    aiWorker,
    storage,
    cameras,
  });
});

// ── Analytics (per user) ──────────────────────────────────────
app.get('/analytics', async (req, res) => {
  const userId = req.user.uid;
  const period = req.query.period || 'today';

  let since, sincePrior;
  const now = new Date();
  if (period === '7d') {
    since      = new Date(now.getTime() - 7  * 24 * 3600 * 1000);
    sincePrior = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  } else if (period === '24h') {
    since      = new Date(now.getTime() - 24 * 3600 * 1000);
    sincePrior = new Date(now.getTime() - 48 * 3600 * 1000);
  } else {
    since = new Date(now); since.setHours(0, 0, 0, 0);
    sincePrior = new Date(since); sincePrior.setDate(sincePrior.getDate() - 1);
  }

  const stats = (rows) => ({
    people:     Number(rows[0].people || 0),
    recognized: Number(rows[0].recognized || 0),
    events:     Number(rows[0].events || 0),
    alerts:     Number(rows[0].alerts || 0),
  });
  const sql = `
    SELECT
      SUM(CASE WHEN type IN ('person','face') THEN 1 ELSE 0 END) AS people,
      COUNT(DISTINCT CASE WHEN name IS NOT NULL THEN name END)   AS recognized,
      COUNT(*) AS events,
      SUM(CASE WHEN type IN ('fire','smoke') THEN 1 ELSE 0 END)  AS alerts
    FROM incidents WHERE user_id = ? AND created_at >= ? AND created_at < ?
  `;
  try {
    const pool = db.getPool();
    const [curr] = await pool.query(sql, [userId, since, now]);
    const [prev] = await pool.query(sql, [userId, sincePrior, since]);
    const c = stats(curr), p = stats(prev);
    const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 100 : 0));
    res.json({
      period,
      counts: c,
      deltas: {
        people: pct(c.people, p.people),
        recognized: pct(c.recognized, p.recognized),
        events: pct(c.events, p.events),
        alerts: pct(c.alerts, p.alerts),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Per-person activity (drill-down from the People page) ─────
// Note on the name shapes: enrollments.name is the sanitized form (spaces
// → underscores) but incidents.name is the display form (returned by the
// AI worker via `k.replace('_', ' ')`). The endpoint accepts either and
// matches on the display form for incidents.
app.get('/person/:name/activity', async (req, res) => {
  const userId = req.user.uid;
  const safe = sanitizeName(req.params.name);
  if (!safe) return res.status(400).json({ error: 'invalid name' });
  const displayName = safe.replace(/_/g, ' ');
  // Window: either a single calendar day (`date=YYYY-MM-DD`) or rolling
  // `days=N`. Single-day mode is what the daywise table's "View details"
  // button uses to drill into one row.
  //
  // For single-day mode we pass the bounds as plain `YYYY-MM-DD HH:MM:SS`
  // strings — MySQL then interprets them in *its* session TZ, the same TZ
  // that the daywise endpoint's `DATE(created_at)` GROUP BY uses. Passing
  // JS Date objects here would round-trip through Node's local TZ via
  // mysql2 — when MySQL's session TZ differs (the common case on a fresh
  // install: MySQL UTC, Node local) you get an off-by-N-hours window that
  // silently excludes the rows the user was just looking at.
  let since, until, days = null, dateStr = null;
  const dateMatch = String(req.query.date || '').match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) {
    dateStr = dateMatch[1];
    // Compute "next day" textually so we don't introduce TZ drift in JS.
    const [y, m, d] = dateStr.split('-').map(Number);
    const nextUtc = new Date(Date.UTC(y, m - 1, d + 1));
    const nextStr = nextUtc.toISOString().slice(0, 10);
    since = `${dateStr} 00:00:00`;
    until = `${nextStr} 00:00:00`;
  } else {
    days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
    since = new Date(Date.now() - days * 24 * 3600 * 1000);
    until = new Date(Date.now() + 24 * 3600 * 1000); // future-safe upper bound
  }
  const pool = db.getPool();

  try {
    const [metaRows] = await pool.query(
      'SELECT name, type, notes FROM enrollments WHERE user_id = ? AND name = ? LIMIT 1',
      [userId, safe],
    );
    if (metaRows.length === 0) return res.status(404).json({ error: 'person not found' });
    const meta = metaRows[0];

    // All queries below only look at recognized face detections for this name,
    // within the chosen window. `until` is always present so the single-day
    // and rolling-window paths share the same SQL.
    const baseWhere = `user_id = ? AND name = ? AND type = 'face' AND created_at >= ? AND created_at < ?`;
    const baseArgs = [userId, displayName, since, until];

    const [summaryRows] = await pool.query(
      `SELECT COUNT(*) AS total,
              MIN(created_at) AS firstSeen,
              MAX(created_at) AS lastSeen,
              COUNT(DISTINCT camera_name) AS distinctCameras,
              COUNT(DISTINCT DATE(created_at)) AS distinctDays
       FROM incidents WHERE ${baseWhere}`,
      baseArgs,
    );
    const s = summaryRows[0];

    const [byCamera] = await pool.query(
      `SELECT IFNULL(camera_name, 'Unknown') AS camera, COUNT(*) AS n
       FROM incidents WHERE ${baseWhere}
       GROUP BY camera ORDER BY n DESC LIMIT 10`,
      baseArgs,
    );

    const [byHourRaw] = await pool.query(
      `SELECT HOUR(created_at) AS hour, COUNT(*) AS n
       FROM incidents WHERE ${baseWhere}
       GROUP BY hour`,
      baseArgs,
    );
    const byHour = Array(24).fill(0);
    for (const r of byHourRaw) byHour[r.hour] = Number(r.n);

    const [byDay] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS n
       FROM incidents WHERE ${baseWhere}
       GROUP BY day ORDER BY day`,
      baseArgs,
    );

    // Timeline rows carry their camera's lat/lng (when set) so the activity
    // page can plot a movement path. Self-LEFT-JOIN on user + camera name —
    // if a camera was renamed or deleted, lat/lng come back NULL and the
    // frontend simply skips that stop on the path map.
    const [timeline] = await pool.query(
      `SELECT i.id, i.camera_name AS cameraName, i.confidence,
              i.snapshot_path AS snapshot, i.created_at AS createdAt,
              c.lat, c.lng
       FROM incidents i
       LEFT JOIN cameras c
         ON c.user_id = i.user_id AND c.camera_name = i.camera_name
       WHERE i.user_id = ? AND i.name = ? AND i.type = 'face'
             AND i.created_at >= ? AND i.created_at < ?
       ORDER BY i.created_at DESC LIMIT 100`,
      baseArgs,
    );

    res.json({
      name: safe,
      displayName,
      type: meta.type,
      notes: meta.notes,
      days,
      date: dateStr,
      summary: {
        total: Number(s.total || 0),
        firstSeen: s.firstSeen,
        lastSeen:  s.lastSeen,
        distinctCameras: Number(s.distinctCameras || 0),
        distinctDays:    Number(s.distinctDays || 0),
      },
      byCamera,
      byHour,
      byDay: byDay.map((d) => ({
        day: (d.day instanceof Date) ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        n: Number(d.n),
      })),
      timeline: timeline.map((r) => ({
        ...r,
        lat: r.lat == null ? null : Number(r.lat),
        lng: r.lng == null ? null : Number(r.lng),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analytics charts (per user) ───────────────────────────────
// Returns aggregated data the Analytics page renders as SVG charts.
// Single endpoint = single round-trip; the data is small enough.
app.get('/analytics-charts', async (req, res) => {
  const userId = req.user.uid;
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, 90));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const pool = db.getPool();
  try {
    const [heatmap] = await pool.query(
      `SELECT (DAYOFWEEK(created_at) - 1) AS dow, HOUR(created_at) AS hour, COUNT(*) AS n
       FROM incidents
       WHERE user_id = ? AND created_at >= ?
       GROUP BY dow, hour`,
      [userId, since],
    );
    const [byType] = await pool.query(
      `SELECT type, COUNT(*) AS n
       FROM incidents
       WHERE user_id = ? AND created_at >= ?
       GROUP BY type
       ORDER BY n DESC`,
      [userId, since],
    );
    const [byCamera] = await pool.query(
      `SELECT IFNULL(camera_name, 'Unknown') AS camera, COUNT(*) AS n
       FROM incidents
       WHERE user_id = ? AND created_at >= ?
       GROUP BY camera
       ORDER BY n DESC
       LIMIT 10`,
      [userId, since],
    );
    const [byPerson] = await pool.query(
      `SELECT name, COUNT(*) AS n
       FROM incidents
       WHERE user_id = ? AND created_at >= ? AND name IS NOT NULL AND name <> ''
       GROUP BY name
       ORDER BY n DESC
       LIMIT 10`,
      [userId, since],
    );
    const [daily] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS n,
              SUM(CASE WHEN type IN ('fire','smoke') THEN 1 ELSE 0 END) AS alerts
       FROM incidents
       WHERE user_id = ? AND created_at >= ?
       GROUP BY day
       ORDER BY day`,
      [userId, since],
    );
    res.json({
      days,
      total: byType.reduce((s, r) => s + Number(r.n), 0),
      heatmap,
      byType,
      byCamera,
      byPerson,
      daily: daily.map((d) => ({
        day: (d.day instanceof Date) ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        n: Number(d.n),
        alerts: Number(d.alerts || 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analytics: day-wise per-person breakdown ──────────────────
// One row per (day, recognized person) for the requested window. Drives the
// "Daily activity by person" table on the Analytics page (each row links into
// the existing person-activity drill-down via "View details").
//
// Names live in two shapes (see /person/:name/activity for the full note):
//   - enrollments.name uses underscores (sanitized for disk filenames)
//   - incidents.name uses the display form with spaces (what the AI emits)
// We return the display form for `name` and derive `nameKey` (underscored)
// so the frontend can route into the activity page without a lookup.
app.get('/analytics-daywise', async (req, res) => {
  const userId = req.user.uid;
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, 90));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const pool = db.getPool();
  // GROUP_CONCAT default cap is 1024 chars — plenty for camera names, but a
  // very chatty install could exceed it. Bump the session limit just in case.
  const CAM_SEP = '|||';
  try {
    await pool.query('SET SESSION group_concat_max_len = 32768');
    const [rows] = await pool.query(
      `SELECT DATE(created_at) AS day,
              name,
              COUNT(*) AS n,
              MIN(created_at) AS firstSeen,
              MAX(created_at) AS lastSeen,
              GROUP_CONCAT(DISTINCT IFNULL(camera_name, 'Unknown')
                           ORDER BY camera_name SEPARATOR ?) AS cameras
       FROM incidents
       WHERE user_id = ? AND created_at >= ?
             AND name IS NOT NULL AND name <> ''
       GROUP BY day, name
       ORDER BY day DESC, n DESC, name ASC`,
      [CAM_SEP, userId, since],
    );
    res.json({
      days,
      rows: rows.map((r) => ({
        day: (r.day instanceof Date) ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
        name: r.name,
        nameKey: String(r.name).replace(/ /g, '_'),
        n: Number(r.n),
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        cameras: r.cameras ? String(r.cameras).split(CAM_SEP) : [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bootstrap persisted cameras on startup ────────────────────
// Cameras whose RTSP URL starts with this prefix are treated as decorative
// demo data (used to populate the Maps page on a fresh install). They get
// registered in-memory so /cameras and the map work, but no agent/AI/MediaMTX
// path is created — there's nothing real to bridge.
const DEMO_RTSP_PREFIX = 'rtsp://demo.';

async function bootstrapCamerasFromDb() {
  const [rows] = await db.getPool().query(
    'SELECT user_id AS userId, stream_id AS streamId, camera_name AS cameraName, rtsp_url AS rtspUrl, path_name AS pathName FROM cameras',
  );
  let real = 0, demo = 0;
  for (const c of rows) {
    if (typeof c.rtspUrl === 'string' && c.rtspUrl.startsWith(DEMO_RTSP_PREFIX)) {
      activeStreams.set(c.streamId, {
        userId: c.userId,
        cameraName: c.cameraName,
        rtspUrl: c.rtspUrl,
        pathName: c.pathName,
        hlsUrl: `${HLS_BASE}/${c.pathName}/`,
      });
      demo++;
      continue;
    }
    try {
      await spawnCameraStack(c);
      real++;
    } catch (err) {
      console.error(`[Backend] Failed to restore camera ${c.cameraName}:`, err.response?.data || err.message);
    }
  }
  if (real || demo) {
    console.log(`[Backend] Restored ${real} live + ${demo} demo camera(s) from DB`);
  }
}

// ── Shutdown ──────────────────────────────────────────────────
process.on('SIGINT', () => {
  sendWorkerCmd({ cmd: 'quit' });
  for (const agent of activeAgents.values()) agent.kill();
  setTimeout(() => {
    if (masterWorker) masterWorker.kill();
    process.exit(0);
  }, 500);
});

(async () => {
  try {
    await db.init();
    startMasterWorker();
    await bootstrapCamerasFromDb();
    server.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
  } catch (err) {
    console.error('[Backend] Startup failed:', err);
    process.exit(1);
  }
})();
