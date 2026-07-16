import sys, os, json, time, threading, re, collections

# Force OpenCV's FFmpeg RTSP backend to use TCP and bail on dead reads/opens.
# Must be set BEFORE `import cv2` because cv2 caches it on first VideoCapture.
# stimeout/timeout are in microseconds; 5s is enough for a slow camera but
# short enough that a hung MediaMTX path recycles instead of wedging the thread.
os.environ.setdefault(
    'OPENCV_FFMPEG_CAPTURE_OPTIONS',
    'rtsp_transport;tcp|stimeout;5000000|timeout;5000000',
)

import cv2, numpy as np, mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
from ultralytics import YOLO
import torch
from facenet_pytorch import InceptionResnetV1

HERE = os.path.dirname(os.path.abspath(__file__))
ENROLLMENT_DIR = os.path.join(HERE, 'enrollments')
SNAPSHOT_DIR   = os.path.join(HERE, 'snapshots')
FACE_MODEL_PATH = os.path.join(HERE, 'blaze_face_short_range.tflite')
YOLO_MODEL_PATH = os.path.join(HERE, 'yolov8n.pt') # Standard nano model
FIRE_MODEL_PATH = os.path.join(HERE, 'fire_model.pt') # Optional custom model
# Optional Bangla license-plate detector — YOLO weights fine-tuned on BD plates.
# When missing we fall back to contour-based ROI extraction on vehicle crops.
PLATE_MODEL_PATH = os.path.join(HERE, 'plate_model.pt')

# ── Loitering ──────────────────────────────────────────────────
# A tracked person that stays in-frame longer than this is flagged as loitering.
# Increase for slow-turnover areas (bank lobbies, ATMs); decrease for corridors.
LOITERING_SECONDS = float(os.environ.get('LOITERING_SECONDS', '30'))
# How long a track can be missing before we forget its start time. Prevents a
# person who briefly walks out of frame and comes back from being "reset".
LOITERING_TRACK_TTL_S = 5.0
# Throttle repeated loitering incident envelopes for the same track.
LOITERING_INCIDENT_THROTTLE_S = 15.0

# ── License plates ────────────────────────────────────────────
# Vehicle classes YOLO's base model knows about — the plate pipeline is only
# invoked on crops that match one of these.
VEHICLE_CLASSES = {'car', 'truck', 'bus', 'motorcycle'}
# OCR is expensive; only sample this often per vehicle track.
PLATE_OCR_INTERVAL_S = 1.5
# Minimum EasyOCR confidence for a plate reading to be accepted at all.
PLATE_MIN_CONF = 0.35
# A plate string only "sticks" (published as a detection with name= set and
# persisted as an incident) after the same reading wins the per-track vote for
# this many observations. Suppresses one-off OCR hallucinations.
PLATE_CONFIRM_READS = 2

# When fire/smoke or a recognized face appears, save a JPEG of the (full-res)
# frame with boxes burned in. Throttles are PER trigger type so a steady
# stream of face recognitions can't shadow out fire/smoke snapshots.
INCIDENT_SNAPSHOT_THROTTLE_S = 1.0   # fire/smoke — rare and important, snapshot ~every second
FACE_SNAPSHOT_THROTTLE_S     = 5.0   # recognized faces — much higher volume
SNAPSHOT_JPEG_QUALITY = 82

FRAME_SKIP = 5               # Process every 5th frame to reduce CPU load

# FaceNet (vggface2) cosine-similarity threshold. Higher = stricter.
#   > 0.65 : very strict, near-identical conditions required
#   0.50   : strict — recommended default for live CCTV (cuts most look-alike confusion)
#   0.40   : moderate — accepts more pose/lighting variation, occasional false matches
#   < 0.30 : loose — most distinct people will collide
# Override via FACE_COSINE_THRESHOLD env var (no code edit needed).
COSINE_THRESHOLD          = float(os.environ.get('FACE_COSINE_THRESHOLD', '0.50'))

# Faces smaller than this fraction of the (downscaled) frame area are too noisy
# to recognize reliably. Below the cutoff we still detect the face but don't
# attempt to identify it — better an "unknown" box than a wrong name.
MIN_FACE_AREA_RATIO       = 0.005

# Temporal stability: a name only "sticks" after the recognizer agrees on it
# for this many consecutive processed frames. Suppresses single-frame mistakes.
RECOGNITION_CONFIRM_FRAMES = 2

# Same idea for the HSV fire fallback: an incident is only reported after this
# many consecutive frames of *flickering* (moving) hot-core + halo. Static
# warm objects (lighter bodies, sunsets, warm walls) can't accrue a streak.
FIRE_CONFIRM_FRAMES = 3

def log(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()

# ── Download models if needed ──────────────────────────────────
if not os.path.exists(FACE_MODEL_PATH):
    import urllib.request
    log({'type': 'info', 'message': 'Downloading face model...'})
    urllib.request.urlretrieve(
        'https://storage.googleapis.com/mediapipe-models/face_detector/'
        'blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
        FACE_MODEL_PATH)

# ── AI Models ────────────────────────────────────────────────
# MediaPipe Face Detector
face_base_options = mp_python.BaseOptions(model_asset_path=FACE_MODEL_PATH)
face_detector_options = mp_vision.FaceDetectorOptions(
    base_options=face_base_options,
    min_detection_confidence=0.5,
    min_suppression_threshold=0.3,
)
shared_face_detector = mp_vision.FaceDetector.create_from_options(face_detector_options)
face_detector_lock = threading.Lock()


# YOLOv8 for General Objects & Incidents
yolo_model = YOLO(YOLO_MODEL_PATH)
log({'type': 'info', 'message': 'YOLOv8 base model loaded'})

fire_model = None
if os.path.exists(FIRE_MODEL_PATH) and os.path.getsize(FIRE_MODEL_PATH) > 1000000:
    try:
        fire_model = YOLO(FIRE_MODEL_PATH)
        log({'type': 'info', 'message': 'Custom Fire Model loaded'})
    except Exception as e:
        log({'type': 'warning', 'message': f'Failed to load fire model: {e}'})
else:
    log({'type': 'info', 'message': 'No custom fire model found (using color-based fallback). '
                                    'Run `python face-ai/download_fire_model.py` for accurate detection.'})

yolo_lock = threading.Lock()

# ── Bangla license-plate detector + OCR ───────────────────────
# Optional YOLO weights for plates. When absent we fall back to contour ROI
# extraction inside each vehicle box (cheaper, noisier).
plate_model = None
if os.path.exists(PLATE_MODEL_PATH) and os.path.getsize(PLATE_MODEL_PATH) > 1000000:
    try:
        plate_model = YOLO(PLATE_MODEL_PATH)
        log({'type': 'info', 'message': 'Custom Plate Model loaded'})
    except Exception as e:
        log({'type': 'warning', 'message': f'Failed to load plate model: {e}'})
else:
    log({'type': 'info', 'message': 'No plate_model.pt found — using contour-based plate ROI extraction.'})
plate_model_lock = threading.Lock()

# EasyOCR is loaded lazily on first plate detection to keep startup fast and
# to make the whole plate feature optional. If the module isn't installed we
# still detect plate regions but leave `name` null.
ocr_reader = None
ocr_reader_lock = threading.Lock()
_ocr_import_failed = False

def get_ocr_reader():
    """Return a cached EasyOCR reader for Bangla + English, or None if unavailable."""
    global ocr_reader, _ocr_import_failed
    if ocr_reader is not None or _ocr_import_failed:
        return ocr_reader
    with ocr_reader_lock:
        if ocr_reader is not None or _ocr_import_failed:
            return ocr_reader
        try:
            import easyocr  # heavy — 1.5GB with weights on first run
            log({'type': 'info', 'message': 'Loading EasyOCR (bn+en) — first run downloads weights'})
            ocr_reader = easyocr.Reader(['bn', 'en'], gpu=torch.cuda.is_available())
            log({'type': 'info', 'message': 'EasyOCR ready'})
        except Exception as e:
            _ocr_import_failed = True
            log({'type': 'warning', 'message': f'EasyOCR unavailable ({e}) — plate numbers will not be read. `pip install easyocr` to enable.'})
        return ocr_reader


def find_plate_rois(vehicle_bgr):
    """Contour-based fallback: return candidate plate crops from a vehicle image.

    Filters by aspect ratio (BD plates are wider than tall, ~2:1 to 6:1) and
    a minimum absolute size to reject noise. Returns a list of (x, y, w, h)
    tuples in the vehicle-crop coordinate system, sorted by area descending.
    """
    if vehicle_bgr is None or vehicle_bgr.size == 0:
        return []
    vh, vw = vehicle_bgr.shape[:2]
    if vw < 40 or vh < 40:
        return []
    gray = cv2.cvtColor(vehicle_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, 5, 40, 40)
    edges = cv2.Canny(gray, 60, 180)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_RECT, (17, 5)))
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    min_w = max(30, vw // 10)
    min_h = max(10, vh // 20)
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w < min_w or h < min_h: continue
        ar = w / float(h)
        if ar < 1.8 or ar > 6.5: continue
        if w * h > vw * vh * 0.5: continue  # too big to be a plate
        # Bias toward the lower half of the vehicle where plates usually sit.
        if y + h < vh * 0.25: continue
        out.append((x, y, w, h))
    out.sort(key=lambda r: r[2] * r[3], reverse=True)
    return out[:3]  # top-3 candidates per vehicle


_PLATE_CLEAN_RE = re.compile(r'[^0-9A-Za-z\u0980-\u09FF\- ]+')

def clean_plate_text(text):
    """Normalize an OCR string: strip junk chars, collapse whitespace, upper-case Latin.

    Keeps Bengali code block (U+0980..U+09FF), ASCII letters/digits, hyphen, and
    spaces. Everything else is dropped so noisy borders don't get baked into
    the key used for the per-track voting buffer.
    """
    if not text: return ''
    t = _PLATE_CLEAN_RE.sub(' ', text)
    t = re.sub(r'\s+', ' ', t).strip()
    # Latin portion is conventionally upper-case on BD plates ("METRO GA").
    return ''.join(ch.upper() if ch.isascii() and ch.isalpha() else ch for ch in t)


def enhance_plate_crop(crop_bgr, target_h=128):
    """Produce a small set of preprocessed variants for OCR ensembling.

    EasyOCR on the raw crop frequently fails on plates that are small,
    dim, motion-blurred, or heavily compressed — even ones a human can
    read at a glance. The three-variant ensemble here catches most of
    them for one extra OCR call per plate candidate (still cheap given
    plate OCR is throttled to once every PLATE_OCR_INTERVAL_S per
    vehicle track).

    Variants, in the order they help most often:
      1. **Upscaled + CLAHE** — bicubic upsample so the OCR has enough
         pixels, then CLAHE on the L channel of LAB to normalize contrast
         without color distortion. Single biggest win for dim / small /
         backlit plates.
      2. **Upscaled + CLAHE + unsharp mask** — light targeted deblur on
         top of (1). Helps mildly-defocused plates; would hallucinate
         detail on completely-blurred ones, but at that point OCR is
         hopeless anyway.
      3. **Raw** — baseline. Kept because sometimes the raw crop is
         already crisp and our preprocessing introduces artifacts that
         hurt more than they help.
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return []
    h, w = crop_bgr.shape[:2]
    variants = []

    # Upsample small crops. Below ~40px tall, OCR effectively can't
    # separate glyphs; we bicubic up to target_h so the network sees
    # something worth working with. cv2.INTER_CUBIC is a solid
    # low-cost interpolation for smooth text-like structures.
    if h < target_h and h > 0:
        scale = target_h / h
        up = cv2.resize(crop_bgr, None, fx=scale, fy=scale,
                        interpolation=cv2.INTER_CUBIC)
    else:
        up = crop_bgr

    try:
        lab = cv2.cvtColor(up, cv2.COLOR_BGR2LAB)
        l_ch, a_ch, b_ch = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(4, 4))
        l_ch = clahe.apply(l_ch)
        contrast = cv2.cvtColor(cv2.merge([l_ch, a_ch, b_ch]), cv2.COLOR_LAB2BGR)
        variants.append(contrast)
        # Unsharp mask: subtract a blurred copy from the original weighted
        # 1.5×, back off by 0.5× — a well-behaved deblur that preserves
        # edges without ringing at low sigma.
        gauss = cv2.GaussianBlur(contrast, (0, 0), sigmaX=1.5)
        sharpened = cv2.addWeighted(contrast, 1.5, gauss, -0.5, 0)
        variants.append(sharpened)
    except Exception:
        # If colour-space conversion fails on a degenerate crop, we still
        # want to try the raw as a last resort.
        pass

    variants.append(crop_bgr)  # baseline
    return variants


def _ocr_plate_variant(reader, variant_bgr):
    """Run EasyOCR on one preprocessed variant and return (text, avg_conf).

    Empty text / zero confidence if no line clears PLATE_MIN_CONF. For
    two-line Bangla plates we pick the top-2 confidence hits then order
    them top-to-bottom by y before joining — this preserves the
    "district-metro / registration" layout that BD plates use.
    """
    try:
        results = reader.readtext(variant_bgr, detail=1, paragraph=False)
    except Exception as ex:
        log({'type': 'warning', 'message': f'OCR failed: {ex}'})
        return '', 0.0
    if not results:
        return '', 0.0
    results.sort(key=lambda r: r[2] if len(r) > 2 else 0, reverse=True)
    top = [r for r in results if len(r) > 2 and r[2] >= PLATE_MIN_CONF][:2]
    if not top:
        return '', 0.0
    top.sort(key=lambda r: min(pt[1] for pt in r[0]))
    text = clean_plate_text(' '.join(r[1] for r in top))
    conf = float(sum(r[2] for r in top) / len(top))
    return text, conf


def detect_plates_in_vehicle(vehicle_bgr):
    """Return a list of {box:(x,y,w,h), text:str, conf:float} for a vehicle crop.

    Uses `plate_model` when present; otherwise falls back to contour ROIs.
    Each candidate crop is passed through `enhance_plate_crop` and OCR'd
    on every variant — the highest-confidence read wins. `text` may be
    '' if none of the variants cleared PLATE_MIN_CONF.
    """
    if vehicle_bgr is None or vehicle_bgr.size == 0:
        return []
    vh, vw = vehicle_bgr.shape[:2]
    candidates = []  # list of (x, y, w, h)

    if plate_model is not None:
        try:
            with plate_model_lock:
                res = plate_model(vehicle_bgr, verbose=False)[0]
            for box in res.boxes:
                conf = float(box.conf[0])
                # 0.20 (was 0.35) — small / distant / angled plates score
                # naturally lower. The downstream OCR filters false positives
                # by refusing to publish text below PLATE_MIN_CONF, so a
                # permissive detector doesn't leak garbage into the summary.
                if conf < 0.20: continue
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                x1 = max(0, x1); y1 = max(0, y1)
                x2 = min(vw, x2); y2 = min(vh, y2)
                if x2 - x1 > 10 and y2 - y1 > 5:
                    candidates.append((x1, y1, x2 - x1, y2 - y1))
        except Exception as ex:
            log({'type': 'warning', 'message': f'Plate model inference failed: {ex}'})

    if not candidates:
        candidates = find_plate_rois(vehicle_bgr)

    reader = get_ocr_reader()
    out = []
    for (x, y, w, h) in candidates:
        crop = vehicle_bgr[y:y+h, x:x+w]
        best_text, best_conf = '', 0.0
        if reader is not None and crop.size > 0:
            # Ensemble: try each preprocessing variant, keep the highest-
            # confidence non-empty result. Empirically the CLAHE variant
            # wins ~60% of the time on the test clips, sharpen ~25%, raw
            # ~15% — but which one wins for a given plate is unpredictable
            # so we run them all.
            for variant in enhance_plate_crop(crop):
                text, conf = _ocr_plate_variant(reader, variant)
                if text and conf > best_conf:
                    best_text, best_conf = text, conf
        out.append({'box': (x, y, w, h), 'text': best_text, 'conf': best_conf})
    return out

# ── FaceNet (vggface2) embedder ─────────────────────────────────
# 27M-param InceptionResnetV1 from facenet-pytorch. Outputs L2-normalized
# 512-d embeddings; cosine similarity = dot product.
# First import downloads ~107MB into ~/.cache/torch/checkpoints/.
_torch_device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
log({'type': 'info', 'message': f'Loading FaceNet (vggface2) on {_torch_device}'})
_face_net = InceptionResnetV1(pretrained='vggface2').eval().to(_torch_device)
_face_net_lock = threading.Lock()

def embed_face(crop_bgr):
    """Return an L2-normalized 512-d FaceNet embedding for a BGR face crop."""
    if crop_bgr is None or crop_bgr.size == 0:
        return None
    rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    rgb = cv2.resize(rgb, (160, 160), interpolation=cv2.INTER_AREA)
    t = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).float()
    t = (t - 127.5) / 128.0  # facenet-pytorch normalization
    with _face_net_lock, torch.no_grad():
        emb = _face_net(t.to(_torch_device))
    return emb.cpu().numpy().flatten()


# ── Snapshot writer (triggered on incidents / recognized faces) ─
def save_snapshot(stream_id, frame, detections, incidents):
    """Burn detection boxes onto the full-res frame and write JPEG.

    Returns a relative path (`<streamId>/<ts>.jpg`) that the backend stores
    in `incidents.snapshot_path` and serves via /snapshot/:streamId/:file.
    """
    if frame is None or frame.size == 0:
        return None
    h, w = frame.shape[:2]
    img = frame.copy()

    # Recognized faces / persons / vehicles / plates / loitering.
    for d in (detections or []):
        x1 = int(max(0, d['x']) * w)
        y1 = int(max(0, d['y']) * h)
        x2 = int(min(1, d['x'] + d['w']) * w)
        y2 = int(min(1, d['y'] + d['h']) * h)
        lab = d.get('label')
        if d.get('loitering'):
            color = (0, 165, 255)   # orange-red — loitering warning
            label = f"LOITERING {d.get('dwellSeconds', '')}s"
        elif lab == 'plate':
            color = (255, 200, 0)   # cyan-ish for plates
            label = d.get('name') or 'plate'
        elif lab == 'vehicle':
            color = (200, 200, 200)
            label = d.get('vehicleType') or 'vehicle'
        elif d.get('name'):
            color = (16, 185, 129)  # emerald BGR-ish
            label = d['name']
        elif lab == 'person':
            color = (11, 158, 245)  # amber
            label = 'person'
        else:
            color = (246, 130, 59)  # face
            label = 'face'
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        cv2.putText(img, label, (x1, max(15, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2, cv2.LINE_AA)

    # Incident boxes (fire/smoke/loitering/plate) — corners format.
    incident_colors = {
        'fire':      (68, 68, 239),
        'smoke':     (68, 68, 239),
        'loitering': (0, 165, 255),
        'plate':     (255, 200, 0),
    }
    for inc in (incidents or []):
        bx = inc.get('box') or []
        if len(bx) < 4: continue
        x1 = int(max(0, bx[0]) * w); y1 = int(max(0, bx[1]) * h)
        x2 = int(min(1, bx[2]) * w); y2 = int(min(1, bx[3]) * h)
        color = incident_colors.get(inc.get('type'), (68, 68, 239))
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 3)
        tag = str(inc.get('type', 'alert')).upper()
        if inc.get('plate'): tag = f"PLATE {inc['plate']}"
        elif inc.get('type') == 'loitering' and inc.get('dwellSeconds'):
            tag = f"LOITERING {inc['dwellSeconds']}s"
        cv2.putText(img, tag, (x1, max(20, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.85, color, 2, cv2.LINE_AA)

    stream_dir = os.path.join(SNAPSHOT_DIR, stream_id)
    try: os.makedirs(stream_dir, exist_ok=True)
    except OSError: return None

    ts_ms = int(time.time() * 1000)
    fname = f'{ts_ms}.jpg'
    abs_path = os.path.join(stream_dir, fname)
    try:
        cv2.imwrite(abs_path, img, [cv2.IMWRITE_JPEG_QUALITY, SNAPSHOT_JPEG_QUALITY])
    except Exception as ex:
        log({'type': 'warning', 'message': f'snapshot write failed: {ex}'})
        return None
    return f'{stream_id}/{fname}'


# ── Per-directory recognizers ───────────────────────────────────
# Each user has their own enrollment dir → their own centroid table.
# Keyed by absolute dir path; entries are created lazily.
class DirRecognizer:
    __slots__ = ('centroids', 'ready', 'lock')
    def __init__(self):
        self.centroids = {}    # name -> np.ndarray(512,) L2-normalized
        self.ready = False
        self.lock = threading.Lock()

dir_recognizers = {}                 # dir_path -> DirRecognizer
dir_recognizers_lock = threading.Lock()

def get_recognizer(dir_path):
    with dir_recognizers_lock:
        rec = dir_recognizers.get(dir_path)
        if rec is None:
            rec = DirRecognizer()
            dir_recognizers[dir_path] = rec
        return rec


def train_recognizer(dir_path):
    """Compute one mean embedding per enrolled name from images on disk."""
    if not dir_path or not os.path.isdir(dir_path):
        return
    rec = get_recognizer(dir_path)
    name_to_embs = {}  # display name -> [embedding, ...]

    for fname in sorted(os.listdir(dir_path)):
        if not fname.lower().endswith(('.jpg', '.jpeg', '.png')):
            continue
        p = os.path.join(dir_path, fname)
        img_bgr = cv2.imread(p)
        if img_bgr is None: continue
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        with face_detector_lock:
            result = shared_face_detector.detect(mp_img)
        if not result.detections:
            log({'type': 'warning', 'message': f'No face in enrollment: {fname}'})
            continue
        bb = result.detections[0].bounding_box
        ih, iw = img_bgr.shape[:2]
        x = max(0, bb.origin_x); y = max(0, bb.origin_y)
        cw = min(bb.width, iw - x); ch = min(bb.height, ih - y)
        emb = embed_face(img_bgr[y:y+ch, x:x+cw])
        if emb is None: continue
        stem = os.path.splitext(fname)[0]
        base = re.sub(r'_\d+$', '', stem).replace('_', ' ')
        name_to_embs.setdefault(base, []).append(emb)

    centroids = {}
    for name, embs in name_to_embs.items():
        c = np.mean(np.stack(embs), axis=0)
        n = np.linalg.norm(c) + 1e-9
        centroids[name] = (c / n).astype(np.float32)

    with rec.lock:
        rec.centroids = centroids
        rec.ready = bool(centroids)
    log({'type': 'info', 'message': f'Trained {len(centroids)} identities from {dir_path}'})


# ── Per-stream thread ─────────────────────────────────────────
active_streams = {}

# Detection target rate (frames *processed* per second). The capture thread
# always reads at the camera's full rate; this just throttles the AI step.
TARGET_FPS = 8

class LatestFrameReader:
    """Always-fresh frame source.

    A dedicated capture thread reads the RTSP stream at native frame rate and
    overwrites a single-slot buffer. The processing thread takes whatever's
    in the slot — old frames are dropped, so latency cannot accumulate even
    when AI processing is slower than the incoming frame rate.

    This is *the* fix for the "boxes 3-5s behind reality" problem: with
    OpenCV's default behavior, a slow consumer queues frames inside FFmpeg's
    decoder, and you end up processing frames from seconds ago.
    """
    __slots__ = ('rtsp_url', 'lock', '_frame', '_frame_id', 'last_frame_at',
                 'stop_event', 'thread')

    def __init__(self, rtsp_url):
        self.rtsp_url = rtsp_url
        self.lock = threading.Lock()
        self._frame = None
        self._frame_id = 0
        self.last_frame_at = 0
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        cap = None
        while not self.stop_event.is_set():
            if cap is None or not cap.isOpened():
                if cap: cap.release()
                cap = cv2.VideoCapture(self.rtsp_url)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                if not cap.isOpened():
                    time.sleep(2); continue

            ret, frame = cap.read()
            if not ret:
                cap.release(); cap = None; time.sleep(1); continue

            with self.lock:
                self._frame = frame
                self._frame_id += 1
                self.last_frame_at = time.time()

        if cap: cap.release()

    def take(self, last_seen_id):
        """Return (frame, id) iff a new frame has arrived since last_seen_id."""
        with self.lock:
            if self._frame_id <= last_seen_id:
                return None, last_seen_id
            return self._frame, self._frame_id

    def stale(self, threshold_s=10):
        with self.lock:
            return self.last_frame_at and (time.time() - self.last_frame_at) > threshold_s

    def stop(self):
        self.stop_event.set()


def stream_worker(stream_id, rtsp_url, enrollment_dir):
    stop_event = active_streams[stream_id]['stop']
    log({'type': 'info', 'message': f'Stream worker started: {stream_id} (enroll dir: {enrollment_dir})'})
    enrolled_mtime = 0
    last_seen_id = 0
    last_processed_at = 0
    last_incident_snap_at = 0   # fire/smoke
    last_face_snap_at     = 0   # recognized faces
    period = 1.0 / TARGET_FPS

    # For incident heuristics (e.g. fight)
    person_history = collections.deque(maxlen=10) # Track person counts/locations

    # Temporal stability for face recognition. See COSINE_THRESHOLD docs above.
    name_streaks = {}  # bucket -> {'name': str, 'count': int}

    # HSV fire-fallback temporal state (only used when fire_model.pt is missing).
    fire_prev_sig = None  # (cx, cy, area) of last frame's best flame candidate
    fire_streak   = 0     # consecutive frames the candidate has flickered/moved

    # ── Loitering state: track_id -> first-seen / last-seen / last-alert ──
    # ByteTrack IDs are stable within one continuous track. `first_seen` is
    # frozen; `last_seen` advances every frame the track is visible; a track
    # that disappears for LOITERING_TRACK_TTL_S is forgotten so the next
    # reappearance starts a fresh timer.
    loitering_state = {}   # track_id -> {'first': ts, 'last': ts, 'alerted_at': ts, 'box': (x,y,w,h)}

    # ── Plate state: vehicle_track_id -> {'last_ocr_at': ts, 'votes': {str: int}, 'plate': str|None, 'reads': int} ──
    # We only run OCR every PLATE_OCR_INTERVAL_S per track, then vote the
    # dominant cleaned string over PLATE_CONFIRM_READS observations before
    # publishing it. Same TTL-cleanup pattern as loitering.
    plate_state = {}
    plate_reported_at = {}  # cleaned_plate_string -> last-emitted timestamp (throttling)

    reader = LatestFrameReader(rtsp_url)
    try:
        while not stop_event.is_set():
            now = time.time()

            # Throttle to TARGET_FPS so AI processing doesn't peg the CPU.
            if now - last_processed_at < period:
                time.sleep(0.005)
                continue

            # Recycle the underlying capture if frames stop flowing.
            if reader.stale(10):
                log({'type': 'warning', 'message': f'No frames for 10s on {stream_id}, reopening capture'})
                reader.stop()
                reader = LatestFrameReader(rtsp_url)
                last_seen_id = 0
                continue

            frame, last_seen_id = reader.take(last_seen_id)
            if frame is None:
                time.sleep(0.01)
                continue
            last_processed_at = now

            # Downscale for performance (significant CPU saving)
            small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
            h, w = small_frame.shape[:2]
            rgb = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

            # Auto-retrain when this user's enrollment dir changes
            if enrollment_dir and os.path.isdir(enrollment_dir):
                try:
                    mtime = os.path.getmtime(enrollment_dir)
                    if mtime != enrolled_mtime:
                        enrolled_mtime = mtime
                        train_recognizer(enrollment_dir)
                except: pass

            rec = get_recognizer(enrollment_dir) if enrollment_dir else None

            # 1. Face Detection & Recognition
            detections = []
            try:
                with face_detector_lock:
                    result = shared_face_detector.detect(mp_img)
                if result.detections:
                    seen_buckets = set()
                    for d in result.detections:
                        bb = d.bounding_box
                        name = None

                        # Tiny faces: low-resolution crops produce noisy embeddings
                        # — render the box but don't attempt to identify.
                        face_area_ratio = (bb.width * bb.height) / float(w * h)

                        if rec is not None and face_area_ratio >= MIN_FACE_AREA_RATIO:
                            # Read centroids under the per-recognizer lock, then
                            # release before running FaceNet (which holds its own
                            # lock); this avoids serializing all streams on a stale
                            # snapshot if a re-train is in flight.
                            with rec.lock:
                                ready = rec.ready
                                centroids = rec.centroids if ready else None
                            if ready and centroids:
                                x = max(0, bb.origin_x); y = max(0, bb.origin_y)
                                fw = min(bb.width, w - x); fh = min(bb.height, h - y)
                                crop = small_frame[y:y+fh, x:x+fw]
                                emb = embed_face(crop)
                                if emb is not None:
                                    # L2-normalized embeddings → cosine sim = dot product.
                                    best_name, best_score = None, -1.0
                                    for n, c in centroids.items():
                                        s = float(np.dot(emb, c))
                                        if s > best_score:
                                            best_score, best_name = s, n
                                    if best_score >= COSINE_THRESHOLD:
                                        candidate = best_name
                                        cx = (bb.origin_x + bb.width / 2) / w
                                        cy = (bb.origin_y + bb.height / 2) / h
                                        bucket = (round(cx * 10), round(cy * 10))
                                        seen_buckets.add(bucket)
                                        streak = name_streaks.get(bucket)
                                        if streak and streak['name'] == candidate:
                                            streak['count'] += 1
                                        else:
                                            name_streaks[bucket] = {'name': candidate, 'count': 1}
                                            streak = name_streaks[bucket]
                                        if streak['count'] >= RECOGNITION_CONFIRM_FRAMES:
                                            name = candidate
                        detections.append({
                            'x': bb.origin_x / w, 'y': bb.origin_y / h,
                            'w': bb.width / w,    'h': bb.height / h,
                            'confidence': float(d.categories[0].score if d.categories else 0),
                            'label': 'face', 'name': name,
                        })

                    # Drop streak slots that nobody held this frame so we don't
                    # keep a stale name alive after a person leaves the scene.
                    for bucket in list(name_streaks.keys()):
                        if bucket not in seen_buckets:
                            del name_streaks[bucket]
            except Exception as ex:
                log({'type': 'warning', 'message': f'Face detect error: {ex}'})

            # 2. YOLO Incident Detection (General Objects + Heuristics)
            incidents = []
            try:
                with yolo_lock:
                    # `track` (ByteTrack) with `persist=True` keeps track IDs stable
                    # across frames — required for loitering dwell timers and
                    # per-vehicle plate OCR voting. Falls back to detections
                    # without IDs on tracker init glitches.
                    try:
                        yolo_results = yolo_model.track(small_frame, persist=True,
                                                       tracker='bytetrack.yaml',
                                                       verbose=False)[0]
                    except Exception:
                        yolo_results = yolo_model(small_frame, verbose=False)[0]

                    people = []
                    vehicles = []  # (track_id, x1_px, y1_px, x2_px, y2_px, label) on small_frame coords
                    for box in yolo_results.boxes:
                        cls_id = int(box.cls[0])
                        conf = float(box.conf[0])
                        if conf < 0.6: continue # Increased from 0.3 to reduce false persons

                        label = yolo_model.names[cls_id]
                        bx = box.xyxyn[0].tolist() # [x1, y1, x2, y2]
                        # ByteTrack IDs are attached to `.id` when tracking succeeds.
                        track_id = None
                        if getattr(box, 'id', None) is not None:
                            try: track_id = int(box.id.item() if hasattr(box.id, 'item') else box.id[0])
                            except Exception: track_id = None

                        if label == 'person':
                            # Ignore very small boxes that are likely false positives (hands, etc.)
                            bw = bx[2] - bx[0]
                            bh = bx[3] - bx[1]
                            if bw * bh < 0.05: continue

                            people.append(bx)
                            det = {
                                'x': bx[0], 'y': bx[1], 'w': bw, 'h': bh,
                                'confidence': conf, 'label': 'person',
                            }
                            if track_id is not None:
                                det['trackId'] = track_id
                            detections.append(det)

                            # Loitering: only meaningful when we have a stable ID.
                            if track_id is not None:
                                st = loitering_state.get(track_id)
                                if st is None:
                                    loitering_state[track_id] = {
                                        'first': now, 'last': now,
                                        'alerted_at': 0.0,
                                        'box': (bx[0], bx[1], bw, bh),
                                    }
                                else:
                                    st['last'] = now
                                    st['box'] = (bx[0], bx[1], bw, bh)

                        elif label in VEHICLE_CLASSES:
                            bw = bx[2] - bx[0]
                            bh = bx[3] - bx[1]
                            if bw * bh < 0.01: continue  # tiny vehicles = OCR noise
                            detections.append({
                                'x': bx[0], 'y': bx[1], 'w': bw, 'h': bh,
                                'confidence': conf, 'label': 'vehicle', 'vehicleType': label,
                                **({'trackId': track_id} if track_id is not None else {}),
                            })
                            # Convert normalized coords back to small_frame pixels for cropping.
                            x1_px = int(max(0, bx[0]) * w); y1_px = int(max(0, bx[1]) * h)
                            x2_px = int(min(1, bx[2]) * w); y2_px = int(min(1, bx[3]) * h)
                            vehicles.append((track_id, x1_px, y1_px, x2_px, y2_px, label))

                        elif label in ['fire', 'smoke']: # In case custom model is used or standard detects them
                            incidents.append({'type': 'fire', 'confidence': conf, 'box': bx})

                    # If we have a dedicated fire model, run it
                    if fire_model:
                        f_results = fire_model(frame, verbose=False)[0]
                        for box in f_results.boxes:
                            if float(box.conf[0]) > 0.4:
                                bx = box.xyxyn[0].tolist()
                                incidents.append({'type': 'fire', 'confidence': float(box.conf[0]), 'box': bx})
                    else:
                        # Fallback when no real fire model is installed.
                        # The naive "find orange contour" approach fires constantly on
                        # lighter bodies, sunsets, brake lights, and warm walls. We
                        # require three things to call something a flame:
                        #   1. A near-white hot core (V>=240, sat-yellow band) — real
                        #      flames are blackbody radiators; the hottest pixels
                        #      saturate the sensor to white/yellow. Steady-state warm
                        #      objects (plastic, walls) cannot.
                        #   2. An orange/red halo immediately surrounding that core —
                        #      separates flames from white LEDs, sun glints, and
                        #      specular highlights that also have a near-white core.
                        #   3. Flicker across consecutive frames — flames move; lighter
                        #      bodies don't. A *static* hot+halo blob decays the streak
                        #      instead of growing it, so a flame-coloured object can
                        #      sit in frame forever without ever firing.
                        # Only the highest-scoring candidate per frame is considered,
                        # and only after FIRE_CONFIRM_FRAMES of consistent flicker.
                        hsv = cv2.cvtColor(small_frame, cv2.COLOR_BGR2HSV)
                        core_mask = cv2.inRange(hsv,
                                                np.array([0,   80, 240], dtype="uint8"),
                                                np.array([35, 255, 255], dtype="uint8"))
                        halo_mask = cv2.inRange(hsv,
                                                np.array([0,  150, 180], dtype="uint8"),
                                                np.array([20, 255, 255], dtype="uint8"))

                        candidate = None  # (score, x, y, bw, bh)
                        if cv2.countNonZero(core_mask) >= 5:
                            core_clean = cv2.dilate(core_mask, None, iterations=1)
                            cnts, _ = cv2.findContours(core_clean, cv2.RETR_EXTERNAL,
                                                      cv2.CHAIN_APPROX_SIMPLE)
                            for cnt in cnts:
                                area = cv2.contourArea(cnt)
                                if area < 25: continue
                                cx_, cy_, cw_, ch_ = cv2.boundingRect(cnt)
                                ar = ch_ / max(1, cw_)
                                if ar < 0.4 or ar > 4.0:  # not flame-shaped
                                    continue
                                # Expand the core box outward to include the halo.
                                pad = max(cw_, ch_)
                                bx_x  = max(0, cx_ - pad)
                                bx_y  = max(0, cy_ - pad)
                                bx_x2 = min(w, cx_ + cw_ + pad)
                                bx_y2 = min(h, cy_ + ch_ + pad)
                                halo_roi = halo_mask[bx_y:bx_y2, bx_x:bx_x2]
                                halo_ratio = (cv2.countNonZero(halo_roi) /
                                              float(max(1, halo_roi.size)))
                                if halo_ratio < 0.05:  # core without halo = LED/glint
                                    continue
                                score = area * halo_ratio
                                if candidate is None or score > candidate[0]:
                                    candidate = (score, bx_x, bx_y,
                                                 bx_x2 - bx_x, bx_y2 - bx_y)

                        if candidate is not None:
                            _, bx_x, bx_y, bx_w, bx_h = candidate
                            sig = (bx_x + bx_w / 2.0,
                                   bx_y + bx_h / 2.0,
                                   bx_w * bx_h)
                            if fire_prev_sig is not None:
                                dx = abs(sig[0] - fire_prev_sig[0])
                                dy = abs(sig[1] - fire_prev_sig[1])
                                d_area = (abs(sig[2] - fire_prev_sig[2]) /
                                          max(1.0, fire_prev_sig[2]))
                                if (dx + dy) > 1.5 or d_area > 0.15:
                                    fire_streak += 1
                                else:
                                    fire_streak = max(0, fire_streak - 1)
                            fire_prev_sig = sig
                            if fire_streak >= FIRE_CONFIRM_FRAMES:
                                incidents.append({
                                    'type': 'fire',
                                    'confidence': min(0.85, 0.5 + candidate[0] / 50000.0),
                                    'box': [bx_x / w, bx_y / h,
                                            (bx_x + bx_w) / w,
                                            (bx_y + bx_h) / h],
                                })
                        else:
                            fire_streak = max(0, fire_streak - 1)
                            fire_prev_sig = None

            except Exception as ex:
                log({'type': 'warning', 'message': f'YOLO error: {ex}'})

            # 3. Loitering resolution — for every tracked person, check dwell
            # time and emit both a `loitering` label on the detection (so the
            # frontend can color-code) and an `incidents` envelope entry (so
            # the backend persists it) when the threshold is crossed.
            try:
                for tid, st in list(loitering_state.items()):
                    if now - st['last'] > LOITERING_TRACK_TTL_S:
                        del loitering_state[tid]
                        continue
                    dwell = now - st['first']
                    if dwell < LOITERING_SECONDS:
                        continue
                    # Tag any person detection with the same trackId as "loitering"
                    # so the frontend can draw it in the loitering color.
                    for d in detections:
                        if d.get('label') == 'person' and d.get('trackId') == tid:
                            d['loitering'] = True
                            d['dwellSeconds'] = round(dwell, 1)
                    # Throttled incident envelope: one entry per track per window.
                    if now - st['alerted_at'] >= LOITERING_INCIDENT_THROTTLE_S:
                        st['alerted_at'] = now
                        x0, y0, bw0, bh0 = st['box']
                        incidents.append({
                            'type': 'loitering',
                            'confidence': min(1.0, dwell / (LOITERING_SECONDS * 2)),
                            'box': [x0, y0, x0 + bw0, y0 + bh0],
                            'trackId': tid,
                            'dwellSeconds': round(dwell, 1),
                        })
            except Exception as ex:
                log({'type': 'warning', 'message': f'Loitering resolution failed: {ex}'})

            # 4. License plate detection + OCR — sampled per vehicle track.
            # A vehicle without a stable trackId can't be voted across frames,
            # so we only OCR tracked vehicles. OCR is throttled per track and
            # a plate string only sticks after PLATE_CONFIRM_READS agreements.
            try:
                # Age out plate state for vehicles that have vanished.
                for tid in list(plate_state.keys()):
                    if now - plate_state[tid].get('last_ocr_at', 0) > 10.0:
                        del plate_state[tid]

                for (tid, x1_px, y1_px, x2_px, y2_px, veh_label) in vehicles:
                    if tid is None: continue
                    ps = plate_state.setdefault(tid, {
                        'last_ocr_at': 0.0, 'votes': {}, 'plate': None, 'reads': 0,
                    })
                    if now - ps['last_ocr_at'] < PLATE_OCR_INTERVAL_S:
                        # No OCR this tick — but if we already confirmed a plate
                        # for this track, keep publishing it so the frontend
                        # renders the label continuously while the car is in view.
                        if ps['plate']:
                            detections.append({
                                'x': x1_px / w, 'y': y1_px / h,
                                'w': (x2_px - x1_px) / w, 'h': (y2_px - y1_px) / h,
                                'confidence': 0.9, 'label': 'plate',
                                'name': ps['plate'], 'trackId': tid,
                            })
                        continue
                    ps['last_ocr_at'] = now
                    crop = small_frame[y1_px:y2_px, x1_px:x2_px]
                    plates = detect_plates_in_vehicle(crop)
                    if not plates: continue
                    # Best candidate per vehicle: highest OCR confidence with a
                    # non-empty cleaned string. If none has text (OCR down), we
                    # still emit a `plate` detection so the box is visible.
                    plates.sort(key=lambda p: p['conf'], reverse=True)
                    best = plates[0]
                    px, py, pw, ph = best['box']
                    # Convert plate coords from vehicle-crop-space back to full-frame normalized.
                    plate_abs_x = (x1_px + px) / w
                    plate_abs_y = (y1_px + py) / h
                    plate_abs_w = pw / w
                    plate_abs_h = ph / h

                    text = best['text']
                    published_name = ps['plate']  # what we've already confirmed
                    if text:
                        ps['votes'][text] = ps['votes'].get(text, 0) + 1
                        ps['reads'] += 1
                        # Winner = most-voted string so far.
                        winner = max(ps['votes'].items(), key=lambda kv: kv[1])
                        if winner[1] >= PLATE_CONFIRM_READS and winner[0] != ps['plate']:
                            ps['plate'] = winner[0]
                            published_name = winner[0]
                            # Emit an `incidents` envelope for persistence, throttled
                            # per plate string so a car sitting in view doesn't spam.
                            last_report = plate_reported_at.get(winner[0], 0)
                            if now - last_report >= 30.0:
                                plate_reported_at[winner[0]] = now
                                incidents.append({
                                    'type': 'plate',
                                    'confidence': best['conf'],
                                    'box': [plate_abs_x, plate_abs_y,
                                            plate_abs_x + plate_abs_w,
                                            plate_abs_y + plate_abs_h],
                                    'plate': winner[0],
                                    'trackId': tid,
                                    'vehicleType': veh_label,
                                })

                    detections.append({
                        'x': plate_abs_x, 'y': plate_abs_y,
                        'w': plate_abs_w, 'h': plate_abs_h,
                        'confidence': best['conf'] or 0.5,
                        'label': 'plate',
                        'name': published_name,
                        'trackId': tid,
                    })
            except Exception as ex:
                log({'type': 'warning', 'message': f'Plate pipeline failed: {ex}'})

            # Snapshot decision — fire/smoke take priority and have their own,
            # tighter throttle; recognized faces are higher volume so the
            # throttle there is more generous. If both happen in the same
            # frame, the resulting snapshot satisfies both (boxes are drawn
            # for everything in the frame).
            snapshot_path = None
            # `incidents` now covers fire/smoke/loitering/plate — all rate-limited
            # via the tighter INCIDENT throttle. A recognized face without any
            # incident still uses the more generous FACE throttle.
            has_incident = bool(incidents)
            has_named_face = any(d.get('label') == 'face' and d.get('name') for d in detections)
            now_t = time.time()
            incident_due = has_incident   and (now_t - last_incident_snap_at) >= INCIDENT_SNAPSHOT_THROTTLE_S
            face_due     = has_named_face and (now_t - last_face_snap_at)     >= FACE_SNAPSHOT_THROTTLE_S
            if incident_due or face_due:
                snapshot_path = save_snapshot(stream_id, frame, detections, incidents)
                if snapshot_path:
                    if has_incident:   last_incident_snap_at = now_t
                    if has_named_face: last_face_snap_at     = now_t

            log({
                'type': 'detections',
                'streamId': stream_id,
                'detections': detections,
                'incidents': incidents,
                'snapshot': snapshot_path,
            })
    finally:
        reader.stop()
        log({'type': 'info', 'message': f'Stream worker stopped: {stream_id}'})


def main():
    log({'type': 'ready', 'message': 'Multi-stream worker ready (per-user recognizers)'})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw: continue
        try:
            cmd = json.loads(raw)
        except: continue

        action = cmd.get('cmd')
        if action == 'add':
            sid = cmd['streamId']
            url = cmd['rtspUrl']
            # Falls back to the legacy single-tenant root for older callers.
            enroll_dir = cmd.get('enrollmentDir') or ENROLLMENT_DIR
            if sid not in active_streams:
                stop_ev = threading.Event()
                active_streams[sid] = {'stop': stop_ev}
                t = threading.Thread(target=stream_worker, args=(sid, url, enroll_dir), daemon=True)
                t.start()
                active_streams[sid]['thread'] = t
        elif action == 'remove':
            sid = cmd.get('streamId')
            if sid in active_streams:
                active_streams[sid]['stop'].set()
                del active_streams[sid]
        elif action == 'quit':
            for info in active_streams.values(): info['stop'].set()
            break

if __name__ == '__main__':
    main()
