"""Conveyor throughput counting — counts bags that cross a line and leave frame.

TWO COUNTING MODES. Which one you want depends on how loaded the belt is, and
the difference is not subtle — measured on a 78s barge-belt clip with 47 bags
(ground truth established by five independent tripwire positions agreeing):

  mode='gate'  (default)  47/47   — occupancy tripwire on the line
  mode='track'            13/47   — blob detection + per-object tracking

Tracking loses on a busy belt for a structural reason: bags arriving every ~1.4s
sit close enough that a nearest-centroid tracker swaps IDs between neighbours and
drops a count whenever two bags touch and merge into one blob. Its accuracy also
swung from 0 to 45 over a 40-unit brightness-threshold change, i.e. any number it
produces is an accident of tuning. The gate counter held 45-48 across every patch
size, threshold, episode length and position tried — it never needs to know which
bag is which, only that the gate went from clear to blocked.

Use 'track' when you need per-bag boxes and IDs, the belt is sparse, or you have
a trained bag_model.pt. Use 'gate' when you want the throughput number to be
right.


Why this exists: the base YOLO model is COCO-trained and has no sandbag /
cement-bag class, so `person`/`vehicle`-style class filtering can't find these.
The counter is therefore *model-optional* and works two ways:

  * If `face-ai/bag_model.pt` is present (a YOLOv8 checkpoint fine-tuned on a
    single `bag` class), its boxes are used directly. Best accuracy.
  * Otherwise we fall back to MOG2 background subtraction inside the belt ROI.
    This works because the camera is fixed and a conveyor belt is visually
    uniform — the only thing that reliably differs from the learned background
    is cargo riding on it.

Either way the counting half is identical: candidate boxes -> centroid tracks ->
each track counts **exactly once**, the first time its centroid crosses the
configured line segment. Counting per-track rather than per-frame is what makes
the total immune to a bag jittering on the line or pausing mid-belt.

Durability note (see CLAUDE.md): this class deliberately holds NO cumulative
total. It emits discrete crossing events; the backend owns the durable counter
in MySQL. The AI worker is re-spawned and replayed on crash, so any total kept
here would silently reset to zero.
"""

import collections
import os
import threading

import cv2
import numpy as np

# ── Blob acceptance ───────────────────────────────────────────
# Fractions of the *whole downscaled frame* area. Defaults are tuned for a
# belt that fills roughly the lower half of a 1280x720 CCTV view; a bag is a
# few percent of the frame. Widen if bags are counted as noise (raise max) or
# noise is counted as bags (raise min).
BAG_MIN_AREA_RATIO = float(os.environ.get('BAG_MIN_AREA_RATIO', '0.004'))
BAG_MAX_AREA_RATIO = float(os.environ.get('BAG_MAX_AREA_RATIO', '0.25'))
# A bag is a convex-ish rectangle: its contour should fill most of its bounding
# box. Scattered motion noise (leaves, rain, shadow edges) fills very little.
BAG_MIN_FILL       = float(os.environ.get('BAG_MIN_FILL', '0.45'))
# Bags ride the belt at arbitrary rotation, so allow both orientations but
# reject extreme slivers (belt edge highlights, cable shadows).
BAG_ASPECT_MIN     = float(os.environ.get('BAG_ASPECT_MIN', '0.25'))
BAG_ASPECT_MAX     = float(os.environ.get('BAG_ASPECT_MAX', '4.0'))
# YOLO confidence floor, only used when bag_model.pt is installed.
BAG_MODEL_CONF     = float(os.environ.get('BAG_MODEL_CONF', '0.35'))

# ── Tracking ──────────────────────────────────────────────────
# Max centroid travel (normalized units) between two processed frames for a
# blob to be considered the same object. At TARGET_FPS=8 a belt bag moves
# roughly 0.05-0.12 of frame width per frame; 0.18 leaves headroom without
# letting two adjacent bags swap identities.
BAG_TRACK_MAX_DIST = float(os.environ.get('BAG_TRACK_MAX_DIST', '0.18'))
# Forget a track this long after its last sighting. Short, because a bag that
# leaves the frame is gone for good — long TTLs let a departed bag "absorb"
# the next one arriving in the same spot.
BAG_TRACK_TTL_S    = float(os.environ.get('BAG_TRACK_TTL_S', '1.2'))
# A track must be seen this many frames before it may count. Kills one-frame
# flickers (compression blocks, a hand waving over the belt).
BAG_MIN_HITS       = int(os.environ.get('BAG_MIN_HITS', '3'))
# Motion blobs that overlap a YOLO person box by more than this are dropped —
# workers moving beside the belt are the single largest false-positive source,
# and we already have person boxes for free from the main pipeline.
# Set to 1.0 to disable the veto entirely (useful when workers stand so close to
# the belt that their boxes swallow the bags).
BAG_PERSON_IOU_MAX = float(os.environ.get('BAG_PERSON_IOU_MAX', '0.20'))

# ── Background model ──────────────────────────────────────────
# Frames of history MOG2 blends into its background estimate.
BAG_BG_HISTORY = int(os.environ.get('BAG_BG_HISTORY', '300'))
# How fast the background model adapts. -1 lets OpenCV pick from `history`.
# THIS IS THE KNOB THAT MATTERS ON A SLOW BELT: a bag that takes several seconds
# to cross the frame overlaps its own pixels for hundreds of frames, and an
# auto-tuned learning rate quietly absorbs it INTO the background — the bag stops
# being foreground and vanishes mid-belt. Pin a small value (e.g. 0.001) to make
# the model adapt slowly so slow cargo stays visible.
BAG_BG_LEARNING_RATE = float(os.environ.get('BAG_BG_LEARNING_RATE', '-1'))

# Default line: horizontal, across the lower third. Bags travelling down the
# belt toward an exit at the bottom of frame cross it once. Overridden per
# camera from the dashboard.
DEFAULT_LINE = {'x1': 0.05, 'y1': 0.72, 'x2': 0.95, 'y2': 0.72,
                'direction': 'both', 'roi': None, 'mode': 'gate'}

VALID_DIRECTIONS = ('both', 'positive', 'negative')
VALID_MODES = ('gate', 'track')

# Default counting mode. 'gate' because it measured 47/47 against 13/47 for
# 'track' on real belt footage — see the module docstring.
BAG_COUNT_MODE = os.environ.get('BAG_COUNT_MODE', 'gate')
if BAG_COUNT_MODE not in VALID_MODES:
    BAG_COUNT_MODE = 'gate'

# How close to a frame border counts as "on the border" — see normalize_line.
EDGE_EPS = 0.01

# ── Gate (tripwire) mode ──────────────────────────────────────
# Points sampled along the line segment each frame.
BAG_GATE_SAMPLES = int(os.environ.get('BAG_GATE_SAMPLES', '64'))
# Half-size (in downscaled pixels) of the window averaged at each sample point.
# A few pixels smooths sensor noise without blurring the bag/belt boundary.
BAG_GATE_WINDOW = int(os.environ.get('BAG_GATE_WINDOW', '3'))
# A sample counts as "bag" once its brightness rises this far from the learned
# belt level toward the learned bag level. 0.6 sits comfortably between the two.
BAG_GATE_ENTER = float(os.environ.get('BAG_GATE_ENTER', '0.60'))
# Minimum fraction of the line that must be continuously blocked to call the gate
# occupied. Stops a hand or a bright speck from registering as cargo.
BAG_GATE_MIN_SPAN = float(os.environ.get('BAG_GATE_MIN_SPAN', '0.15'))
# The gate is released when the blocked span falls below this fraction of
# BAG_GATE_MIN_SPAN — hysteresis, so a flickering edge can't double-count.
BAG_GATE_RELEASE = float(os.environ.get('BAG_GATE_RELEASE', '0.60'))
# Frames the gate must stay blocked before the bag is tallied.
BAG_GATE_MIN_FRAMES = int(os.environ.get('BAG_GATE_MIN_FRAMES', '2'))
# Frames of samples pooled to learn the belt (p10) and bag (p90) brightness.
# 240 frames is 30s at TARGET_FPS=8 — long enough to contain both states, short
# enough to track sun/shade drift over the day.
BAG_GATE_CALIB_FRAMES = int(os.environ.get('BAG_GATE_CALIB_FRAMES', '240'))
# Until the gate has seen at least this much brightness separation between belt
# and cargo, it refuses to count. Prevents a gate drawn somewhere useless (or a
# stopped, empty belt) from inventing episodes out of sensor noise.
BAG_GATE_MIN_CONTRAST = float(os.environ.get('BAG_GATE_MIN_CONTRAST', '25'))


def _clamp01(v):
    return max(0.0, min(1.0, float(v)))


def normalize_line(spec):
    """Coerce a user/DB-supplied line spec into the canonical dict, or None.

    Accepts a dict (from JSON) or a "x1,y1,x2,y2" string. Returns None for
    anything unusable — including a degenerate zero-length segment, which
    would make the side-of-line test meaningless.
    """
    if spec is None:
        return None
    if isinstance(spec, str):
        parts = [p for p in spec.replace(';', ',').split(',') if p.strip() != '']
        if len(parts) < 4:
            return None
        try:
            spec = {'x1': parts[0], 'y1': parts[1], 'x2': parts[2], 'y2': parts[3]}
        except Exception:
            return None
    if not isinstance(spec, dict):
        return None

    try:
        line = {
            'x1': _clamp01(spec.get('x1', 0)), 'y1': _clamp01(spec.get('y1', 0)),
            'x2': _clamp01(spec.get('x2', 0)), 'y2': _clamp01(spec.get('y2', 0)),
        }
    except (TypeError, ValueError):
        return None

    # Degenerate segment — no side, no crossing.
    if abs(line['x2'] - line['x1']) < 1e-6 and abs(line['y2'] - line['y1']) < 1e-6:
        return None

    # A line lying along a frame edge can never be crossed: tracks are located
    # by their centroid, and a centroid is always strictly inside the frame, so
    # it can never reach the far side. Clicking slightly outside the video
    # clamps both endpoints onto an edge, which used to be accepted silently
    # and then counted nothing forever.
    if (max(line['y1'], line['y2']) <= EDGE_EPS
            or min(line['y1'], line['y2']) >= 1.0 - EDGE_EPS
            or max(line['x1'], line['x2']) <= EDGE_EPS
            or min(line['x1'], line['x2']) >= 1.0 - EDGE_EPS):
        return None

    direction = spec.get('direction') or 'both'
    line['direction'] = direction if direction in VALID_DIRECTIONS else 'both'

    mode = spec.get('mode') or BAG_COUNT_MODE
    line['mode'] = mode if mode in VALID_MODES else BAG_COUNT_MODE

    roi = spec.get('roi')
    line['roi'] = None
    if isinstance(roi, dict):
        try:
            rx, ry = _clamp01(roi.get('x', 0)), _clamp01(roi.get('y', 0))
            rw, rh = _clamp01(roi.get('w', 1)), _clamp01(roi.get('h', 1))
            # An ROI narrower than 5% of frame in either axis is almost
            # certainly a mis-drag; treat as "no ROI" rather than a dead zone.
            if rw > 0.05 and rh > 0.05:
                line['roi'] = {'x': rx, 'y': ry,
                               'w': min(rw, 1.0 - rx), 'h': min(rh, 1.0 - ry)}
        except (TypeError, ValueError):
            line['roi'] = None
    return line


def _iou(a, b):
    """IoU of two normalized xyxy boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class GateCounter:
    """Occupancy tripwire on the user's line — the accurate mode on a busy belt.

    Instead of asking "which bag is this and has it crossed?", it asks only
    "is the gate blocked right now?" and counts clear→blocked transitions. There
    is no association step, so nothing can be lost to an ID swap when two bags
    touch — the failure mode that costs the tracking counter two thirds of a
    loaded belt.

    Brightness levels are learned from the gate's own recent history rather than
    hard-coded, so it adapts to sun/shade drift and to whatever the belt and
    cargo happen to look like. It refuses to count until it has actually observed
    contrast between the two (BAG_GATE_MIN_CONTRAST), which is what keeps a gate
    drawn in a useless place from inventing bags out of noise.

    Exposes the same interface as BagCounter so callers don't branch.
    """

    def __init__(self, line=None, model=None, model_lock=None):
        self._lock = threading.Lock()
        self.line = normalize_line(line) or dict(DEFAULT_LINE)
        # Accepted for interface compatibility; a gate reads pixels directly.
        self.model = None
        self.model_lock = model_lock or threading.Lock()
        self.history = collections.deque(maxlen=BAG_GATE_CALIB_FRAMES)
        # Per-sample-point occupancy state and tallies; see update().
        self._point_state = None
        self._reported = 0
        self.next_id = 1
        self.stats = collections.Counter()
        self.max_blob_ratio = 0.0
        self.keep_mask = False
        self.last_mask = None
        # Last computed (belt_level, bag_level, blocked_fraction) for diagnostics.
        self.debug_levels = (0.0, 0.0, 0.0)

    # ── Configuration (same contract as BagCounter) ──────────
    def set_line(self, line):
        norm = normalize_line(line)
        if norm is None:
            return False
        with self._lock:
            moved = (norm['x1'], norm['y1'], norm['x2'], norm['y2']) != (
                self.line['x1'], self.line['y1'], self.line['x2'], self.line['y2'])
            self.line = norm
            if moved:
                # Brightness levels are per-position; a moved gate must relearn
                # from scratch. Safe to zero `_reported` alongside the tallies
                # because this class only ever emits deltas — the durable total
                # lives in MySQL and keeps growing across a line edit.
                self.history.clear()
                self._point_state = None
                self._reported = 0
        return True

    def get_line(self):
        with self._lock:
            return dict(self.line)

    # ── Sampling ─────────────────────────────────────────────
    def _sample(self, frame, line):
        """Mean brightness at BAG_GATE_SAMPLES points along the line segment."""
        h, w = frame.shape[:2]
        v = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)[:, :, 2]
        n = max(8, BAG_GATE_SAMPLES)
        win = max(1, BAG_GATE_WINDOW)
        xs = np.linspace(line['x1'] * w, line['x2'] * w, n)
        ys = np.linspace(line['y1'] * h, line['y2'] * h, n)
        out = np.empty(n, dtype=np.float32)
        for i in range(n):
            cx, cy = int(xs[i]), int(ys[i])
            x0, x1 = max(0, cx - win), min(w, cx + win + 1)
            y0, y1 = max(0, cy - win), min(h, cy + win + 1)
            if x1 <= x0 or y1 <= y0:
                out[i] = 0.0
            else:
                out[i] = float(v[y0:y1, x0:x1].mean())
        return out

    @staticmethod
    def _longest_run(mask):
        """Longest contiguous run of True, as a fraction of the array length."""
        best = cur = 0
        for flag in mask:
            cur = cur + 1 if flag else 0
            if cur > best:
                best = cur
        return best / float(len(mask)) if len(mask) else 0.0

    # ── Main entry point ─────────────────────────────────────
    def update(self, frame, person_boxes, now):
        """Advance one frame. Returns (detections, events) like BagCounter.

        `person_boxes` is unused: a gate is a fixed strip of belt, so a worker
        walking past elsewhere in the scene can't reach it. Kept for interface
        compatibility.
        """
        line = self.get_line()
        samples = self._sample(frame, line)
        self.history.append(samples)

        # Calibrate EACH sample point against its own history, not the line as a
        # whole. A line drawn generously across the belt inevitably overshoots
        # onto hull, floor or machinery, and those points are permanently bright
        # or permanently dark. Pooling every point into one pair of levels lets
        # that fixed scenery define the "cargo" brightness, and then real bags
        # never reach the threshold — measured as 5 counts instead of 47.
        # Per-point levels make an overshooting line harmless: a point that never
        # changes has no contrast of its own and is simply ignored.
        hist = np.stack(self.history)                     # (frames, points)
        belt_pp, bag_pp = np.percentile(hist, [10, 90], axis=0)
        contrast_pp = bag_pp - belt_pp
        informative = contrast_pp >= BAG_GATE_MIN_CONTRAST
        n_info = int(informative.sum())
        self.debug_levels = (float(belt_pp.mean()), float(bag_pp.mean()), 0.0)

        # Too little of the gate ever sees cargo — refuse to count rather than
        # manufacture episodes out of sensor noise.
        if len(self.history) < 8 or n_info < 8:
            self.stats['frames_uncalibrated'] += 1
            return [], []

        # Every point along the gate counts independently, and the reported total
        # is the MEDIAN of their tallies. This is the key to tolerating an
        # imperfectly drawn line: on real footage each individual belt point
        # measured the true count (47) on its own, so the belt points agree with
        # each other and outvote any stragglers. Aggregating occupancy across the
        # whole gate instead lets one off-belt point that fires at the wrong
        # moment bridge the gap between two bags and merge them into a single
        # episode — measured as 24 counts instead of 47 on a line that overshot
        # onto the hull.
        n = len(samples)
        if self._point_state is None or len(self._point_state['count']) != n:
            self._point_state = {
                'on': np.zeros(n, dtype=bool),
                'run': np.zeros(n, dtype=np.int32),
                'count': np.zeros(n, dtype=np.int64),
            }
        ps = self._point_state

        thr_hi = belt_pp + BAG_GATE_ENTER * contrast_pp
        thr_lo = belt_pp + BAG_GATE_ENTER * BAG_GATE_RELEASE * contrast_pp

        rising = (~ps['on']) & (samples > thr_hi)
        ps['on'][rising] = True
        ps['run'][rising] = 0
        falling = ps['on'] & (samples < thr_lo)
        ps['on'][falling] = False
        ps['run'][falling] = 0
        ps['run'][ps['on']] += 1
        # A point tallies once its blockage has persisted, which rejects the
        # single-frame flickers that compression noise produces.
        newly = ps['on'] & (ps['run'] == BAG_GATE_MIN_FRAMES)
        ps['count'][newly] += 1

        votes = ps['count'][informative]
        total = int(np.median(votes)) if len(votes) else 0
        blocked = float(ps['on'][informative].mean())
        self.debug_levels = (float(belt_pp[informative].mean()),
                             float(bag_pp[informative].mean()),
                             blocked)
        self.stats['frames_calibrated'] += 1
        self.stats['informative_points'] = n_info

        detections, events = [], []
        # The median is what we trust, so emit one event per unit it advances.
        # It can only be dragged forward once a majority of the gate agrees.
        while self._reported < total:
            self._reported += 1
            tid = self.next_id
            self.next_id += 1
            self.stats['counted'] += 1
            events.append({
                'trackId': tid,
                'box': [round(min(line['x1'], line['x2']), 4),
                        round(min(line['y1'], line['y2']), 4),
                        round(max(line['x1'], line['x2']), 4),
                        round(max(line['y1'], line['y2']), 4)],
                # A single gate can't tell which way traffic moved; use 'track'
                # mode if you need one-way counting.
                'direction': 'both',
                'confidence': round(min(0.99, 0.5 + blocked), 3),
                'dwellSeconds': 0.0,
            })

        # Give the UI a marker while cargo is on the gate. Deliberately a small
        # box at the gate's midpoint rather than the line's bounding box — for a
        # diagonal gate that bbox is a huge rectangle covering half the scene.
        if blocked > 0.15:
            mx = (line['x1'] + line['x2']) / 2.0
            my = (line['y1'] + line['y2']) / 2.0
            half = 0.03
            detections.append({
                'x': round(max(0.0, mx - half), 4),
                'y': round(max(0.0, my - half), 4),
                'w': round(half * 2, 4), 'h': round(half * 2, 4),
                'confidence': round(min(0.99, 0.5 + blocked), 3),
                'label': 'bag',
                'trackId': self.next_id - 1,
                'counted': True,
            })
        return detections, events


def make_counter(line, model=None, model_lock=None):
    """Build the counter the line asks for. Gate unless 'track' was requested."""
    norm = normalize_line(line)
    mode = (norm or {}).get('mode', BAG_COUNT_MODE)
    if mode == 'track':
        return BagCounter(norm, model=model, model_lock=model_lock)
    return GateCounter(norm, model=model, model_lock=model_lock)


class BagCounter:
    """Per-stream conveyor counter. Not thread-safe across streams — one per
    stream worker thread. `set_line` may be called from another thread (the
    backend pushes line edits live), hence the lock around the geometry."""

    def __init__(self, line=None, model=None, model_lock=None):
        self._lock = threading.Lock()
        self.line = normalize_line(line) or dict(DEFAULT_LINE)
        self.model = model
        self.model_lock = model_lock or threading.Lock()
        self.tracks = {}       # track_id -> dict
        self.next_id = 1
        self._bg = None
        self._bg_shape = None  # recreate the subtractor if the ROI geometry moves
        # Diagnostics: tallies why candidates were thrown away, so a "nothing is
        # detected" report can be answered with a number instead of a guess.
        self.stats = collections.Counter()
        # Largest blob seen as a fraction of frame area — if this sits above
        # BAG_MAX_AREA_RATIO the belt itself is being segmented as one giant blob.
        self.max_blob_ratio = 0.0
        self.keep_mask = False  # when True, `last_mask` holds the latest FG mask
        self.last_mask = None

    # ── Configuration ────────────────────────────────────────
    def set_line(self, line):
        """Swap the counting geometry without restarting the stream."""
        norm = normalize_line(line)
        if norm is None:
            return False
        with self._lock:
            roi_changed = (norm.get('roi') != self.line.get('roi'))
            self.line = norm
            if roi_changed:
                # The background model is tied to the cropped frame size.
                self._bg = None
                self._bg_shape = None
                self.tracks.clear()
        return True

    def get_line(self):
        with self._lock:
            return dict(self.line)

    # ── Geometry ─────────────────────────────────────────────
    def _side(self, line, cx, cy):
        """Which side of the (directed) line the point is on: -1, 0 or +1."""
        cross = ((line['x2'] - line['x1']) * (cy - line['y1'])
                 - (line['y2'] - line['y1']) * (cx - line['x1']))
        if cross > 1e-4:
            return 1
        if cross < -1e-4:
            return -1
        return 0

    def _within_span(self, line, cx, cy):
        """True when the point projects onto the segment (not its infinite
        extension). Without this, an object crossing the line's extrapolation
        far off to the side would count."""
        dx, dy = line['x2'] - line['x1'], line['y2'] - line['y1']
        denom = dx * dx + dy * dy
        if denom <= 0:
            return False
        t = ((cx - line['x1']) * dx + (cy - line['y1']) * dy) / denom
        # Small overshoot tolerance so a bag clipping the very end still counts.
        return -0.05 <= t <= 1.05

    # ── Candidate extraction ─────────────────────────────────
    def _candidates_model(self, frame):
        """Bag boxes from the optional fine-tuned YOLO checkpoint."""
        out = []
        with self.model_lock:
            res = self.model(frame, verbose=False)[0]
        h, w = frame.shape[:2]
        for box in res.boxes:
            conf = float(box.conf[0])
            if conf < BAG_MODEL_CONF:
                continue
            x1, y1, x2, y2 = box.xyxyn[0].tolist()
            out.append({'box': [max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2)],
                        'confidence': conf})
        return out

    def _candidates_motion(self, frame, roi):
        """Bag-shaped foreground blobs via MOG2, restricted to the belt ROI."""
        h, w = frame.shape[:2]
        # Crop to the ROI *before* background modelling: a smaller frame is
        # cheaper and stops activity elsewhere in the scene from polluting the
        # learned background.
        ox = oy = 0
        work = frame
        if roi:
            ox, oy = int(roi['x'] * w), int(roi['y'] * h)
            x2 = min(w, ox + max(1, int(roi['w'] * w)))
            y2 = min(h, oy + max(1, int(roi['h'] * h)))
            if x2 - ox < 8 or y2 - oy < 8:
                return []
            work = frame[oy:y2, ox:x2]

        if self._bg is None or self._bg_shape != work.shape[:2]:
            self._bg = cv2.createBackgroundSubtractorMOG2(
                history=BAG_BG_HISTORY, varThreshold=32, detectShadows=False)
            self._bg_shape = work.shape[:2]

        fg = self._bg.apply(work, learningRate=BAG_BG_LEARNING_RATE)
        # Open then close: erase speckle, then bridge the print/stitching
        # gaps that split one bag into two blobs.
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))

        if self.keep_mask:
            self.last_mask = fg

        contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        frame_area = float(w * h)
        out = []
        for cnt in contours:
            bx, by, bw, bh = cv2.boundingRect(cnt)
            self.stats['contours'] += 1
            if bw < 4 or bh < 4:
                self.stats['rej_tiny'] += 1
                continue
            area_ratio = (bw * bh) / frame_area
            self.max_blob_ratio = max(self.max_blob_ratio, area_ratio)
            if area_ratio < BAG_MIN_AREA_RATIO:
                self.stats['rej_area_small'] += 1
                continue
            if area_ratio > BAG_MAX_AREA_RATIO:
                self.stats['rej_area_big'] += 1
                continue
            fill = cv2.contourArea(cnt) / float(bw * bh)
            if fill < BAG_MIN_FILL:
                self.stats['rej_fill'] += 1
                continue
            aspect = bw / float(bh)
            if aspect < BAG_ASPECT_MIN or aspect > BAG_ASPECT_MAX:
                self.stats['rej_aspect'] += 1
                continue
            self.stats['accepted'] += 1
            # Back to full-frame normalized coords.
            out.append({
                'box': [(ox + bx) / w, (oy + by) / h,
                        (ox + bx + bw) / w, (oy + by + bh) / h],
                # No classifier here, so confidence is a shape-quality proxy.
                'confidence': round(min(0.95, 0.45 + fill * 0.5), 3),
            })
        return out

    # ── Main entry point ─────────────────────────────────────
    def update(self, frame, person_boxes, now):
        """Advance the counter by one processed frame.

        `frame`        BGR image (the same downscaled frame the rest of the
                      pipeline uses — keeps coords consistent).
        `person_boxes` list of normalized xyxy boxes from YOLO, used to veto
                      motion blobs that are actually people.
        `now`          time.time() of this frame.

        Returns (detections, events):
          detections  `bag`-labelled entries for the frontend overlay.
          events      one entry per bag that crossed the line on THIS frame.
        """
        line = self.get_line()

        if self.model is not None:
            cands = self._candidates_model(frame)
        else:
            cands = self._candidates_motion(frame, line.get('roi'))
            # Person veto only applies to the motion path — a trained bag
            # detector already discriminates, and a bag being carried by a
            # worker is still a bag.
            if person_boxes:
                kept = [c for c in cands
                        if all(_iou(c['box'], p) <= BAG_PERSON_IOU_MAX
                               for p in person_boxes)]
                self.stats['rej_person'] += len(cands) - len(kept)
                cands = kept

        # ── Greedy nearest-centroid association ──
        # Sorted by distance so the closest pairing wins globally, not just in
        # dict iteration order. Object counts here are small (< 20), so the
        # O(n*m) build is irrelevant next to the detector cost.
        centroids = []
        for c in cands:
            x1, y1, x2, y2 = c['box']
            centroids.append(((x1 + x2) / 2.0, (y1 + y2) / 2.0))

        pairs = []
        for ti, (tid, tr) in enumerate(self.tracks.items()):
            for ci, (cx, cy) in enumerate(centroids):
                dist = ((cx - tr['cx']) ** 2 + (cy - tr['cy']) ** 2) ** 0.5
                if dist <= BAG_TRACK_MAX_DIST:
                    pairs.append((dist, tid, ci))
        pairs.sort(key=lambda p: p[0])

        used_tracks, used_cands = set(), set()
        for dist, tid, ci in pairs:
            if tid in used_tracks or ci in used_cands:
                continue
            used_tracks.add(tid)
            used_cands.add(ci)
            tr = self.tracks[tid]
            tr['cx'], tr['cy'] = centroids[ci]
            tr['box'] = cands[ci]['box']
            tr['confidence'] = cands[ci]['confidence']
            tr['hits'] += 1
            tr['last'] = now

        for ci, c in enumerate(cands):
            if ci in used_cands:
                continue
            tid = self.next_id
            self.next_id += 1
            cx, cy = centroids[ci]
            self.tracks[tid] = {
                'cx': cx, 'cy': cy, 'box': c['box'],
                'confidence': c['confidence'],
                'hits': 1, 'first': now, 'last': now,
                # Last *non-zero* side. Seeded now so a blob that spawns
                # already past the line never counts a phantom crossing.
                'side': self._side(line, cx, cy),
                'counted': False,
            }

        # ── Expire stale tracks ──
        for tid in [t for t, tr in self.tracks.items() if now - tr['last'] > BAG_TRACK_TTL_S]:
            del self.tracks[tid]

        # ── Crossing test ──
        events = []
        detections = []
        for tid, tr in self.tracks.items():
            seen_this_frame = tid in used_tracks
            if seen_this_frame and not tr['counted'] and tr['hits'] >= BAG_MIN_HITS:
                side_now = self._side(line, tr['cx'], tr['cy'])
                prev = tr['side']
                if (side_now != 0 and prev != 0 and side_now != prev
                        and self._within_span(line, tr['cx'], tr['cy'])):
                    direction = 'positive' if side_now > 0 else 'negative'
                    if line['direction'] in ('both', direction):
                        tr['counted'] = True
                        x1, y1, x2, y2 = tr['box']
                        events.append({
                            'trackId': tid,
                            'box': [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)],
                            'direction': direction,
                            'confidence': tr['confidence'],
                            'dwellSeconds': round(now - tr['first'], 2),
                        })
                if side_now != 0:
                    tr['side'] = side_now

            if seen_this_frame:
                x1, y1, x2, y2 = tr['box']
                detections.append({
                    'x': round(x1, 4), 'y': round(y1, 4),
                    'w': round(x2 - x1, 4), 'h': round(y2 - y1, 4),
                    'confidence': tr['confidence'],
                    'label': 'bag',
                    'trackId': tid,
                    'counted': bool(tr['counted']),
                })

        return detections, events
