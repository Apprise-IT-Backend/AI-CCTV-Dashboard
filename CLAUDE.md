# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Multi-user, multi-camera RTSP dashboard with live person/face detection, FaceNet-based name recognition, fire/smoke incident detection, and persistent analytics. Four cooperating processes plus a MySQL database:

1. **MediaMTX** — RTSP ingest + HLS re-publishing.
2. **Backend** ([backend/server.js](backend/server.js), Node/Express + Socket.IO + MySQL) — JWT auth, persists cameras/users/incidents, registers MediaMTX paths, spawns the local push agent and the shared AI worker, fans out user-scoped detections to browsers.
3. **Local agent** ([agent/agent.py](agent/agent.py)) — FFmpeg bridge that pulls from a camera's RTSP URL and pushes to MediaMTX's `:8554` ingest. Auto-spawned by the backend; can also be run manually on a remote LAN.
4. **Master AI worker** ([face-ai/detect.py](face-ai/detect.py)) — a single Python process running MediaPipe face detection, **FaceNet (InceptionResnetV1 / vggface2) cosine-similarity recognition**, YOLOv8 person+vehicle detection with **ByteTrack** stable IDs, a fire detector, a **loitering** dwell-timer, a **Bangla license-plate ANPR** pipeline, and a **conveyor bag counter** ([face-ai/bag_counter.py](face-ai/bag_counter.py)) across all streams. **Per-user enrollment dirs → per-user recognizers**, all in one process.

## Running the stack

`start.bat` from the repo root launches MediaMTX, backend, and frontend in separate minimized windows. **It first kills any existing `node.exe`, `python.exe`, and `mediamtx.exe`** to avoid port conflicts — be aware if you have unrelated Python/Node processes running.

Manual equivalents:

- **MediaMTX** — `cd mediamtx && ./mediamtx.exe` (must start first; backend POSTs to its API at boot of each camera).
- **Backend** — `cd backend && npm start` (or `npm run dev` for nodemon). Listens on `:3000`. Reads `backend/.env`, initializes MySQL (creates DB + tables if missing, seeds `admin`/`admin123`), spawns the master AI worker, and re-spawns any persisted cameras.
- **Frontend** — `cd frontend && python -m http.server 8080`. Static files only; no build step.

`backend/.env` must define `JWT_SECRET` — the backend throws at boot if it's missing. Optional: `JWT_EXPIRES_IN` (default `12h`), `DB_HOST/PORT/USER/PASS/NAME` (defaults: `127.0.0.1:3306` root, no password, `ai_cctv`), `ADMIN_USER`/`ADMIN_PASS` (used only on first seed), `INCIDENT_THROTTLE_MS` (default `10000`), `FACE_COSINE_THRESHOLD` (default `0.50`), `PYTHON` (interpreter the backend spawns for `detect.py` and `agent.py`; default `python`).

[backend/schema.sql](backend/schema.sql) is an alternative to letting `db.init()` create tables — `mysql -u root < schema.sql` provisions a working DB with three seeded users (`admin`/`admin123`, `demo`/`demopass1`, `alice`/`alicepass1`) and ~120 sample incidents per user. The Node side will also self-bootstrap, so the SQL is mainly for fresh installs that want demo data.

Python deps for the AI worker: `ultralytics`, `opencv-python`, `mediapipe`, `numpy`, `torch`, `facenet-pytorch`, and (optional) `easyocr` — required for Bangla license-plate OCR. Without `easyocr`, plate *regions* are still detected/drawn but no plate string is read. **No `opencv-contrib-python` or `dlib` needed** — recognition is FaceNet, not LBPH. First run downloads ~107MB of FaceNet weights into `~/.cache/torch/checkpoints/`. First plate OCR call downloads ~200MB of EasyOCR weights into `~/.EasyOCR/`. The agent needs FFmpeg on PATH; on Windows it auto-downloads a portable `ffmpeg.exe` into `agent/` if missing.

Optional models: `face-ai/plate_model.pt` — a YOLOv8 checkpoint that detects license-plate regions. When present (and >1MB) it replaces the contour-based ROI fallback and dramatically improves recall on angled/low-light frames. Ships from `Koushim/yolov8-license-plate-detection` on Hugging Face (MIT, 6.2MB, single class `license_plate`). Downloadable with `curl -L -o face-ai/plate_model.pt https://huggingface.co/Koushim/yolov8-license-plate-detection/resolve/main/best.pt`. The Bangla side of ANPR lives entirely in EasyOCR's `bn` language pack — the detector just crops the plate ROI.

Optional models: `face-ai/bag_model.pt` — a single-class (`bag`) YOLOv8 checkpoint for conveyor counting. Entirely optional; without it the counter uses MOG2 motion segmentation inside the belt ROI, which is usually sufficient on a fixed camera. Same >1MB guard as the other optional models.

New env vars: `LOITERING_SECONDS` (default `30`) — dwell time before a tracked person is flagged as loitering. Bag-counter tuning knobs all live in [face-ai/bag_counter.py](face-ai/bag_counter.py) and are env-overridable: `BAG_MIN_AREA_RATIO`/`BAG_MAX_AREA_RATIO` (blob size as a fraction of the downscaled frame), `BAG_MIN_FILL`, `BAG_ASPECT_MIN`/`MAX`, `BAG_TRACK_MAX_DIST`, `BAG_TRACK_TTL_S`, `BAG_MIN_HITS`, `BAG_PERSON_IOU_MAX` (`1.0` disables the person veto), `BAG_MODEL_CONF`, `BAG_BG_HISTORY`, `BAG_BG_LEARNING_RATE`. **`BAG_BG_LEARNING_RATE` is the one that bites on a slow belt** — at the default auto rate, a bag that takes several seconds to cross overlaps its own pixels long enough for MOG2 to absorb it into the background, so it stops being detected mid-belt. Pin `0.001` to make the model adapt slowly. `BagCounter.stats` tallies per-filter rejections and `keep_mask`/`last_mask` expose the raw foreground mask; `count_bags.py --debug --mask-out m.mp4` surfaces both.

There is no test suite (`npm test` is a stub). [TESTING.md](TESTING.md) is effectively empty (a single whitespace line).

## Architecture

### Data flow for one camera

1. Browser POSTs `{ rtspUrl, cameraName, lat?, lng? }` to `POST /add-camera` ([backend/server.js:307](backend/server.js#L307)). All routes except `/login`, `/signup`, and `/streams/:key` require a Bearer JWT.
2. Backend persists the camera to MySQL (`cameras` table, `user_id` = JWT `uid`), mints `streamId` (UUID) and `pathName = camera_<streamId-with-underscores>`, then calls `POST http://127.0.0.1:9997/v3/config/paths/add/<pathName>` with an empty body — registering a publisher path with no `source`. **Paths are publisher endpoints, not pull sources.** Anything that pushes to `rtsp://127.0.0.1:8554/<pathName>` becomes the stream. An "already exists" error is tolerated (warm restart path).
3. Backend tells the master AI worker over stdin: `{cmd:"add", streamId, rtspUrl: "rtsp://127.0.0.1:8554/<pathName>", enrollmentDir: "<repo>/face-ai/enrollments/<userId>"}` ([backend/server.js:256](backend/server.js#L256)). **The worker reads MediaMTX's loopback re-stream, not the original camera URL.** This gives the worker low-latency, TCP-stable input even when the camera is across a flaky LAN. **The per-stream `enrollmentDir` is what makes recognition multi-tenant** — each user sees only their own enrollments.
4. Backend spawns `python agent/agent.py http://127.0.0.1:3000 <pathName> <rtspUrl>` ([backend/server.js:265](backend/server.js#L265)). The agent polls `GET /streams/<pathName>` (the only unauthenticated stream route), then runs `ffmpeg -rtsp_transport tcp -i <rtspUrl> -c copy -f rtsp <push-url>` to bridge into MediaMTX. Auto-reconnects with a 5s backoff.
5. Backend returns `hlsUrl = http://127.0.0.1:8888/<pathName>/`. Frontend appends `index.m3u8` and plays via hls.js.
6. Master worker emits one JSON line per processed frame on stdout: `{type:"detections", streamId, detections:[…], incidents:[…], snapshot: "<streamId>/<ts>.jpg" | null}`, plus `bagEvents:[…]` on the frames where a conveyor bag crossed the counting line. Backend looks up `userId` from `activeStreams`, augments detections with `personType` from the per-user enrollment-types cache, then emits via Socket.IO **only to that user's room** (`user:<userId>`) as **two separate events**: `face_detections` (persons + faces) and `incident_detections` (only when `incidents` is non-empty). Non-`detections` envelopes (`info`, `warning`, `error`, `ready`) are logged server-side. The event name `face_detections` is kept even though the payload mixes persons and faces — renaming would break the frontend listener.
7. Same envelope also drives `persistIncidents` ([backend/server.js:97](backend/server.js#L97)): each candidate (face with name, person, fire, smoke, loitering, plate) is checked against the user's `features` toggles (`face_detection`, `person_detection`, `fire_detection`, `loitering_detection`, `plate_detection`), then written to the `incidents` table with a per-`(streamId, type, name)` throttle of `INCIDENT_THROTTLE_MS`. For loitering, `name` is `Track #<id>`; for plates, `name` is the OCR'd plate string. The worker's snapshot path (if any) is stored on the row.

### Single shared AI worker

[backend/server.js:150](backend/server.js#L150) spawns ONE `detect.py` process at startup and pipes commands over stdin. The worker spawns one thread per `streamId` — adding a camera does not fork a new process. Stdin protocol: `{cmd:"add"|"remove"|"bagline"|"quit", streamId, rtspUrl?, enrollmentDir?, bagLine?}`. `bagline` enables / re-positions / disables bag counting on a running stream (`bagLine: null` = off) without tearing down the RTSP capture — the worker loop picks the pending value up on its next processed frame.

If the worker exits, the backend re-spawns it after 3s and replays `add` for every entry in `activeStreams`, **including each stream's `enrollmentDir` and `bagLine`**. Don't add per-process state in `detect.py` that can't survive an `add` replay — and don't keep a cumulative total there (see bag counting below).

Thread-safety: `face_detector_lock` (MediaPipe), `yolo_lock` (YOLOv8 + fire model), `_face_net_lock` (FaceNet GPU/CPU inference), `dir_recognizers_lock` (registry of per-dir centroid tables), and a per-`DirRecognizer.lock` for swapping centroids during a retrain. **If you add a model, give it its own lock — don't reuse an existing one.** When reading centroids for inference, grab them under the per-recognizer lock and release before running FaceNet, so all streams aren't serialized on a stale snapshot during a re-train.

### Per-stream state on the backend

Persisted in MySQL `cameras` table (key fields: `user_id`, `stream_id`, `camera_name`, `rtsp_url`, `path_name`, `lat`, `lng`, `bag_line_json`, `bag_reset_at`) plus two in-memory Maps:
- `activeStreams` — `streamId -> { userId, cameraName, rtspUrl, pathName, hlsUrl, bagLine }`. **`userId` is required** for the per-user Socket.IO fan-out, ownership checks on `/camera/:id`, `/snapshot/...`, and the per-user enrollment-types cache.
- `activeAgents` — child process handles for the auto-spawned `agent.py` instances.

On backend boot, `bootstrapCamerasFromDb()` ([backend/server.js:1071](backend/server.js#L1071)) reads the `cameras` table and respawns the full stack (MediaMTX path + AI worker `add` + agent) for each row. **Cameras whose `rtsp_url` starts with `rtsp://demo.`** are treated as decorative demo data — registered in `activeStreams` only, with no real agent/MediaMTX/AI activity. This is how the SQL-seeded sample cameras populate the Maps page without trying to connect to nonexistent hosts.

`DELETE /camera/:id` is ownership-checked against the DB before `teardownCameraStack` does all four: `sendWorkerCmd({cmd:"remove"})`, `agentProc.kill()`, `POST /v3/config/paths/remove/<pathName>` to MediaMTX, and the DB delete. Skipping any one leaks resources or zombie state.

### Coordinate contract between worker and frontend

Each detection is `{x, y, w, h, confidence, label, name?, personType?, trackId?, loitering?, dwellSeconds?, vehicleType?}` where `x/y/w/h` are **relative (0..1)** of the (downscaled) source frame. `label` is one of:
- `"face"` — MediaPipe. `name` is the FaceNet-matched enrollment (display form, spaces) or `null`. `personType` is `standard|staff|vip|visitor|threat`.
- `"person"` — YOLO. `trackId` (ByteTrack, stable across frames) is set when tracking is healthy. `loitering: true` + `dwellSeconds` are added when the person's dwell time exceeds `LOITERING_SECONDS`.
- `"vehicle"` — YOLO. `vehicleType` is `car|truck|bus|motorcycle`. Used to gate the plate pipeline.
- `"plate"` — the license-plate crop inside a tracked vehicle. `name` is the OCR'd plate string (Bangla+English, whitespace-collapsed) or `null` if OCR hasn't confirmed yet.
- `"bag"` — a conveyor bag candidate. `trackId` is the bag counter's own ID (**not** ByteTrack — the motion path has no YOLO boxes to attach IDs to). `counted: true` once that track has been tallied; the frontend colors counted bags green and uncounted violet.

Incidents are `{type, confidence, box:[x1,y1,x2,y2], ...}` — note `box` is **two corners** (xyxy), not `xywh`. Supported types: `"fire"`, `"smoke"`, `"loitering"` (extras: `trackId`, `dwellSeconds`), `"plate"` (extras: `plate` string, `trackId`, `vehicleType`). Frontend multiplies by `canvas.width/height` ([frontend/app.js:560](frontend/app.js#L560), [frontend/app.js:575](frontend/app.js#L575)). If you change one side of this contract, change the other.

### Frame throttling, capture, and downscale

Capture is decoupled from processing. `LatestFrameReader` ([face-ai/detect.py:249](face-ai/detect.py#L249)) runs a dedicated thread per stream that reads RTSP at native rate and overwrites a single-slot buffer. **This is the fix for "boxes 3-5s behind reality"** — OpenCV's default queues frames inside FFmpeg's decoder, so a slow consumer ends up processing frames from seconds ago. Old frames are dropped, latency cannot accumulate.

The processing thread throttles to `TARGET_FPS = 8` ([face-ai/detect.py:247](face-ai/detect.py#L247)) using a time-based sleep, not a frame counter. Each processed frame is downscaled to 0.5× before face detection and YOLO. The fire model (when loaded) runs on the **full-size** frame. The browser canvas auto-clears 1s after the last detection event, so if you slow the worker further, boxes will flicker.

`FRAME_SKIP = 5` at the top of `detect.py` is legacy — actual throttling is `TARGET_FPS` driven. Don't rely on the FRAME_SKIP constant when reasoning about cadence.

### Models and where they come from

- **MediaPipe face detector** — `face-ai/blaze_face_short_range.tflite`, auto-downloaded from Google Storage on first run if missing.
- **YOLOv8 base** — `face-ai/yolov8n.pt` (ultralytics auto-downloads if absent). Used for `person` boxes and the `fire`/`smoke` class names if the base happens to detect them.
- **Fire model** — `face-ai/fire_model.pt`, optional. Loaded only if the file exists AND is >1MB (the >1MB check guards against a corrupt/empty placeholder). When absent, fire detection falls back to a temporally-stabilized HSV heuristic in `stream_worker` ([face-ai/detect.py:472](face-ai/detect.py#L472)) that requires **hot-core + halo + flicker across `FIRE_CONFIRM_FRAMES = 3` consecutive frames** — static warm objects (lighters, sunsets, warm walls) cannot accrue a streak. Install a real model with `python face-ai/download_fire_model.py`.
- **FaceNet recognizer** — `InceptionResnetV1(pretrained='vggface2')` from `facenet-pytorch`. Produces L2-normalized 512-d embeddings; cosine similarity = dot product. **Not LBPH / `cv2.face` / `dlib`** (older revisions of this repo used LBPH; the contract is different).

YOLO person boxes are filtered: `confidence < 0.6` and `bw*bh < 0.05` (relative area) are dropped to suppress false positives on hands and tiny figures. Tuned for typical CCTV framing — relaxing them resurfaces noise.

### Recognition pipeline (FaceNet, per-user)

- `dir_recognizers` is a `dir_path -> DirRecognizer` registry. Each `DirRecognizer` holds `{centroids: name -> np.ndarray(512,), ready: bool, lock}`. Per-user dirs (e.g. `face-ai/enrollments/1/`) get their own recognizer; no global sharing.
- Each stream worker watches `os.path.getmtime(<its enrollment_dir>)` per frame and calls `train_recognizer(dir_path)` when it changes ([face-ai/detect.py:200](face-ai/detect.py#L200)). Training detects a face in each enrollment image, computes its FaceNet embedding, then **stores one mean (centroid) per name** across that name's photos. Multiple files for the same `name` (the `_<digits>` suffix is stripped) all collapse into one centroid.
- Match: `best_score = max over centroids of dot(emb, centroid)`. We accept when `best_score >= COSINE_THRESHOLD` (default `0.50`). **Higher cosine = more similar**, so increasing the threshold is *stricter*, not more permissive — opposite of the old LBPH distance contract. Override via `FACE_COSINE_THRESHOLD` env var.
- **Tiny-face filter**: faces below `MIN_FACE_AREA_RATIO = 0.005` of the downscaled frame are detected but **not identified** — a noisy low-res crop produces a noisy embedding. Better an "unknown" box than a wrong name.
- **Temporal stability**: a name only "sticks" after the recognizer agrees on it for `RECOGNITION_CONFIRM_FRAMES = 2` consecutive processed frames in the same 10×10 spatial bucket (`(round(cx*10), round(cy*10))`). Suppresses single-frame look-alike flips. Streaks for buckets that no face occupied this frame are dropped, so a name doesn't persist after a person leaves.

### Enrollment pipeline

Images live at `face-ai/enrollments/<user_id>/<name>_<index>.{jpg,jpeg,png}` (multiple shots per person, numbered). Each user has their own subdir; legacy single-tenant images at the root of `enrollments/` are migrated under user 1 on first DB init ([backend/db.js:212](backend/db.js#L212)).

The backend's `POST /enroll` route writes the next available numbered slot, upserts the `enrollments` table row (`type` defaults to `'standard'`, only "promoted" away from standard on subsequent writes), invalidates the per-user enrollment-types cache, and bumps the dir mtime. The stream worker's mtime poll then triggers `train_recognizer` — **hot-reload, no restart**.

`GET /enrollments` auto-heals filesystem-only enrollments by lazy-inserting `'standard'`-type rows for any name on disk without a DB row.

**Two name shapes coexist** (this trips people up):
- `enrollments.name`, on-disk filenames, and the `name` returned by `/enroll` use the **sanitized form** — `[a-zA-Z0-9 _-]` allowed, spaces converted to underscores. Underscores in original names are lost.
- `incidents.name` and the `name` field on detection events use the **display form** — underscores converted back to spaces by the worker (`base.replace('_', ' ')` in `train_recognizer`).

`/person/:name/activity` accepts the sanitized form and matches on the display form for incidents — see the long comment at [backend/server.js:810](backend/server.js#L810).

### Conveyor bag counting

Counts discrete objects (cement/sand bags) riding a belt past a virtual line. Opt-in **per camera**: `cameras.bag_line_json` is NULL for a normal camera and the worker skips the pipeline entirely for that stream, so nothing changes for non-conveyor cameras.

**Two counting modes, and the choice matters more than any threshold.** Measured on `face-ai/WhatsApp Video 2026-08-04*.mp4` (78s of barge belt, **ground truth 47 bags**, established by five independent tripwire positions along the belt agreeing to ±1 with a consistent travel-time offset):

| mode | result | why |
|---|---|---|
| `gate` (default) | **47/47** | occupancy tripwire on the line; no object identity needed |
| `track` | 13/47 | blob detection + nearest-centroid tracking |

`track` fails structurally on a loaded belt: bags arriving every ~1.4s sit close enough that the tracker swaps IDs between neighbours and drops a count whenever two bags touch and merge into one blob. Its output also swung from 0 to 45 across a 40-unit brightness-threshold change, so any number it produces is an artifact of tuning. Keep `track` only when you need per-bag boxes/IDs, the belt is sparse, or `bag_model.pt` is installed. Mode lives in the line JSON (`mode`) so it is per-camera and survives worker replay; `BAG_COUNT_MODE` sets the default.

**`GateCounter` counts per sample point and reports the MEDIAN of their tallies.** This is what makes it tolerant of a sloppily drawn line. Two earlier designs both failed on real footage:
- Pooling brightness percentiles across the whole line → fixed scenery (bright hull, floor) defines the "cargo" level, real bags never reach the threshold: **5/47**.
- Per-point calibration but aggregate occupancy → one off-belt point firing at the wrong moment bridges the gap between two bags and merges them: **24/47**.

Per-point tallies plus a median vote gave 47–48 across six very different line placements, including ones deliberately overshooting the belt onto hull. Points that never change have no contrast of their own (`BAG_GATE_MIN_CONTRAST`) and are dropped; the belt points then agree with each other and outvote any stragglers. Levels are learned from a rolling `BAG_GATE_CALIB_FRAMES` window, so sun/shade drift needs no re-tuning, and the gate refuses to count until it has actually seen contrast — which is what stops a uselessly-placed gate from inventing bags out of sensor noise. A single gate cannot infer direction, so `direction` is ignored in `gate` mode.

- **Detection (track mode) is model-optional.** COCO has no sandbag class, so YOLO's base weights are useless here. With `bag_model.pt` installed the counter uses its boxes; without it, MOG2 background subtraction inside the belt ROI supplies candidates.
- **Track-mode counting is per-track, not per-frame.** Candidates → greedy nearest-centroid tracks → each track counts **exactly once**, the first time its centroid changes side of the line segment. A bag that stops on the line, jitters, or reverses cannot double-count. A track must survive `BAG_MIN_HITS` frames before it may count.
- The `_within_span` check requires the crossing point to project onto the actual segment, not its infinite extension — otherwise objects far off to the side would count.
- **The motion path vetoes blobs overlapping YOLO `person` boxes** (`BAG_PERSON_IOU_MAX`). Workers moving beside the belt are the single largest false-positive source, and person boxes are already computed for free. The veto is skipped when a trained detector is in use.
- The worker emits `bagEvents: [{trackId, box, direction, confidence, dwellSeconds}]` on the `detections` envelope, **only on frames where a crossing happened**. This is a discrete event stream, not per-frame state.

**Crossings deliberately bypass `persistIncidents`.** That path throttles to one row per `(streamId, type, name)` per `INCIDENT_THROTTLE_MS` (default 10s), which would silently discard most of a belt's throughput. Instead `recordBagCrossings` upserts per-minute buckets into the `bag_counts` table `(user_id, stream_id, bucket_minute, count)` with no throttle, bucketed on the **DB clock** so buckets align regardless of process timezone.

**The cumulative total lives in MySQL, never in the worker** — the worker is re-spawned and replayed on crash, so a total held there would reset to zero. `bagTotals` on the backend is only a read-through cache of `SUM(count)` over buckets at or after the camera's `bag_reset_at`. "Reset counter" stamps `bag_reset_at = NOW()` rather than deleting rows, so the throughput history stays queryable while the live counter returns to zero.

Routes: `PUT /camera/:id/bag-line` (`{enabled, x1, y1, x2, y2, direction?, roi?}` — `{enabled:true}` alone stores the default line), `POST /camera/:id/bag-count/reset`, `GET /bag-counts?streamId=&hours=&bucket=minute|hour|day`. `GET /cameras` carries `bagLine` + `bagTotal` so a page reload restores the tile chip. The `bag_counting` feature flag (default on) gates persistence like the other types. `parseBagLine` in [backend/server.js](backend/server.js) is a deliberate mirror of `normalize_line` in [face-ai/bag_counter.py](face-ai/bag_counter.py) — **change both together**; both reject a zero-length segment, which has no side and could never register a crossing.

A line lying along a frame edge is **rejected** by `normalize_line`, `parseBagLine` and both frontend pickers (`EDGE_EPS`): objects are located by their centroid, which is always strictly inside the frame, so it can never reach the far side of a border line — such a gate counts zero forever. Clicking just outside the video clamps both endpoints onto an edge, which is exactly how a user hits this.

Line geometry is normalized 0..1 in the same convention as detection boxes, so the line the user drags on a tile lands where the worker thinks it is. The frontend sets it with two clicks on the live canvas (tile menu → "Set bag counting line").

**Three places counting runs**, all sharing `BagCounter` so a verified number transfers:

1. **Live streams** — `detect.py`, throttled to `TARGET_FPS` (8), gated on `cameras.bag_line_json`.
2. **Offline analyzer** — `analyze_video.py`, opt-in via `--bag-line x1,y1,x2,y2` (+ `--bag-roi`, `--bag-direction`). Off unless a line is passed. It processes **every** frame rather than throttling to 8 fps; higher cadence makes tracking easier, not harder, so thresholds transfer unchanged. Bag boxes render through the existing draw loop, the HUD gains `bags=N`, and the summary envelope gains `counts.bags_counted` plus a `bags` list capped at `BAG_EVENT_CAP` (500) entries — **the total stays exact when the list truncates**. `counts.bags_counted` is *omitted* (not zeroed) when no line was supplied, so the UI can tell "counted nothing" from "counting was off". The Analyze page passes the line as a `bagLine` JSON form field; the user draws it with two clicks on a frame decoded client-side from their own clip.
3. **`count_bags.py`** — standalone tuning harness: `python face-ai/count_bags.py belt.mp4 --line 0.1,0.8,0.9,0.6 --roi 0,0.4,1,0.6 --out counted.mp4`. Mirrors the live worker's 8 fps cadence and 0.5× downscale, and can patch thresholds via flags (`--min-area`, `--min-fill`). Use it before trusting a threshold change.

**Known limitation of the motion fallback:** it assumes the belt surface is visually uniform. A belt with pronounced seams, patches, or heavy dirt generates its own foreground and will produce false blobs that the area/fill/aspect filters may not fully suppress. That is the point at which training `bag_model.pt` (a few hundred annotated frames from the target camera) stops being optional.

### Snapshots

When fire/smoke fires OR a recognized face appears, the AI worker burns detection boxes onto the **full-resolution** frame and writes `face-ai/snapshots/<streamId>/<ts_ms>.jpg`. Two separate throttles ([face-ai/detect.py:29-30](face-ai/detect.py#L29)): `INCIDENT_SNAPSHOT_THROTTLE_S = 1.0` (fire/smoke — rare, important) and `FACE_SNAPSHOT_THROTTLE_S = 5.0` (recognized faces — much higher volume). A single snapshot satisfies both if they happen in the same frame.

The relative path (`<streamId>/<ts>.jpg`) is embedded in the worker's `detections` envelope and stored on the `incidents` row. The frontend fetches via `GET /snapshot/:streamId/:file`, which does a strict ownership check (active stream → cameras table → incidents-by-snapshot-path) and refuses anything that escapes `SNAPSHOT_ROOT`.

### User-scoped features and authentication

- **Auth** ([backend/auth.js](backend/auth.js)): `POST /login` and `POST /signup` issue JWTs. Username regex: `/^[a-zA-Z0-9_-]{3,32}$/`, password ≥6 chars. `app.use(auth.httpAuth)` at [backend/server.js:232](backend/server.js#L232) gates everything below it. Socket.IO uses `socketAuth` — the client passes the token in `handshake.auth.token` and the socket joins room `user:<uid>` on connect.
- **Feature flags** (`features` table, per-user): `fire_detection` (default on), `face_detection` (default on), `person_detection` (default OFF — high volume), `loitering_detection` (on), `plate_detection` (on), `bag_counting` (on, but inert until a camera has a counting line). Only enabled types are persisted. Cached per-user in `featureCache` and bust on `PUT /features/:name`.
- **Enrollment types cache**: `enrollmentTypeCache` (userId → name → type) is loaded lazily on first detection and busted on every enroll / update / delete. The `personType` augmentation on every detection event uses this cache to avoid a per-frame DB hit.

### Frontend pages

[frontend/app.js](frontend/app.js) is a single-file SPA covering the live camera grid, People (drill into a person's activity / movement map), Maps (Leaflet, draggable camera pins), Analytics (heatmap, by-type, by-camera, by-person, daywise), and Recent Events / Incidents rails. Detection events are filtered into:
- **Events**: every detection.
- **Incidents** (alert badge + bell): strictly `type IN ('fire','smoke')` OR a recognized face (`type='face' AND name IS NOT NULL`).

The frontend reads `hlsUrl` from `/cameras` and rewrites `localhost`/`127.0.0.1` to the current page hostname when the dashboard is viewed remotely.

## MediaMTX configuration

[mediamtx/mediamtx.yml](mediamtx/mediamtx.yml) is intentionally minimal: API on `:9997`, HLS on `:8888`. All path config (auth, transport, source) is set per-path via the API at runtime, not in YAML. The default RTSP ingest port `:8554` is implicit (MediaMTX default) and is what the agent pushes to.

## Adding a remote camera

The backend's auto-spawned agent assumes the RTSP source is reachable from the backend host. For a camera on a different LAN, run `agent/agent.py` manually on that LAN:

```
python agent/agent.py http://<backend-host>:3000 <pathName> rtsp://<local-camera-ip>/...
```

Get `<pathName>` from the `streamKey` field in the `/add-camera` response. The agent will register-check (against the unauthenticated `/streams/:key`), then push.
