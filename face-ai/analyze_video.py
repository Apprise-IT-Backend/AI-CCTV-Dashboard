"""Offline video analyzer — feed a video file, get an annotated MP4 out.

Uses the same models and thresholds as `detect.py` so what you see here is
what you'll see live. Reads the input at native frame rate but processes
every frame (no throttling), then writes a same-resolution MP4 with:

  - Face boxes + recognized names (uses enrollment dir if given)
  - Person boxes with ByteTrack IDs
  - Loitering warnings (dwell time in-frame)
  - Vehicle boxes + license plate crops + OCR'd plate strings
  - Fire/smoke incident boxes

Usage:
    python face-ai/analyze_video.py INPUT.mp4 -o OUT.mp4
    python face-ai/analyze_video.py INPUT.mp4 -o OUT.mp4 --enrollment-dir face-ai/enrollments/1
    python face-ai/analyze_video.py INPUT.mp4 -o OUT.mp4 --downscale 0.5 --loitering-seconds 10

Notes:
  - First run downloads FaceNet (~107 MB) and possibly EasyOCR weights (~200 MB).
  - CPU-only on this box, so expect ~3-5 FPS for HD input. Use --downscale 0.5
    or --downscale 0.4 to speed things up.
  - Boxes are drawn on the full-resolution frame, but detection runs on the
    downscaled copy for speed (same as the live pipeline).
"""

import argparse, json, os, sys, time

# Windows console default is cp1252, which chokes on `→` and Bangla text. Force
# UTF-8 on both streams so status prints and OCR'd plate strings survive. Must
# happen before any `print` that might carry non-ASCII.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# `detect.py` writes JSON status lines to stdout at import time. Redirect them
# to stderr so our progress output on stdout stays clean.
sys.stdout, _real_stdout = sys.stderr, sys.stdout
import detect  # noqa: E402  — heavy side-effectful import (loads all models)
sys.stdout = _real_stdout

import cv2, numpy as np
import mediapipe as mp

# Silence the JSON `log()` calls that stream from inside the pipeline once
# we start running — keep our progress output clean.
detect.log = lambda obj: None


# ── Colours (BGR) matching the frontend's palette ─────────────
COLOR_FACE       = (246, 130, 59)     # #3b82f6-ish
COLOR_RECOGNIZED = (129, 185, 16)     # #10b981
COLOR_PERSON     = (11, 158, 245)     # #f59e0b
COLOR_LOITERING  = (60, 146, 251)     # #fb923c
COLOR_VEHICLE    = (184, 163, 148)    # #94a3b8
COLOR_PLATE      = (238, 210, 34)     # #22d3ee
COLOR_INCIDENT   = (68, 68, 239)      # #ef4444

# ── Plate OCR tuning (analyzer only) ──────────────────────
# The live pipeline in detect.py is conservative — wants two agreeing reads
# before publishing a plate string, which is right for continuous streams
# but too strict for the offline analyzer where each vehicle may only be
# in-frame for one or two OCR windows. We monkey-patch detect's module-level
# constants down for this subprocess only (safe — analyze_video runs in its
# own process, doesn't share memory with the live worker).
detect.PLATE_CONFIRM_READS = 1     # publish plate on first successful OCR
detect.PLATE_MIN_CONF      = 0.20  # accept lower-confidence Bangla reads

# ── Loitering re-association ──────────────────────────────
# ByteTrack drops IDs on occlusion / low-confidence frames and re-issues a
# new ID when the person reappears. Without stitching, the loitering dwell
# timer resets every time this happens. These knobs bridge the gap without
# painting phantom boxes when a person actually leaves the scene:
#
#   LOITERING_TRACK_TTL_S — how long orphan state lingers in the map so a
#     brief occlusion + reappearance can be stitched. Kept short (7s) —
#     longer than that and a genuinely-departed person can wrongly bequeath
#     their timer to somebody new who wanders into the same spot.
#   LOITERING_REASSOC_TTL_S — only re-associate to orphans that disappeared
#     this recently. Tighter than the retention TTL so we don't stitch across
#     "one person left, another arrived 5 seconds later" gaps.
#   LOITERING_REASSOC_DIST — max normalized (0..1) center-to-center distance
#     between an orphan's last box and the new track's first box. Was 0.10;
#     0.06 is tight enough that a genuinely-new person walking in doesn't
#     inherit someone else's timer just for passing through their spot.
#   LOITERING_REASSOC_SIZE_RATIO — max size ratio between orphan and new box
#     for them to count as the same person. Prevents stitching a passing
#     child to a nearby adult.
#   LOITERING_ALIVE_MAX_AGE_S — the loitering *resolution* pass only paints
#     a box for tracks seen within this window. Anything older is orphan
#     state used for re-association only, not for rendering.
LOITERING_TRACK_TTL_S       = 7.0
LOITERING_REASSOC_TTL_S     = 2.5
LOITERING_REASSOC_DIST      = 0.06
LOITERING_REASSOC_SIZE_RATIO = 1.8
LOITERING_ALIVE_MAX_AGE_S   = 0.5


def draw_label(img, x, y, text, color, above=True):
    """Filled-rect label over each box — matches the frontend style."""
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
    pad = 4
    if above:
        y0 = max(0, y - th - base - pad * 2)
    else:
        y0 = y
    cv2.rectangle(img, (x, y0), (x + tw + pad * 2, y0 + th + base + pad * 2), color, cv2.FILLED)
    cv2.putText(img, text, (x + pad, y0 + th + pad),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)


def process_video(input_path, output_path, enrollment_dir=None,
                  downscale=0.5, loitering_seconds=30, progress_json=False,
                  detect_fire=True, person_conf=0.4, person_min_area=0.005,
                  yolo_model_path=None, yolo_imgsz=None):
    # First-run "Best" quality auto-downloads ~52 MB of weights and loads a
    # much heavier model — the whole warmup can take 30-60s on CPU during
    # which no `progress` lines are emitted. Signal a phase change up front
    # so the UI can show "Loading models…" instead of a frozen 0/0.
    def emit(payload):
        if progress_json:
            print(json.dumps(payload, ensure_ascii=False), flush=True)
    emit({'type': 'phase', 'name': 'loading'})
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f'ERROR: cannot open {input_path}', file=sys.stderr)
        return 1

    src_fps  = cap.get(cv2.CAP_PROP_FPS) or 25.0
    src_w    = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h    = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Codec order: H.264 first because Windows Media Player + Safari + hardware
    # decoders reject `mp4v` (MPEG-4 Part 2, WMP error 0xC00D36B4). OpenCV's
    # avc1 support depends on the OpenH264 DLL being present — falls back to
    # mp4v so we still produce *some* file, and re-encodes to H.264 via ffmpeg
    # after writing if a usable ffmpeg is on PATH.
    writer = None
    used_codec = None
    for tag in ('avc1', 'H264', 'X264', 'mp4v'):
        fourcc = cv2.VideoWriter_fourcc(*tag)
        w = cv2.VideoWriter(output_path, fourcc, src_fps, (src_w, src_h))
        if w.isOpened():
            writer = w
            used_codec = tag
            break
        try: w.release()
        except Exception: pass
    if writer is None:
        print(f'ERROR: no working video codec for {output_path}', file=sys.stderr)
        cap.release()
        return 1
    print(f'Codec: {used_codec}')

    print(f'Input:  {input_path}  ({src_w}x{src_h} @ {src_fps:.1f}fps, {n_frames} frames)')
    print(f'Output: {output_path}')
    print(f'Downscale: {downscale}  |  Loitering: {loitering_seconds}s')
    print(f'Fire: {"on" if detect_fire else "off"}  |  '
          f'Person: conf>={person_conf}, min-area>={person_min_area}')

    # Optionally swap the YOLO detector for a larger variant. Ultralytics
    # accepts a bare name like "yolov8s.pt" and auto-downloads on first use.
    # Larger variants (s/m/l/x) give substantially better recall on small /
    # distant subjects; combine with a higher --yolo-imgsz for the biggest
    # improvement, at proportional CPU cost. When no override is given we
    # reuse the model detect.py already loaded (yolov8n.pt).
    from ultralytics import YOLO as _YOLO
    yolo_model = detect.yolo_model
    if yolo_model_path:
        try:
            path = yolo_model_path
            if not os.path.isabs(path) and not os.path.exists(path):
                cand = os.path.join(os.path.dirname(os.path.abspath(__file__)), path)
                if os.path.exists(cand): path = cand
            print(f'Loading alt YOLO: {path}...')
            yolo_model = _YOLO(path)
        except Exception as ex:
            print(f'  [warn] alt YOLO load failed ({ex}) — falling back to yolov8n', file=sys.stderr)
            yolo_model = detect.yolo_model
    yolo_kwargs = {'verbose': False}
    if yolo_imgsz:
        yolo_kwargs['imgsz'] = int(yolo_imgsz)
    print(f'YOLO: {os.path.basename(getattr(yolo_model, "ckpt_path", "yolov8n.pt"))}'
          f'  imgsz={yolo_imgsz or 640}')

    print(f'Enrollment: {enrollment_dir or "(none - face recognition disabled)"}')
    print()

    # Train face recognizer from the enrollment dir if one was supplied.
    rec = None
    if enrollment_dir and os.path.isdir(enrollment_dir):
        print(f'Training FaceNet from {enrollment_dir}...')
        detect.train_recognizer(enrollment_dir)
        rec = detect.get_recognizer(enrollment_dir)
        with rec.lock:
            print(f'  → {len(rec.centroids)} identity/identities: '
                  + ', '.join(rec.centroids.keys() or ['(none)']))
        print()

    # ── Per-clip pipeline state (mirrors stream_worker in detect.py) ──
    name_streaks = {}
    loitering_state = {}
    plate_state = {}
    fire_prev_sig = None
    fire_streak   = 0

    # ── Summary state (emitted at end of job) ──────────────────
    # Counters + keyframe snapshots that the UI shows under the video player.
    # We save one small (~480px wide) JPEG per notable "first occurrence" so the
    # user can click through to the moment each face/plate/loitering/fire fired.
    snap_dir = os.path.join(os.path.dirname(output_path), '_snaps')
    try: os.makedirs(snap_dir, exist_ok=True)
    except OSError: pass
    summary = {
        # Per-unique-track dicts: track_id -> {'first_s', 'snap', 'vehicleType'?}.
        # Populated the first frame each track is observed, then displayed as a
        # dedicated "Persons" / "Vehicles" tab with one row per unique subject.
        'persons': {},
        'vehicles': {},
        'faces': {},        # name -> {'count', 'snap', 'first_s'}
        'plates': {},       # plate string -> {'count', 'snap', 'first_s', 'vehicleType'}
        'loitering': [],    # list of {'trackId', 'first_s', 'peak_dwell_s', 'snap'}
        'fire': [],         # list of {'first_s', 'snap'}
        '_loitering_seen': set(),
    }

    def save_keyframe(slug, frame_bgr, bbox_norm=None, pad=0.25, min_w=320):
        """Persist a JPEG for the summary rail. Returns basename or None.

        When `bbox_norm` is None, saves a downscaled full-frame thumbnail.
        When provided (as (x, y, w, h) in 0..1 relative coords), crops around
        that box with padding to produce a "focused" portrait of the subject —
        useful for showing one person / one vehicle out of a crowded scene.
        `pad` is a fraction of the bbox width/height added on each side.
        `min_w` is a floor for output width — tiny far-away subjects get
        upscaled so they're still readable in the summary table.
        """
        try:
            ts_ms = int(time.time() * 1000)
            safe = ''.join(c for c in slug if c.isalnum() or c in '-_')[:40] or 'k'
            fname = f'{safe}_{ts_ms}.jpg'
            path = os.path.join(snap_dir, fname)
            img = frame_bgr
            if bbox_norm is not None:
                h, w = img.shape[:2]
                x, y, bw, bh = bbox_norm
                px = bw * pad
                py = bh * pad
                x0 = max(0, int((x - px) * w))
                y0 = max(0, int((y - py) * h))
                x1 = min(w, int((x + bw + px) * w))
                y1 = min(h, int((y + bh + py) * h))
                if x1 > x0 and y1 > y0:
                    img = img[y0:y1, x0:x1]
                else:
                    img = frame_bgr
            img = img.copy()
            h, w = img.shape[:2]
            # Downscale wide crops; upscale tiny far-subject crops so the
            # summary thumb is legible.
            if w > 480:
                scale = 480.0 / w
                img = cv2.resize(img, (0, 0), fx=scale, fy=scale)
            elif w < min_w and w > 0:
                scale = min_w / w
                img = cv2.resize(img, (0, 0), fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 82])
            return fname
        except Exception as ex:
            print(f'  [warn] keyframe save failed: {ex}', file=sys.stderr)
            return None

    # ── Track-stitching helpers ────────────────────────────────
    # ByteTrack reissues fresh IDs when it briefly loses a subject (a
    # motorcycle passes behind a car, a person walks under low light for a
    # few frames, YOLO's confidence dips). Without correction, one person
    # who was on-screen for 30s can show up as five duplicate rows. The
    # after-the-fact stitcher below merges chronologically-adjacent tracks
    # whose torso-region color histograms match — colour is much more
    # discriminating than pure spatial proximity for the "two motorcyclists
    # in similar spots" case. We store a running per-track reference
    # histogram plus first/last box so the merge check has everything it
    # needs.
    def compute_ref_hist(frame_bgr, x0n, y0n, x1n, y1n):
        H_, W_ = frame_bgr.shape[:2]
        x0 = max(0, int(x0n * W_)); y0 = max(0, int(y0n * H_))
        x1 = min(W_, int(x1n * W_)); y1 = min(H_, int(y1n * H_))
        if x1 - x0 < 20 or y1 - y0 < 20:
            return None
        # Central crop — for persons this biases toward the torso (drops
        # head + legs), for vehicles it just trims the box edges where the
        # background bleeds in.
        cw, ch = x1 - x0, y1 - y0
        cx0 = x0 + int(cw * 0.20); cx1 = x0 + int(cw * 0.80)
        cy0 = y0 + int(ch * 0.15); cy1 = y0 + int(ch * 0.65)
        crop = frame_bgr[cy0:cy1, cx0:cx1]
        if crop.size == 0:
            return None
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
        return hist

    # Models are loaded and everything is warm — flip the UI out of the
    # "Loading models…" state so the progress bar can start moving.
    emit({'type': 'phase', 'name': 'detecting'})

    frame_idx = 0
    t0 = time.time()
    last_report = t0
    # `now_ref` gives us a monotonic "clock" scaled off the video, not wall-time,
    # so dwell timers behave the same regardless of how slow the pipeline runs.
    def video_time():
        return frame_idx / src_fps

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        now = video_time()

        small = cv2.resize(frame, (0, 0), fx=downscale, fy=downscale) if downscale != 1.0 else frame
        sh, sw = small.shape[:2]
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        detections = []
        incidents = []
        # Keyframe writes deferred until AFTER boxes are drawn onto `out`, so
        # the JPEGs saved for the summary rail include the same annotations
        # you see in the playback. Each entry is (slug, dict, key_to_set).
        pending_keyframes = []

        # 1. Face detection + recognition
        try:
            with detect.face_detector_lock:
                fresult = detect.shared_face_detector.detect(mp_img)
            if fresult.detections:
                seen_buckets = set()
                for d in fresult.detections:
                    bb = d.bounding_box
                    name = None
                    face_area_ratio = (bb.width * bb.height) / float(sw * sh)
                    if rec is not None and face_area_ratio >= detect.MIN_FACE_AREA_RATIO:
                        with rec.lock:
                            centroids = dict(rec.centroids) if rec.ready else None
                        if centroids:
                            x = max(0, bb.origin_x); y = max(0, bb.origin_y)
                            fw = min(bb.width, sw - x); fh = min(bb.height, sh - y)
                            emb = detect.embed_face(small[y:y+fh, x:x+fw])
                            if emb is not None:
                                best_name, best_score = None, -1.0
                                for n, c in centroids.items():
                                    s = float(np.dot(emb, c))
                                    if s > best_score:
                                        best_score, best_name = s, n
                                if best_score >= detect.COSINE_THRESHOLD:
                                    candidate = best_name
                                    cx = (bb.origin_x + bb.width / 2) / sw
                                    cy = (bb.origin_y + bb.height / 2) / sh
                                    bucket = (round(cx * 10), round(cy * 10))
                                    seen_buckets.add(bucket)
                                    streak = name_streaks.get(bucket)
                                    if streak and streak['name'] == candidate:
                                        streak['count'] += 1
                                    else:
                                        name_streaks[bucket] = {'name': candidate, 'count': 1}
                                        streak = name_streaks[bucket]
                                    if streak['count'] >= detect.RECOGNITION_CONFIRM_FRAMES:
                                        name = candidate
                    detections.append({
                        'x': bb.origin_x / sw, 'y': bb.origin_y / sh,
                        'w': bb.width / sw, 'h': bb.height / sh,
                        'confidence': float(d.categories[0].score if d.categories else 0),
                        'label': 'face', 'name': name,
                    })
                    # Summary: capture the first frame each identity is confirmed.
                    # Defer the actual JPEG write until after boxes are drawn.
                    if name:
                        entry = summary['faces'].setdefault(name, {
                            'count': 0, 'snap': None, 'first_s': now,
                        })
                        entry['count'] += 1
                        if entry['snap'] is None and not any(p[1] is entry for p in pending_keyframes):
                            pending_keyframes.append((f'face-{name}', entry, 'snap', None))
                for bucket in list(name_streaks.keys()):
                    if bucket not in seen_buckets:
                        del name_streaks[bucket]
        except Exception as ex:
            print(f'  [warn] face detect: {ex}', file=sys.stderr)

        # 2. YOLO (persons + vehicles + fire class if the custom model has it)
        vehicles = []
        try:
            with detect.yolo_lock:
                try:
                    yres = yolo_model.track(small, persist=True,
                                             tracker='bytetrack.yaml',
                                             **yolo_kwargs)[0]
                except Exception:
                    yres = yolo_model(small, **yolo_kwargs)[0]
                for box in yres.boxes:
                    cls_id = int(box.cls[0])
                    conf = float(box.conf[0])
                    label = yolo_model.names[cls_id]
                    # Per-class gates: persons use the user-tunable conf/area
                    # (default 0.4 / 0.5% area — much looser than vehicles);
                    # vehicles + everything else stick with the strict 0.6
                    # baseline that keeps false-positive brake lights out.
                    if label == 'person':
                        if conf < person_conf: continue
                    else:
                        if conf < 0.6: continue
                    bx = box.xyxyn[0].tolist()
                    tid = None
                    if getattr(box, 'id', None) is not None:
                        try: tid = int(box.id.item() if hasattr(box.id, 'item') else box.id[0])
                        except Exception: tid = None
                    if label == 'person':
                        bw = bx[2] - bx[0]; bh = bx[3] - bx[1]
                        if bw * bh < person_min_area: continue
                        det = {'x': bx[0], 'y': bx[1], 'w': bw, 'h': bh,
                               'confidence': conf, 'label': 'person'}
                        if tid is not None:
                            det['trackId'] = tid
                            # Aggregate per-track metadata: first/last seen,
                            # dwell duration, average YOLO confidence, whether
                            # a face was ever visible (front-facing heuristic),
                            # and the FaceNet name if one was ever confirmed.
                            # A focused crop is written on first sighting so
                            # the summary shows a portrait of just this person.
                            pentry = summary['persons'].get(tid)
                            if pentry is None:
                                pentry = {
                                    'trackId': tid,
                                    'first_s': round(now, 1),
                                    'last_s':  round(now, 1),
                                    'frame_count': 1,
                                    'face_seen': False,
                                    'recognized_name': None,
                                    'avg_conf': conf,
                                    '_sum_conf': conf,
                                    'snap': None,
                                    'segments': 1,
                                    '_first_box': (bx[0], bx[1], bw, bh),
                                    '_last_box':  (bx[0], bx[1], bw, bh),
                                    '_ref_hist':  compute_ref_hist(frame, bx[0], bx[1], bx[2], bx[3]),
                                }
                                summary['persons'][tid] = pentry
                                # Focused crop: pass this person's normalized
                                # bbox so save_keyframe crops around them.
                                pending_keyframes.append(
                                    (f'person-{tid}', pentry, 'snap',
                                     (bx[0], bx[1], bw, bh)))
                            else:
                                pentry['last_s'] = round(now, 1)
                                pentry['frame_count'] += 1
                                pentry['_sum_conf'] += conf
                                pentry['avg_conf'] = pentry['_sum_conf'] / pentry['frame_count']
                                pentry['_last_box'] = (bx[0], bx[1], bw, bh)
                                # Refresh appearance histogram periodically —
                                # lighting/pose shifts otherwise leave us with
                                # a stale reference from frame 1.
                                if pentry['frame_count'] % 5 == 0:
                                    nh = compute_ref_hist(frame, bx[0], bx[1], bx[2], bx[3])
                                    if nh is not None:
                                        if pentry['_ref_hist'] is None:
                                            pentry['_ref_hist'] = nh
                                        else:
                                            pentry['_ref_hist'] = pentry['_ref_hist'] * 0.7 + nh * 0.3
                        detections.append(det)
                        if tid is not None:
                            st = loitering_state.get(tid)
                            if st is not None:
                                st['last'] = now
                                st['box']  = (bx[0], bx[1], bw, bh)
                            else:
                                # New track_id — but ByteTrack sometimes drops a
                                # person for a few frames (occlusion, similar-
                                # looking neighbor) and picks them back up under
                                # a *new* ID. Before we start a fresh dwell timer,
                                # look for a track that vanished within the last
                                # few seconds whose last box was spatially close
                                # AND roughly the same size. All three checks
                                # (recency + position + size) together make the
                                # stitch specific enough that new pedestrians
                                # don't inherit strangers' timers.
                                first_time = now
                                cx, cy = bx[0] + bw / 2, bx[1] + bh / 2
                                area = bw * bh
                                best_tid, best_dist = None, LOITERING_REASSOC_DIST
                                for other_tid, other_st in loitering_state.items():
                                    gap = now - other_st['last']
                                    # Only consider genuinely-orphaned tracks
                                    # (unseen last frame or two), and only if
                                    # they went missing very recently.
                                    if gap < LOITERING_ALIVE_MAX_AGE_S: continue
                                    if gap > LOITERING_REASSOC_TTL_S: continue
                                    obx, oby, obw, obh = other_st['box']
                                    other_area = obw * obh
                                    if other_area <= 0 or area <= 0: continue
                                    ratio = max(area, other_area) / min(area, other_area)
                                    if ratio > LOITERING_REASSOC_SIZE_RATIO: continue
                                    ocx, ocy = obx + obw / 2, oby + obh / 2
                                    dist = ((cx - ocx) ** 2 + (cy - ocy) ** 2) ** 0.5
                                    if dist < best_dist:
                                        best_dist, best_tid = dist, other_tid
                                if best_tid is not None:
                                    first_time = loitering_state[best_tid]['first']
                                    del loitering_state[best_tid]
                                loitering_state[tid] = {
                                    'first': first_time, 'last': now,
                                    'box': (bx[0], bx[1], bw, bh),
                                }
                    elif label in detect.VEHICLE_CLASSES:
                        bw = bx[2] - bx[0]; bh = bx[3] - bx[1]
                        if bw * bh < 0.01: continue
                        if tid is not None:
                            ventry = summary['vehicles'].get(tid)
                            if ventry is None:
                                ventry = {
                                    'trackId': tid,
                                    'first_s': round(now, 1),
                                    'last_s':  round(now, 1),
                                    'frame_count': 1,
                                    'vehicleType': label,
                                    'plate': None,   # filled by plate pipeline when confirmed
                                    'avg_conf': conf,
                                    '_sum_conf': conf,
                                    'snap': None,
                                    'segments': 1,
                                    '_first_box': (bx[0], bx[1], bw, bh),
                                    '_last_box':  (bx[0], bx[1], bw, bh),
                                    '_ref_hist':  compute_ref_hist(frame, bx[0], bx[1], bx[2], bx[3]),
                                }
                                summary['vehicles'][tid] = ventry
                                pending_keyframes.append(
                                    (f'vehicle-{tid}', ventry, 'snap',
                                     (bx[0], bx[1], bw, bh)))
                            else:
                                ventry['last_s'] = round(now, 1)
                                ventry['frame_count'] += 1
                                ventry['_sum_conf'] += conf
                                ventry['avg_conf'] = ventry['_sum_conf'] / ventry['frame_count']
                                ventry['_last_box'] = (bx[0], bx[1], bw, bh)
                                if ventry['frame_count'] % 5 == 0:
                                    nh = compute_ref_hist(frame, bx[0], bx[1], bx[2], bx[3])
                                    if nh is not None:
                                        if ventry['_ref_hist'] is None:
                                            ventry['_ref_hist'] = nh
                                        else:
                                            ventry['_ref_hist'] = ventry['_ref_hist'] * 0.7 + nh * 0.3
                        detections.append({'x': bx[0], 'y': bx[1], 'w': bw, 'h': bh,
                                           'confidence': conf, 'label': 'vehicle',
                                           'vehicleType': label,
                                           **({'trackId': tid} if tid is not None else {})})
                        x1p = int(max(0, bx[0]) * sw); y1p = int(max(0, bx[1]) * sh)
                        x2p = int(min(1, bx[2]) * sw); y2p = int(min(1, bx[3]) * sh)
                        vehicles.append((tid, x1p, y1p, x2p, y2p, label))
                    elif label in ('fire', 'smoke') and detect_fire:
                        incidents.append({'type': 'fire', 'confidence': conf, 'box': bx})
        except Exception as ex:
            print(f'  [warn] YOLO: {ex}', file=sys.stderr)

        # 2.5. Cross-link this frame's face detections to their containing
        # person tracks. If a face center falls inside a person box, we mark
        # that track's `face_seen=True` (front-facing at least once) and, if
        # the face was recognized by FaceNet, attach the name to the person
        # track so the summary can show "recognized as: <name>" per person.
        person_dets = []
        try:
            face_dets = [d for d in detections if d.get('label') == 'face']
            person_dets = [d for d in detections
                           if d.get('label') == 'person' and d.get('trackId') is not None]
            for fd in face_dets:
                fcx = fd['x'] + fd['w'] / 2
                fcy = fd['y'] + fd['h'] / 2
                for pd in person_dets:
                    if (pd['x'] <= fcx <= pd['x'] + pd['w']
                        and pd['y'] <= fcy <= pd['y'] + pd['h']):
                        pentry = summary['persons'].get(pd['trackId'])
                        if pentry is not None:
                            pentry['face_seen'] = True
                            if fd.get('name'):
                                pentry['recognized_name'] = fd['name']
                        break
        except Exception as ex:
            print(f'  [warn] face-person link: {ex}', file=sys.stderr)

        # 2.6. Full-resolution face-crop fallback. MediaPipe on the 0.5x-
        # downscaled frame regularly misses small/angled faces that are
        # perfectly visible when you crop the person out of the *source*
        # frame. This second pass runs the same detector on each person
        # crop at native resolution, but only for tracks that haven't yet
        # had a face confirmed, and throttled to every third frame per
        # track so we don't multiply CPU cost by (n_persons × n_frames).
        try:
            H_frame, W_frame = frame.shape[:2]
            for pd in person_dets:
                pentry = summary['persons'].get(pd['trackId'])
                if pentry is None or pentry.get('face_seen'):
                    continue
                if frame_idx - pentry.get('_face_check_frame', -100) < 3:
                    continue
                pentry['_face_check_frame'] = frame_idx
                # Expand the crop by 10% on each side — YOLO person boxes
                # often clip the top of the head where the face lives.
                pad_x = pd['w'] * 0.10
                pad_y = pd['h'] * 0.10
                px0 = max(0, int((pd['x'] - pad_x) * W_frame))
                py0 = max(0, int((pd['y'] - pad_y) * H_frame))
                px1 = min(W_frame, int((pd['x'] + pd['w'] + pad_x) * W_frame))
                py1 = min(H_frame, int((pd['y'] + pd['h'] + pad_y) * H_frame))
                if px1 - px0 < 40 or py1 - py0 < 40:
                    continue
                crop = frame[py0:py1, px0:px1]
                crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                crop_mp  = mp.Image(image_format=mp.ImageFormat.SRGB, data=crop_rgb)
                with detect.face_detector_lock:
                    cres = detect.shared_face_detector.detect(crop_mp)
                if cres.detections:
                    pentry['face_seen'] = True
                    # Best-effort: also try FaceNet recognition on the crop
                    # so we can name the person even when the primary pass
                    # missed the face entirely.
                    if rec is not None and pentry.get('recognized_name') is None:
                        with rec.lock:
                            centroids = dict(rec.centroids) if rec.ready else None
                        if centroids:
                            fd = cres.detections[0].bounding_box
                            fx = max(0, fd.origin_x); fy = max(0, fd.origin_y)
                            fw = min(fd.width,  crop.shape[1] - fx)
                            fh = min(fd.height, crop.shape[0] - fy)
                            if fw > 0 and fh > 0:
                                emb = detect.embed_face(crop[fy:fy+fh, fx:fx+fw])
                                if emb is not None:
                                    best_n, best_s = None, -1.0
                                    for n, c in centroids.items():
                                        s = float(np.dot(emb, c))
                                        if s > best_s:
                                            best_s, best_n = s, n
                                    if best_s >= detect.COSINE_THRESHOLD:
                                        pentry['recognized_name'] = best_n
        except Exception as ex:
            print(f'  [warn] person-crop face check: {ex}', file=sys.stderr)

        # 3. Loitering resolution — ONLY for tracks visible this frame.
        # Orphan entries stay in the map (bounded by LOITERING_TRACK_TTL_S) so
        # they can be re-associated to a resurrected track, but we do NOT paint
        # boxes or emit incidents for them. Otherwise a person who leaves the
        # frame keeps a phantom "LOITERING" rectangle floating over the empty
        # spot where they last stood — which is what the previous version did.
        for tid, st in list(loitering_state.items()):
            if now - st['last'] > LOITERING_TRACK_TTL_S:
                del loitering_state[tid]
                continue
            # Skip orphans — they exist for stitching only, not for rendering.
            if now - st['last'] > LOITERING_ALIVE_MAX_AGE_S:
                continue
            dwell = now - st['first']
            if dwell < loitering_seconds:
                continue
            for d in detections:
                if d.get('label') == 'person' and d.get('trackId') == tid:
                    d['loitering'] = True
                    d['dwellSeconds'] = round(dwell, 1)
            x0, y0, bw0, bh0 = st['box']
            incidents.append({
                'type': 'loitering',
                'confidence': min(1.0, dwell / (loitering_seconds * 2)),
                'box': [x0, y0, x0 + bw0, y0 + bh0],
                'trackId': tid, 'dwellSeconds': round(dwell, 1),
            })
            # Summary: one keyframe per track that crosses the threshold; also
            # update the peak dwell so the final rail shows the longest stay.
            if tid not in summary['_loitering_seen']:
                summary['_loitering_seen'].add(tid)
                new_entry = {
                    'trackId': tid, 'first_s': round(now, 1),
                    'peak_dwell_s': round(dwell, 1),
                    'snap': None,
                }
                summary['loitering'].append(new_entry)
                pending_keyframes.append((f'loit-{tid}', new_entry, 'snap', None))
            else:
                for e in summary['loitering']:
                    if e['trackId'] == tid and dwell > e['peak_dwell_s']:
                        e['peak_dwell_s'] = round(dwell, 1)

        # 4. Plate pipeline — sampled per vehicle track (OCR is expensive)
        try:
            for tid in list(plate_state.keys()):
                if now - plate_state[tid].get('last_ocr_at', 0) > 10.0:
                    del plate_state[tid]
            # Everything above runs on `small` (0.5× downscaled) for speed,
            # but plates are the smallest thing we care about — running plate
            # detection at half-resolution means a plate that's 50px at
            # source is ~25px by the time the detector sees it, which is
            # below the point where EasyOCR can separate glyphs. Do plate
            # work on the FULL-RES `frame` so those extra pixels survive.
            H_frame, W_frame = frame.shape[:2]
            for (tid, x1p, y1p, x2p, y2p, veh_label) in vehicles:
                if tid is None: continue
                ps = plate_state.setdefault(tid, {
                    'last_ocr_at': -999.0, 'votes': {}, 'plate': None,
                })
                if now - ps['last_ocr_at'] < detect.PLATE_OCR_INTERVAL_S:
                    if ps['plate']:
                        detections.append({
                            'x': x1p / sw, 'y': y1p / sh,
                            'w': (x2p - x1p) / sw, 'h': (y2p - y1p) / sh,
                            'confidence': 0.9, 'label': 'plate',
                            'name': ps['plate'], 'trackId': tid,
                        })
                    continue
                ps['last_ocr_at'] = now
                # Full-res vehicle crop: map small-frame pixel coords back
                # to source-frame pixel coords via the frame-dimension ratio.
                X1p = int(x1p * W_frame / sw); Y1p = int(y1p * H_frame / sh)
                X2p = int(x2p * W_frame / sw); Y2p = int(y2p * H_frame / sh)
                crop = frame[Y1p:Y2p, X1p:X2p]
                plates = detect.detect_plates_in_vehicle(crop)
                if not plates: continue
                plates.sort(key=lambda p: p['conf'], reverse=True)
                best = plates[0]
                px, py, pw, ph = best['box']
                # `best['box']` is in the full-res crop's coord space; map
                # back to normalized frame coords using full-res dims.
                axn = (X1p + px) / W_frame; ayn = (Y1p + py) / H_frame
                awn = pw / W_frame; ahn = ph / H_frame
                text = best['text']
                if text:
                    ps['votes'][text] = ps['votes'].get(text, 0) + 1
                    winner = max(ps['votes'].items(), key=lambda kv: kv[1])
                    if winner[1] >= detect.PLATE_CONFIRM_READS and winner[0] != ps['plate']:
                        ps['plate'] = winner[0]
                        incidents.append({'type': 'plate', 'confidence': best['conf'],
                                          'box': [axn, ayn, axn + awn, ayn + ahn],
                                          'plate': winner[0], 'trackId': tid,
                                          'vehicleType': veh_label})
                        # Summary: one keyframe per unique confirmed plate.
                        entry = summary['plates'].setdefault(winner[0], {
                            'count': 0, 'snap': None, 'first_s': round(now, 1),
                            'vehicleType': veh_label,
                        })
                        entry['count'] += 1
                        if entry['snap'] is None and not any(p[1] is entry for p in pending_keyframes):
                            pending_keyframes.append((f'plate-{tid}', entry, 'snap', None))
                        # Attach the plate string to the parent vehicle track
                        # so the Vehicles tab shows "recognized plate: X".
                        vent = summary['vehicles'].get(tid)
                        if vent is not None:
                            vent['plate'] = winner[0]
                # Show the plate string on the box as soon as OCR reads it —
                # confirmation (2+ agreeing reads) still gates the summary rail
                # and incident entry, but the label should reflect what the
                # OCR just saw so the user isn't looking at a blank "plate"
                # box while the string sits in the voting buffer.
                display_name = ps['plate'] or (text if text else None)
                detections.append({
                    'x': axn, 'y': ayn, 'w': awn, 'h': ahn,
                    'confidence': best['conf'] or 0.5,
                    'label': 'plate', 'name': display_name, 'trackId': tid,
                })
        except Exception as ex:
            print(f'  [warn] plate: {ex}', file=sys.stderr)

        # 5. HSV fire fallback — only when there's no dedicated fire model
        # AND the user hasn't explicitly disabled fire detection. The heuristic
        # is prone to false-positives on brake lights and warm daytime surfaces,
        # so it's the first thing to switch off for street-scene analysis.
        if detect_fire and detect.fire_model is None:
            try:
                hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
                core = cv2.inRange(hsv, np.array([0, 80, 240], 'uint8'),
                                        np.array([35, 255, 255], 'uint8'))
                halo = cv2.inRange(hsv, np.array([0, 150, 180], 'uint8'),
                                        np.array([20, 255, 255], 'uint8'))
                cand = None
                if cv2.countNonZero(core) >= 5:
                    cnts, _ = cv2.findContours(cv2.dilate(core, None), cv2.RETR_EXTERNAL,
                                               cv2.CHAIN_APPROX_SIMPLE)
                    for cnt in cnts:
                        area = cv2.contourArea(cnt)
                        if area < 25: continue
                        cx, cy, cw, ch = cv2.boundingRect(cnt)
                        ar = ch / max(1, cw)
                        if ar < 0.4 or ar > 4.0: continue
                        pad = max(cw, ch)
                        x1 = max(0, cx - pad); y1 = max(0, cy - pad)
                        x2 = min(sw, cx + cw + pad); y2 = min(sh, cy + ch + pad)
                        halo_roi = halo[y1:y2, x1:x2]
                        halo_ratio = cv2.countNonZero(halo_roi) / float(max(1, halo_roi.size))
                        if halo_ratio < 0.05: continue
                        score = area * halo_ratio
                        if cand is None or score > cand[0]:
                            cand = (score, x1, y1, x2 - x1, y2 - y1)
                if cand is not None:
                    _, x, y, ww, hh = cand
                    sig = (x + ww/2, y + hh/2, ww * hh)
                    if fire_prev_sig is not None:
                        dx = abs(sig[0] - fire_prev_sig[0])
                        dy = abs(sig[1] - fire_prev_sig[1])
                        da = abs(sig[2] - fire_prev_sig[2]) / max(1.0, fire_prev_sig[2])
                        fire_streak = fire_streak + 1 if (dx+dy > 1.5 or da > 0.15) else max(0, fire_streak - 1)
                    fire_prev_sig = sig
                    if fire_streak >= detect.FIRE_CONFIRM_FRAMES:
                        incidents.append({'type': 'fire',
                                          'confidence': min(0.85, 0.5 + cand[0]/50000.0),
                                          'box': [x/sw, y/sh, (x+ww)/sw, (y+hh)/sh]})
                else:
                    fire_streak = max(0, fire_streak - 1)
                    fire_prev_sig = None
            except Exception as ex:
                print(f'  [warn] fire: {ex}', file=sys.stderr)

        # Summary: dedup fire events — new event if last one was ≥ 5s ago,
        # so a continuous flame emits one entry, not one per frame.
        if any(inc.get('type') in ('fire', 'smoke') for inc in incidents):
            new_event = (not summary['fire']) or (now - summary['fire'][-1]['first_s'] > 5.0)
            if new_event:
                new_fire = {'first_s': round(now, 1), 'snap': None}
                summary['fire'].append(new_fire)
                pending_keyframes.append((f'fire-{frame_idx}', new_fire, 'snap', None))

        # ── Draw on the full-res output frame ─────────────────
        H, W = frame.shape[:2]
        out = frame  # in-place is fine, we don't reuse original
        for d in detections:
            x1 = int(d['x'] * W); y1 = int(d['y'] * H)
            x2 = int((d['x'] + d['w']) * W); y2 = int((d['y'] + d['h']) * H)
            lab = d.get('label')
            if d.get('loitering'):
                color = COLOR_LOITERING
                tag = f"LOITERING {d.get('dwellSeconds', '')}s"
            elif lab == 'plate':
                color = COLOR_PLATE
                tag = f"PLATE {d['name']}" if d.get('name') else 'plate'
            elif lab == 'vehicle':
                color = COLOR_VEHICLE
                tag = d.get('vehicleType') or 'vehicle'
            elif d.get('name'):
                color = COLOR_RECOGNIZED
                tag = d['name']
            elif lab == 'person':
                color = COLOR_PERSON
                tag = f"person#{d['trackId']}" if d.get('trackId') is not None else 'person'
            else:
                color = COLOR_FACE
                tag = 'face'
            cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
            # OpenCV's Hershey font is ASCII-only; unicode separators like `·`
            # render as `??`. Stick to plain hyphens.
            draw_label(out, x1, y1, f"{tag}  {int(d['confidence']*100)}%", color)

        for inc in incidents:
            bx = inc.get('box') or []
            if len(bx) < 4: continue
            x1 = int(bx[0] * W); y1 = int(bx[1] * H)
            x2 = int(bx[2] * W); y2 = int(bx[3] * H)
            ic = {'fire': COLOR_INCIDENT, 'smoke': COLOR_INCIDENT,
                  'loitering': COLOR_LOITERING, 'plate': COLOR_PLATE}.get(inc.get('type'),
                                                                          COLOR_INCIDENT)
            cv2.rectangle(out, (x1, y1), (x2, y2), ic, 3)
            tag = inc.get('type', 'alert').upper()
            if inc.get('plate'):
                tag = f"PLATE {inc['plate']}"
            elif inc.get('type') == 'loitering' and inc.get('dwellSeconds'):
                tag = f"LOITERING {inc['dwellSeconds']}s"
            draw_label(out, x1, y1, tag, ic)

        # HUD — top-left timestamp so you can find events after the fact.
        hud = f"t={now:6.2f}s  frame {frame_idx}/{n_frames}"
        cv2.putText(out, hud, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(out, hud, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (255, 255, 255), 1, cv2.LINE_AA)

        # Flush any keyframe writes now that boxes are burned onto `out`.
        # 4th tuple element (bbox_norm or None) drives whether the save is a
        # focused crop (subject-only) or a downscaled full frame.
        for slug, target, key, bbox in pending_keyframes:
            target[key] = save_keyframe(slug, out, bbox_norm=bbox)

        writer.write(out)

        # Progress every second of wall clock.
        wall = time.time()
        if wall - last_report >= 1.0 or frame_idx == n_frames:
            elapsed = wall - t0
            fps_proc = frame_idx / elapsed if elapsed > 0 else 0
            pct = (frame_idx / n_frames * 100) if n_frames else 0
            eta = (n_frames - frame_idx) / fps_proc if fps_proc > 0 else 0
            if progress_json:
                # Machine-readable one-per-line JSON — the backend parses these
                # and forwards to the Socket.IO room. No `\r` so lines flush cleanly.
                print(json.dumps({
                    'type': 'progress', 'frame': frame_idx, 'total': n_frames,
                    'fps': round(fps_proc, 2), 'eta': round(eta, 1),
                }), flush=True)
            else:
                print(f'\rframe {frame_idx}/{n_frames}  ({pct:5.1f}%)  '
                      f'{fps_proc:5.2f} fps  ETA {eta:5.0f}s', end='', flush=True)
            last_report = wall

    print()  # newline after progress bar
    writer.release()
    cap.release()

    # If OpenCV didn't manage H.264 directly, transcode with ffmpeg so the
    # output plays in Windows Media Player, Safari, and every HTML5 <video>.
    # We only re-encode when the container's codec is known-problematic —
    # mp4v is the WMP-broken case that motivated this whole branch.
    if used_codec not in ('avc1', 'H264', 'X264'):
        # Tell the frontend the frame loop is done and we're now transcoding.
        # Re-encoding a 4K clip is minutes on CPU; without this the UI shows
        # 100% and looks frozen.
        if progress_json:
            print(json.dumps({'type': 'phase', 'name': 'encoding'}), flush=True)
        reencode_to_h264(output_path)
        if progress_json:
            print(json.dumps({'type': 'phase', 'name': 'done'}), flush=True)

    print(f'\nDone in {time.time()-t0:.1f}s — output written to {output_path}')

    # ── Emit summary envelope for the UI to render stats + keyframes ──
    # `snap_dir` sits next to the output MP4 in the analyze_jobs job folder;
    # the backend exposes files under it via /analyze-video/:id/snapshot/:file.
    # Sort persons + vehicles by first-seen time so tabs read chronologically.
    # Also compute derived fields (duration) and drop the internal running
    # sum used to average confidence so it doesn't leak into the JSON.
    def stitch_tracks(entries, max_gap_s=5.0, max_dist=0.15,
                      max_size_ratio=1.6, hist_thresh=0.50):
        """Merge track pairs that look like the same subject.

        Greedy left-to-right sweep. A new track can merge into an earlier
        canonical if ALL of:
          - time gap between predecessor.last_s and successor.first_s ≤ max_gap_s
          - center-to-center distance ≤ max_dist (normalized 0..1)
          - box areas within max_size_ratio of each other
          - torso HSV histogram correlation ≥ hist_thresh (or, if either
            histogram is missing, a *tighter* spatial match is required)

        All four gates must pass. This is intentionally conservative —
        wrong merges lie about who was there; missed merges just leave a
        duplicate row, which is the lesser evil.
        """
        ordered = sorted(entries.values(), key=lambda e: e['first_s'])
        canonicals = []
        for e in ordered:
            best = None
            for c in canonicals:
                gap = e['first_s'] - c['last_s']
                if gap < 0 or gap > max_gap_s:
                    continue
                fb, nb = c.get('_last_box'), e.get('_first_box')
                if fb is None or nb is None:
                    continue
                cx1, cy1 = fb[0] + fb[2] / 2, fb[1] + fb[3] / 2
                cx2, cy2 = nb[0] + nb[2] / 2, nb[1] + nb[3] / 2
                dist = ((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2) ** 0.5
                if dist > max_dist:
                    continue
                a1, a2 = fb[2] * fb[3], nb[2] * nb[3]
                if a1 <= 0 or a2 <= 0:
                    continue
                if max(a1, a2) / min(a1, a2) > max_size_ratio:
                    continue
                h1, h2 = c.get('_ref_hist'), e.get('_ref_hist')
                if h1 is not None and h2 is not None:
                    sim = float(cv2.compareHist(h1, h2, cv2.HISTCMP_CORREL))
                    if sim < hist_thresh:
                        continue
                else:
                    # No colour signal — require a tighter spatial match.
                    if dist > max_dist * 0.6:
                        continue
                    sim = 0.0
                score = -dist + sim
                if best is None or score > best[0]:
                    best = (score, c)
            if best is not None:
                c = best[1]
                c['last_s'] = max(c['last_s'], e['last_s'])
                c['frame_count'] += e['frame_count']
                c['_sum_conf'] = c.get('_sum_conf', 0) + e.get('_sum_conf', 0)
                c['avg_conf'] = c['_sum_conf'] / max(1, c['frame_count'])
                c['face_seen'] = c.get('face_seen') or e.get('face_seen')
                if not c.get('recognized_name') and e.get('recognized_name'):
                    c['recognized_name'] = e['recognized_name']
                if not c.get('plate') and e.get('plate'):
                    c['plate'] = e['plate']
                if e.get('_last_box') is not None:
                    c['_last_box'] = e['_last_box']
                c['segments'] = c.get('segments', 1) + 1
                # Remember every original ByteTrack ID that folded into this
                # canonical — used below to inherit loitering flags after
                # stitching (a loitering event was recorded against the
                # original ID, but the summary now shows the canonical).
                if '_merged_ids' not in c:
                    c['_merged_ids'] = [c['trackId']]
                c['_merged_ids'].append(e['trackId'])
            else:
                e.setdefault('_merged_ids', [e['trackId']])
                canonicals.append(e)
        return {c['trackId']: c for c in canonicals}

    summary['persons']  = stitch_tracks(summary['persons'])
    summary['vehicles'] = stitch_tracks(summary['vehicles'])

    # Propagate loitering flag onto the canonical person entry. A merged
    # track loitered if ANY of the original ByteTrack IDs that fold into
    # it crossed the dwell threshold. Also copy over the peak dwell for
    # the row subtitle.
    loit_by_tid = {l['trackId']: l for l in summary['loitering']}
    for c in summary['persons'].values():
        ids = c.get('_merged_ids', [c['trackId']])
        peak = 0.0
        for tid in ids:
            l = loit_by_tid.get(tid)
            if l is not None:
                c['loitering'] = True
                if l.get('peak_dwell_s', 0) > peak:
                    peak = l['peak_dwell_s']
        if c.get('loitering') and peak > 0:
            c['peak_dwell_s'] = peak

    def _finalize(entries):
        out = []
        for e in sorted(entries.values(), key=lambda x: x['first_s']):
            e2 = {k: v for k, v in e.items() if not k.startswith('_')}
            e2['duration_s'] = round(e['last_s'] - e['first_s'], 1)
            if 'avg_conf' in e2:
                e2['avg_conf'] = round(e2['avg_conf'], 3)
            out.append(e2)
        return out
    persons_list  = _finalize(summary['persons'])
    vehicles_list = _finalize(summary['vehicles'])
    if progress_json:
        payload = {
            'type': 'summary',
            'counts': {
                'persons': len(persons_list),
                'vehicles': len(vehicles_list),
                'faces_recognized': len(summary['faces']),
                'plates_read': len(summary['plates']),
                'loitering_events': len(summary['loitering']),
                'fire_events': len(summary['fire']),
            },
            'persons':  persons_list,
            'vehicles': vehicles_list,
            'faces': [
                {'name': k, 'count': v['count'], 'snap': v['snap'], 'first_s': round(v['first_s'], 1)}
                for k, v in summary['faces'].items()
            ],
            'plates': [
                {'plate': k, 'count': v['count'], 'snap': v['snap'],
                 'first_s': v['first_s'], 'vehicleType': v['vehicleType']}
                for k, v in summary['plates'].items()
            ],
            'loitering': summary['loitering'],
            'fire': summary['fire'],
        }
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    else:
        # Human-readable summary for CLI users.
        print(f"Persons (unique tracks): {len(persons_list)}")
        print(f"Vehicles (unique tracks): {len(vehicles_list)}")
        print(f"Faces recognized: {len(summary['faces'])} — {', '.join(summary['faces'].keys())}")
        print(f"Plates read: {len(summary['plates'])} — {', '.join(summary['plates'].keys())}")
        print(f"Loitering events: {len(summary['loitering'])}")
        print(f"Fire/smoke events: {len(summary['fire'])}")

    return 0


def _find_ffmpeg():
    """Locate ffmpeg — first check PATH, then the portable copy in agent/."""
    import shutil, subprocess
    ff = shutil.which('ffmpeg')
    if ff: return ff
    # agent/agent.py auto-downloads ffmpeg.exe into agent/ on Windows.
    portable = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            'agent', 'ffmpeg.exe')
    if os.path.exists(portable): return portable
    return None


def reencode_to_h264(path):
    """Re-encode `path` in place to H.264 mp4 using ffmpeg. No-op if unavailable."""
    import subprocess, tempfile
    ff = _find_ffmpeg()
    if not ff:
        print('[warn] mp4v output — ffmpeg not found; file may not play in WMP/Safari.'
              ' Install ffmpeg or run agent.py once to auto-download it.',
              file=sys.stderr)
        return
    tmp = path + '.h264.mp4'
    print(f'Re-encoding to H.264 via ffmpeg for broad compatibility...')
    try:
        subprocess.run([ff, '-y', '-i', path,
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                        '-pix_fmt', 'yuv420p',   # WMP/Safari require yuv420p
                        '-movflags', '+faststart',  # progressive download
                        '-an',                    # analyzer produces no audio
                        tmp],
                       check=True, capture_output=True)
        os.replace(tmp, path)
        print('  → H.264 transcode complete')
    except subprocess.CalledProcessError as ex:
        print(f'[warn] ffmpeg re-encode failed: {ex.stderr.decode(errors="replace")[:400]}',
              file=sys.stderr)
        try:
            if os.path.exists(tmp): os.remove(tmp)
        except Exception: pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='Input video file (mp4/mkv/avi/etc.)')
    ap.add_argument('-o', '--output', default=None, help='Output MP4 path (default: <input>_annotated.mp4)')
    ap.add_argument('--enrollment-dir', default=None,
                    help='Path to face-ai/enrollments/<user_id>/ to enable name recognition')
    ap.add_argument('--downscale', type=float, default=0.5,
                    help='Downscale factor for detection (1.0 = full res, slower). Default 0.5.')
    ap.add_argument('--loitering-seconds', type=float, default=30.0,
                    help='Dwell time before a tracked person is flagged as loitering. Default 30s.')
    ap.add_argument('--progress-json', action='store_true',
                    help='Emit per-second JSON progress lines on stdout (for backend to parse).')
    ap.add_argument('--no-fire', action='store_true',
                    help='Skip fire/smoke detection entirely. The HSV heuristic fires on '
                         'brake lights, sunsets, and warm surfaces — set this for daytime '
                         'street footage where fire is not the target.')
    ap.add_argument('--person-conf', type=float, default=0.4,
                    help='YOLO person-class confidence threshold. Default 0.4 (was 0.6 for '
                         'near-camera CCTV). Lower catches more distant/small figures.')
    ap.add_argument('--person-min-area', type=float, default=0.005,
                    help='Reject person boxes below this relative area (0..1). Default 0.005 '
                         '(0.5%% of frame). Was 0.05 for near-camera CCTV — too aggressive '
                         'for wide street shots.')
    ap.add_argument('--yolo-model', default=None,
                    help='YOLO weights filename (relative to face-ai/) or absolute path. '
                         'Default reuses detect.py\'s yolov8n.pt. Try yolov8s.pt / yolov8m.pt '
                         'for far-better small-object recall (ultralytics auto-downloads).')
    ap.add_argument('--yolo-imgsz', type=int, default=None,
                    help='YOLO inference resolution. Default 640 (ultralytics default). '
                         'Push to 960 or 1280 to catch distant/small people — CPU cost '
                         'scales ~quadratically.')
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        print(f'ERROR: input not found: {args.input}', file=sys.stderr); return 1
    if args.output is None:
        stem, ext = os.path.splitext(args.input)
        args.output = f'{stem}_annotated.mp4'

    return process_video(args.input, args.output,
                         enrollment_dir=args.enrollment_dir,
                         downscale=args.downscale,
                         loitering_seconds=args.loitering_seconds,
                         progress_json=args.progress_json,
                         detect_fire=not args.no_fire,
                         person_conf=args.person_conf,
                         person_min_area=args.person_min_area,
                         yolo_model_path=args.yolo_model,
                         yolo_imgsz=args.yolo_imgsz)


if __name__ == '__main__':
    sys.exit(main())
