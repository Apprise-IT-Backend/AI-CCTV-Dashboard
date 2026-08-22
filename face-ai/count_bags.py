"""Offline bag counting — run the live counter over a recorded clip.

Purpose: verify the count against a hand count, and tune the line/thresholds,
without touching the live stack. It uses the exact same BagCounter as the AI
worker, at the same cadence and downscale, so a number you trust here is the
number you get live.

  # Count with the default line, print each crossing
  python face-ai/count_bags.py belt.mp4

  # Custom line + belt ROI, one-way counting, write an annotated video
  python face-ai/count_bags.py belt.mp4 \
      --line 0.1,0.8,0.9,0.6 --roi 0.0,0.4,1.0,0.6 \
      --direction positive --out counted.mp4

  # Reject motion from workers beside the belt (loads YOLOv8, slower)
  python face-ai/count_bags.py belt.mp4 --persons

Tuning loop: if bags are missed, lower --min-area or --min-fill; if noise is
counted, raise them, or fence the belt off with --roi. Every threshold is also
readable from the environment (see bag_counter.py) so the values you settle on
here can be handed straight to the worker.
"""

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bag_counter  # noqa: E402  — must follow the sys.path insert

HERE = os.path.dirname(os.path.abspath(__file__))

# Match the live worker so counts transfer: face-ai/detect.py processes at
# TARGET_FPS on frames downscaled by 0.5.
TARGET_FPS = 8.0
DOWNSCALE = 0.5


def parse_tuple(text, n, name):
    if not text:
        return None
    parts = [p.strip() for p in text.split(',') if p.strip() != '']
    if len(parts) != n:
        raise SystemExit(f'--{name} needs {n} comma-separated numbers, got "{text}"')
    try:
        return [float(p) for p in parts]
    except ValueError:
        raise SystemExit(f'--{name} values must be numbers, got "{text}"')


def main():
    ap = argparse.ArgumentParser(description='Count conveyor bags crossing a line in a video file.')
    ap.add_argument('video', help='input video file')
    ap.add_argument('--line', help='counting line as x1,y1,x2,y2 in 0..1 (default: bag_counter.DEFAULT_LINE)')
    ap.add_argument('--roi', help='restrict detection to belt region x,y,w,h in 0..1')
    ap.add_argument('--direction', choices=bag_counter.VALID_DIRECTIONS, default='both',
                    help='which crossing sense counts (default both; track mode only)')
    ap.add_argument('--mode', choices=bag_counter.VALID_MODES, default=None,
                    help='gate = occupancy tripwire on the line (default, accurate on a '
                         'loaded belt). track = blob detection + per-object tracking '
                         '(gives per-bag boxes/IDs, loses counts when bags touch).')
    ap.add_argument('--out', help='write an annotated video here')
    ap.add_argument('--model', default=os.path.join(HERE, 'bag_model.pt'),
                    help='optional YOLO bag checkpoint (default face-ai/bag_model.pt if present)')
    ap.add_argument('--persons', action='store_true',
                    help='run YOLOv8 person detection to veto motion blobs that are people')
    ap.add_argument('--fps', type=float, default=TARGET_FPS,
                    help=f'processing cadence (default {TARGET_FPS}, matching the live worker)')
    ap.add_argument('--min-area', type=float, help='override BAG_MIN_AREA_RATIO')
    ap.add_argument('--max-area', type=float, help='override BAG_MAX_AREA_RATIO')
    ap.add_argument('--min-fill', type=float, help='override BAG_MIN_FILL')
    ap.add_argument('--bg-history', type=int, help='override BAG_BG_HISTORY')
    ap.add_argument('--bg-learning-rate', type=float,
                    help='override BAG_BG_LEARNING_RATE. Try 0.001 on a slow belt: '
                         'the default auto rate absorbs slow-moving bags into the '
                         'background so they stop being detected mid-belt.')
    ap.add_argument('--debug', action='store_true',
                    help='print why candidate blobs were rejected — run this first '
                         'when nothing is being detected.')
    ap.add_argument('--mask-out', default=None,
                    help='write the raw motion mask beside the frame to this MP4. '
                         'The fastest way to SEE whether the belt/bags register.')
    ap.add_argument('--quiet', action='store_true', help='only print the final total')
    args = ap.parse_args()

    # Module-level thresholds are read at call time, so patching them here is
    # enough — no need to thread overrides through BagCounter's constructor.
    if args.min_area is not None: bag_counter.BAG_MIN_AREA_RATIO = args.min_area
    if args.max_area is not None: bag_counter.BAG_MAX_AREA_RATIO = args.max_area
    if args.min_fill is not None: bag_counter.BAG_MIN_FILL = args.min_fill
    if args.bg_history is not None: bag_counter.BAG_BG_HISTORY = args.bg_history
    if args.bg_learning_rate is not None:
        bag_counter.BAG_BG_LEARNING_RATE = args.bg_learning_rate

    line_vals = parse_tuple(args.line, 4, 'line')
    roi_vals = parse_tuple(args.roi, 4, 'roi')
    spec = dict(bag_counter.DEFAULT_LINE)
    if line_vals:
        spec.update({'x1': line_vals[0], 'y1': line_vals[1],
                     'x2': line_vals[2], 'y2': line_vals[3]})
    spec['direction'] = args.direction
    if args.mode:
        spec['mode'] = args.mode
    spec['roi'] = ({'x': roi_vals[0], 'y': roi_vals[1], 'w': roi_vals[2], 'h': roi_vals[3]}
                   if roi_vals else None)
    line = bag_counter.normalize_line(spec)
    if line is None:
        raise SystemExit('the supplied line is unusable (zero-length?)')

    model = None
    if args.model and os.path.exists(args.model) and os.path.getsize(args.model) > 1000000:
        from ultralytics import YOLO
        model = YOLO(args.model)
        print(f'[bags] using trained detector: {args.model}')
    else:
        print('[bags] no bag_model.pt — using motion fallback '
              '(fixed camera assumed; pass --roi to fence off the belt)')

    person_model = None
    if args.persons:
        from ultralytics import YOLO
        person_model = YOLO(os.path.join(HERE, 'yolov8n.pt'))
        print('[bags] person veto enabled')

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f'cannot open {args.video}')
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # Sample down to the processing cadence instead of processing every frame,
    # so track displacement per processed frame matches the live worker.
    step = max(1, int(round(src_fps / max(1.0, args.fps))))
    print(f'[bags] {os.path.basename(args.video)}: {n_frames} frames @ {src_fps:.1f} fps '
          f'-> processing every {step} frame(s)')

    counter = bag_counter.make_counter(line, model=model)
    counter.keep_mask = bool(args.mask_out)
    print(f'[bags] counting mode: {line["mode"]}')
    writer = None
    mask_writer = None
    total = 0
    idx = -1
    processed = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        idx += 1
        if idx % step:
            continue

        # Video time, not wall clock — track TTLs must follow the footage.
        t = idx / src_fps
        small = cv2.resize(frame, (0, 0), fx=DOWNSCALE, fy=DOWNSCALE)

        person_boxes = []
        if person_model is not None:
            res = person_model(small, verbose=False)[0]
            for box in res.boxes:
                if person_model.names[int(box.cls[0])] != 'person':
                    continue
                if float(box.conf[0]) < 0.6:
                    continue
                person_boxes.append(box.xyxyn[0].tolist())

        dets, events = counter.update(small, person_boxes, t)
        processed += 1

        if args.mask_out and counter.last_mask is not None:
            # Frame on the left, what the detector actually sees on the right.
            # If the bags aren't white blobs here, no threshold change will help.
            m = cv2.cvtColor(counter.last_mask, cv2.COLOR_GRAY2BGR)
            if m.shape[:2] != small.shape[:2]:
                # ROI-cropped mask — pad it back to full frame position.
                pad = np.zeros_like(small)
                roi = line.get('roi')
                sh, sw = small.shape[:2]
                oy = int(roi['y'] * sh) if roi else 0
                ox = int(roi['x'] * sw) if roi else 0
                pad[oy:oy + m.shape[0], ox:ox + m.shape[1]] = m
                m = pad
            side = np.hstack([small, m])
            if mask_writer is None:
                mask_writer = cv2.VideoWriter(
                    args.mask_out, cv2.VideoWriter_fourcc(*'mp4v'),
                    max(1.0, args.fps), (side.shape[1], side.shape[0]))
            mask_writer.write(side)

        for ev in events:
            total += 1
            if not args.quiet:
                print(f'  bag #{total:5d}  t={t:7.2f}s  track={ev["trackId"]:<5d} '
                      f'{ev["direction"]:<8s} conf={ev["confidence"]:.2f}')

        if args.out:
            if writer is None:
                h, w = frame.shape[:2]
                writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*'mp4v'),
                                         max(1.0, args.fps), (w, h))
            annotate(frame, dets, line, total)
            writer.write(frame)

    cap.release()
    if writer is not None:
        writer.release()
        print(f'[bags] annotated video written to {args.out}')
    if mask_writer is not None:
        mask_writer.release()
        print(f'[bags] motion mask written to {args.mask_out} (frame | mask)')

    duration = (idx + 1) / src_fps if idx >= 0 else 0
    rate = (total / duration * 60.0) if duration > 0 else 0
    print(f'\n[bags] TOTAL: {total} bags over {duration:.1f}s  ({rate:.1f} bags/min)')

    if args.debug:
        s = counter.stats
        print(f'\n[debug] {processed} frames processed, '
              f'{s["contours"]} candidate blobs found in total')
        if not s['contours']:
            print('[debug] NOTHING registered as motion at all. Either the ROI '
                  'excludes the belt, or the belt is stopped in this clip.')
        rows = [
            ('accepted as bag candidates', s['accepted']),
            ('rejected: smaller than 4px', s['rej_tiny']),
            (f'rejected: area < {bag_counter.BAG_MIN_AREA_RATIO} of frame', s['rej_area_small']),
            (f'rejected: area > {bag_counter.BAG_MAX_AREA_RATIO} of frame', s['rej_area_big']),
            (f'rejected: fill < {bag_counter.BAG_MIN_FILL}', s['rej_fill']),
            (f'rejected: aspect outside {bag_counter.BAG_ASPECT_MIN}-{bag_counter.BAG_ASPECT_MAX}', s['rej_aspect']),
            ('rejected: overlapped a person box', s['rej_person']),
        ]
        for label, n in rows:
            pct = (n / s['contours'] * 100) if s['contours'] else 0
            print(f'  {label:<52s} {n:7d}  ({pct:5.1f}%)')
        print(f'[debug] largest blob seen: {counter.max_blob_ratio:.4f} of frame '
              f'(max allowed {bag_counter.BAG_MAX_AREA_RATIO})')
        print(f'[debug] tracks created: {counter.next_id - 1}, counted: {total}')
        # The two failure modes worth calling out explicitly.
        if s['rej_area_small'] > s['accepted'] and s['rej_area_small']:
            print('[debug] HINT: most blobs are too small — lower --min-area '
                  '(try 0.001), or the bags are only fragments of their true size, '
                  'which means the belt and bag are too similar in brightness.')
        if s['rej_area_big'] > s['accepted'] and s['rej_area_big']:
            print('[debug] HINT: most blobs are too LARGE — the belt surface is '
                  'being segmented along with the bags and merging into one blob. '
                  'Tighten --roi to just the belt, or train bag_model.pt.')
        if counter.next_id - 1 > total * 3 and total:
            print('[debug] HINT: many tracks never counted — they are probably '
                  'dying before reaching the line. Raise --bg-learning-rate '
                  'sensitivity (try --bg-learning-rate 0.001) or widen the line.')


def annotate(frame, dets, line, total):
    """Burn boxes, the counting line and the running total onto a full-res frame."""
    h, w = frame.shape[:2]
    cv2.line(frame,
             (int(line['x1'] * w), int(line['y1'] * h)),
             (int(line['x2'] * w), int(line['y2'] * h)),
             (182, 114, 244), 2)
    for d in dets:
        x1, y1 = int(d['x'] * w), int(d['y'] * h)
        x2, y2 = int((d['x'] + d['w']) * w), int((d['y'] + d['h']) * h)
        color = (137, 211, 52) if d['counted'] else (250, 139, 167)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, f'#{d["trackId"]}', (x1, max(14, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
    label = f'BAGS: {total}'
    cv2.putText(frame, label, (16, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 5, cv2.LINE_AA)
    cv2.putText(frame, label, (16, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2, cv2.LINE_AA)


if __name__ == '__main__':
    main()
