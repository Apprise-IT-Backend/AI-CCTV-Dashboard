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
                  detect_fire=True, person_conf=0.4, person_min_area=0.005):
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
                    yres = detect.yolo_model.track(small, persist=True,
                                                   tracker='bytetrack.yaml',
                                                   verbose=False)[0]
                except Exception:
                    yres = detect.yolo_model(small, verbose=False)[0]
                for box in yres.boxes:
                    cls_id = int(box.cls[0])
                    conf = float(box.conf[0])
                    label = detect.yolo_model.names[cls_id]
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
                        if tid is not None: det['trackId'] = tid
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

        # 4. Plate pipeline — sampled per vehicle track (OCR is expensive)
        try:
            for tid in list(plate_state.keys()):
                if now - plate_state[tid].get('last_ocr_at', 0) > 10.0:
                    del plate_state[tid]
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
                crop = small[y1p:y2p, x1p:x2p]
                plates = detect.detect_plates_in_vehicle(crop)
                if not plates: continue
                plates.sort(key=lambda p: p['conf'], reverse=True)
                best = plates[0]
                px, py, pw, ph = best['box']
                axn = (x1p + px) / sw; ayn = (y1p + py) / sh
                awn = pw / sw; ahn = ph / sh
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
                detections.append({
                    'x': axn, 'y': ayn, 'w': awn, 'h': ahn,
                    'confidence': best['conf'] or 0.5,
                    'label': 'plate', 'name': ps['plate'], 'trackId': tid,
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
                         person_min_area=args.person_min_area)


if __name__ == '__main__':
    sys.exit(main())
