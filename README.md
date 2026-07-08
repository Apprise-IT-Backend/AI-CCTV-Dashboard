# AI CCTV Dashboard

Multi-user, multi-camera RTSP surveillance dashboard with live face recognition, person + vehicle tracking, loitering detection, Bangla license-plate ANPR, and fire/smoke detection. Ships with an offline **Analyze Video** module that runs the same pipeline over uploaded clips.

Four cooperating processes plus MySQL:

- **MediaMTX** — RTSP ingest + HLS re-publisher
- **Backend** ([backend/server.js](backend/server.js)) — Node/Express + Socket.IO + MySQL, JWT auth, spawns the AI worker + local push agent
- **Local agent** ([agent/agent.py](agent/agent.py)) — FFmpeg bridge from cameras to MediaMTX
- **AI worker** ([face-ai/detect.py](face-ai/detect.py)) — MediaPipe faces + FaceNet recognition + YOLOv8 persons/vehicles + ByteTrack + fire detector + Bangla ANPR, all in one process

For architectural detail see [CLAUDE.md](CLAUDE.md).

---

## Quick start

- **Windows** → [§ Windows setup](#windows-setup)
- **macOS** → [§ macOS setup](#macos-setup)

Both platforms need the same things — Node.js 20+, Python **3.12** (not 3.13/3.14 — `mediapipe` doesn't wheel for those yet), MySQL 8, FFmpeg, MediaMTX. The install commands differ.

---

## Windows setup

### 1. Install prerequisites

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.12
winget install Oracle.MySQL
```

**MediaMTX** — download the Windows zip from [github.com/bluenviron/mediamtx/releases](https://github.com/bluenviron/mediamtx/releases), extract `mediamtx.exe` and `mediamtx.yml` into the `mediamtx/` folder in this repo.

**FFmpeg** — the agent auto-downloads a portable `ffmpeg.exe` into `agent/` on first spawn, so nothing to install manually.

### 2. Clone

```powershell
git clone <repo-url> AI-face-recognition
cd AI-face-recognition
```

### 3. Install dependencies

```powershell
# Backend (Node)
cd backend
npm install
cd ..

# AI worker (Python 3.12) — full path used so it doesn't pick up 3.14
py -3.12 -m pip install --upgrade pip
py -3.12 -m pip install mediapipe facenet-pytorch ultralytics opencv-python numpy torch easyocr
```

The Python install pulls ~2.5 GB of wheels (torch + mediapipe + cv2 + easyocr). One-time cost.

### 4. (Optional) Fetch the Bangla plate detector

```powershell
curl.exe -L -o face-ai\plate_model.pt https://huggingface.co/Koushim/yolov8-license-plate-detection/resolve/main/best.pt
```

Skip if you don't need license-plate detection — the analyzer falls back to a contour-based ROI extractor.

### 5. Create `backend\.env`

Create the file `backend\.env` with this content — replace `<PYTHON_PATH>` with the full path to your Python 3.12 executable (usually `C:\Users\<you>\AppData\Local\Programs\Python\Python312\python.exe`):

```env
JWT_SECRET=change-me-to-a-long-random-string
JWT_EXPIRES_IN=12h

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=
DB_NAME=ai_cctv

ADMIN_USER=admin
ADMIN_PASS=admin123

INCIDENT_THROTTLE_MS=10000
FACE_COSINE_THRESHOLD=0.50
LOITERING_SECONDS=30

PYTHON=<PYTHON_PATH>
```

Generate a real `JWT_SECRET` with:
```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 6. (Optional) Seed demo data

Skip for a clean start — the backend auto-creates the DB, tables, and an `admin/admin123` user on first boot. For pre-populated demo users + sample cameras + ~120 incidents:

```powershell
mysql -u root < backend\schema.sql
```

Adds logins `admin/admin123`, `demo/demopass1`, `alice/alicepass1`.

### 7. Run

Easiest — double-click **`start.bat`** in the repo root. It launches MediaMTX, backend, and frontend in three minimized windows and prints the dashboard URL.

Manual, four terminals:

```powershell
# 1) MediaMTX (must start first)
cd mediamtx; .\mediamtx.exe

# 2) Backend
cd backend; npm start

# 3) Frontend (static server)
cd frontend; py -3.12 -m http.server 8080
```

Open **http://localhost:8080** and log in as `admin` / `admin123`.

---

## macOS setup

### 1. Install prerequisites

Assumes [Homebrew](https://brew.sh) is installed.

```bash
brew install python@3.12 node mysql ffmpeg mediamtx
brew services start mysql
```

Everything you need in one line.

### 2. Clone

```bash
git clone <repo-url> AI-face-recognition
cd AI-face-recognition
```

### 3. Install dependencies

```bash
# Backend (Node)
(cd backend && npm install)

# AI worker (Python 3.12)
python3.12 -m pip install --upgrade pip
python3.12 -m pip install mediapipe facenet-pytorch ultralytics opencv-python numpy torch easyocr
```

### 4. (Optional) Fetch the Bangla plate detector

```bash
curl -L -o face-ai/plate_model.pt \
  https://huggingface.co/Koushim/yolov8-license-plate-detection/resolve/main/best.pt
```

### 5. Create `backend/.env`

```bash
cat > backend/.env <<EOF
JWT_SECRET=$(openssl rand -base64 48)
JWT_EXPIRES_IN=12h

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=
DB_NAME=ai_cctv

ADMIN_USER=admin
ADMIN_PASS=admin123

INCIDENT_THROTTLE_MS=10000
FACE_COSINE_THRESHOLD=0.50
LOITERING_SECONDS=30

PYTHON=python3.12
EOF
```

`openssl rand -base64 48` generates a real random `JWT_SECRET` inline.

### 6. (Optional) Seed demo data

```bash
mysql -u root < backend/schema.sql
```

### 7. Run

Four terminal tabs:

```bash
# 1) MediaMTX (must start first)
mediamtx

# 2) Backend
cd backend && npm start

# 3) Frontend (static server)
cd frontend && python3.12 -m http.server 8080
```

Open **http://localhost:8080** and log in as `admin` / `admin123`.

**Optional wrapper** — drop this in `start.sh` at the repo root:

```bash
#!/usr/bin/env bash
set -euo pipefail
pkill -f mediamtx || true
pkill -f "python3.12 -m http.server 8080" || true
(mediamtx > /tmp/mediamtx.log 2>&1 &)
sleep 2
(cd backend && npm start > /tmp/backend.log 2>&1 &)
sleep 2
(cd frontend && python3.12 -m http.server 8080 > /tmp/frontend.log 2>&1 &)
echo "Dashboard: http://localhost:8080"
```

`chmod +x start.sh && ./start.sh`.

---

## First-run downloads (automatic)

These are cached locally on first use — no manual step, but the first invocation of each will pause while the file downloads.

| Asset | Size | Triggered by | Cached at |
|---|---:|---|---|
| YOLOv8n (`yolov8n.pt`) | ~6 MB | First person/vehicle detection | `face-ai/` |
| MediaPipe face `.tflite` | ~1 MB | Backend startup | `face-ai/` |
| FaceNet vggface2 | ~107 MB | First face embedding | `~/.cache/torch/checkpoints/` |
| EasyOCR bn + en | ~200 MB | First plate OCR call | `~/.EasyOCR/` |
| FFmpeg (Windows only) | ~30 MB | First agent spawn | `agent/ffmpeg.exe` |

---

## Common issues

**`No module named 'mediapipe'`** — you have Python 3.13 or 3.14 as default. `mediapipe` doesn't publish wheels for those yet. Install 3.12 (see step 1) and set `PYTHON` in `.env` to point at the 3.12 executable.

**`JWT_SECRET missing from environment`** — the backend throws at boot if `.env` is missing or lacks this line. Must live at `backend/.env` (not repo root).

**`ECONNREFUSED 127.0.0.1:3306`** — MySQL isn't running.
- Windows: `net start mysql`
- Mac: `brew services start mysql`

**`Failed to fetch` in the browser** — usually a stale JWT signed by a previous `JWT_SECRET`. Open DevTools → Console → `localStorage.clear(); location.reload()`.

**Analyzer output won't play in Windows Media Player** — OpenCV wrote `mp4v`, and the ffmpeg re-encode step didn't kick in. Ensure `agent/ffmpeg.exe` exists (or `ffmpeg` is on `PATH` for Mac). The analyzer logs `Codec: <tag>` on stdout so you can tell which encoder actually ran.

**Fire/smoke false positives on daytime footage** — expected with the HSV heuristic. Uncheck "Detect fire / smoke" in the Analyze Video form, or install a proper fire model via `python face-ai/download_fire_model.py`.

---

## Features overview

- **Live camera grid** — WebRTC-preferred / HLS fallback, per-camera detection overlay
- **Face recognition** — FaceNet embeddings, per-user enrollment dirs, cosine similarity matching
- **Person + vehicle tracking** — YOLOv8 detection with ByteTrack stable IDs
- **Loitering detection** — configurable dwell time (`LOITERING_SECONDS`), spatial re-association across ByteTrack ID switches
- **Bangla license-plate ANPR** — YOLO plate ROI (optional custom model) → EasyOCR Bangla + English → per-track voting buffer
- **Fire/smoke detection** — optional custom YOLO fire model, HSV fallback with three-frame flicker confirmation
- **Snapshot capture** — auto-triggered on incidents and recognized faces, browsable per-user
- **Analyze Video** — offline pipeline for recorded clips, produces annotated MP4 output with progress bar in the UI
- **Multi-tenant** — each user has their own enrollments, cameras, feature toggles, and incident history

---

## Directory layout

```
AI-face-recognition/
├─ agent/            # FFmpeg push agent (auto-spawned per camera)
├─ backend/          # Node.js + Express + Socket.IO + MySQL
│  ├─ server.js
│  ├─ auth.js
│  ├─ db.js
│  ├─ schema.sql     # Optional demo-data seed
│  └─ .env           # You create this (gitignored)
├─ face-ai/          # AI worker + analyzer
│  ├─ detect.py      # Live pipeline (one process per backend instance)
│  ├─ analyze_video.py  # Offline analyzer CLI
│  ├─ enrollments/   # Face enrollment images (per-user subdir)
│  ├─ snapshots/     # Auto-captured incident snapshots (gitignored)
│  └─ analyze_jobs/  # Upload + annotated output cache (gitignored)
├─ frontend/         # Static SPA (vanilla JS, hls.js, leaflet)
├─ mediamtx/         # RTSP/HLS server (binary + yml, both gitignored)
├─ CLAUDE.md         # Architecture reference
└─ README.md         # This file
```

---

## License

See [LICENSE](LICENSE).
