"""
3·4회차 작업실 로컬 서버 — xr_sound_studio.html의 '작업실' 탭이 접속한다.
  - 영상 정보(실제 fps, 프레임 수) 읽기: ffprobe
  - SAM 2 대상 추적 (추적 해상도·추적 간격, 양방향 추적, 다시 선택한 프레임부터 이어 추적)
  - 영상에 4채널 소리 얹기(mp4), 내보내기 폴더와 zip 만들기: ffmpeg

Windows: start_sam2_server.bat을 더블클릭한다 (처음 한 번 설치까지 자동).
macOS: 설치와 실행 명령은 README.md에 있다.
  python sam2_server.py                 # 가장 작은 tiny 모델. 첫 실행 때 checkpoints/에 자동 다운로드
  python sam2_server.py --model small   # GPU가 있으면 더 정확한 모델
"""
import argparse
import base64
import contextlib
import io
import json
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.request
import uuid
import zipfile
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
import torch
from PIL import Image
import sam2.sam2_video_predictor as sam2_video_predictor
from sam2.build_sam import build_sam2_video_predictor
from sam2.utils.misc import _load_img_as_tensor

HERE = Path(__file__).resolve().parent
DATA = HERE / "sam2_tracker_data"
EXPORTS = HERE / "exports"
MODELS = {"tiny": "t", "small": "s", "base_plus": "b+", "large": "l"}
CKPT_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_{}.pt"


class LazyFrames:
    """프레임을 필요할 때 한 장씩 읽는다.
    SAM 2 기본 로더는 전 프레임을 1024x1024 float32로 미리 올려 프레임당 약 12MB(900프레임이면 11GB)를 쓴다."""

    def __init__(self, paths, image_size):
        self.paths, self.size = paths, image_size
        self.mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
        self.std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        img, _, _ = _load_img_as_tensor(self.paths[i], self.size)
        return (img.float() - self.mean) / self.std


def jpg_frames(folder):
    # macOS가 exFAT 드라이브에 만드는 '._000000.jpg' 같은 숨김 파일은 뺀다
    return sorted(p for p in Path(folder).glob("*.jpg") if not p.name.startswith("."))


def lazy_load_video_frames(video_path, image_size, **_):
    paths = jpg_frames(video_path)
    with Image.open(paths[0]) as first:  # 파일을 바로 닫아야 Windows에서 세션 폴더를 지울 수 있다
        width, height = first.size
    return LazyFrames(paths, image_size), height, width


# ponytail: init_state가 부르는 프레임 로더만 바꿔 끼운다. sam2 버전이 바뀌어 이름이 달라지면 여기만 고치면 된다.
sam2_video_predictor.load_video_frames = lazy_load_video_frames

predictor = None
DEVICE = "cpu"
MODEL_NAME = ""
MODEL_LOCK = threading.Lock()  # ponytail: 모델 하나를 전역 락으로 공유. 여러 명이 동시에 쓰면 세션별 모델로 바꾼다
SESSIONS = {}


class ApiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Binary:
    def __init__(self, data, content_type="application/octet-stream"):
        self.data, self.content_type = data, content_type


def amp():
    # bfloat16은 RTX 30 시리즈 이후 GPU만 빠르다. 그보다 오래된 GPU와 CPU는 float32 그대로
    if DEVICE == "cuda" and torch.cuda.is_bf16_supported():
        return torch.autocast("cuda", dtype=torch.bfloat16)
    return contextlib.nullcontext()


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise ApiError(500, f"{cmd[0]} 실패: {result.stderr.strip()[-400:]}")
    return result.stdout


def probe(path):
    info = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
                           "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_read_packets:format=duration",
                           "-of", "json", str(path)]))
    stream = info["streams"][0]
    rate = stream.get("avg_frame_rate") or "0/1"
    if rate in ("0/0", "0/1"):
        rate = stream["r_frame_rate"]
    fps = float(Fraction(rate))
    duration = float(info["format"].get("duration") or 0)
    frames = int(stream.get("nb_read_packets") or round(duration * fps))
    return {"width": int(stream["width"]), "height": int(stream["height"]), "fps": fps,
            "frames": frames, "duration": duration}


# ---------------------------------------------------------------- 세션과 대상

class Target:
    def __init__(self, target_id, name, state):
        self.id, self.name, self.state = target_id, name, state
        self.status = "마스크 확인"
        self.positive = set()   # 양성 클릭이 있는 표본 번호
        self.prompts = set()    # 클릭이 있는 표본 번호
        self.results = {}       # 영상 프레임(1부터) -> 지표
        self.masks = {}         # 영상 프레임 -> 마스크 PNG
        self.previews = {}      # 클릭한 프레임의 미리보기 (영상 프레임 -> (지표, PNG))

    def summary(self):
        return {"id": self.id, "name": self.name, "status": self.status, "tracked": len(self.results)}


class Session:
    def __init__(self, session_id, video_path, info):
        self.id, self.video_path, self.info = session_id, video_path, info
        self.dir = video_path.parent
        self.prep = None  # {"width", "stride", "scale", "count", "dir", "track_w", "track_h"}
        self.targets = {}
        self.cancel = threading.Event()
        self.job = {"status": "idle", "target": None, "progress": 0, "total": 0, "elapsed": 0.0, "error": None}

    def sample_index(self, frame):
        """영상 프레임(1부터) -> 표본 번호. 추적 간격의 배수 프레임만 받는다."""
        if not self.prep:
            raise ApiError(400, "먼저 '추적 준비'를 하세요.")
        k, rest = divmod(int(frame) - 1, self.prep["stride"])
        if rest or not 0 <= k < self.prep["count"]:
            raise ApiError(400, f"프레임 {frame}은 추적 간격({self.prep['stride']})의 표본 프레임이 아닙니다.")
        return k

    def frame_of(self, k):
        return 1 + k * self.prep["stride"]


def get_session(session_id):
    if session_id not in SESSIONS:
        raise ApiError(404, "세션이 없습니다. 서버가 다시 시작됐다면 영상을 다시 올리세요.")
    return SESSIONS[session_id]


def get_target(session, target_id):
    if int(target_id) not in session.targets:
        raise ApiError(404, "추적 대상이 없습니다.")
    return session.targets[int(target_id)]


def model_ready(session):
    if predictor is None:
        raise ApiError(503, "SAM 2 모델이 없습니다. sam2가 설치된 환경에서 서버를 실행하세요.")
    if session.job["status"] == "running":
        raise ApiError(409, "추적이 진행 중입니다. 끝난 뒤 다시 하세요.")


def frame_output(state, k, temp=False):
    dicts = [state["temp_output_dict_per_obj"][0]] if temp else []
    dicts.append(state["output_dict_per_obj"][0])
    for d in dicts:
        for key in ("cond_frame_outputs", "non_cond_frame_outputs"):
            if k in d[key]:
                return d[key][k]
    return None


def mask_result(session, frame, logits, out):
    """마스크 로짓(추적 해상도) → (지표[영상 px], PNG). 신뢰도 = SAM 2의 '대상이 있다' 점수."""
    scale = session.prep["scale"]
    logits = logits.float().cpu()
    mask = (logits > 0).numpy()
    h, w = mask.shape
    area = int(mask.sum())
    confidence = float(torch.sigmoid(out["object_score_logits"].float()).flatten()[0]) if out is not None else (1.0 if area else 0.0)
    metrics = {"frame": frame, "bbox_x": None, "bbox_y": None, "bbox_w": None, "bbox_h": None,
               "area": round(area / scale ** 2), "confidence": round(confidence, 4), "edges": ""}
    if area:
        ys, xs = np.nonzero(mask)
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
        metrics.update(bbox_x=round(x0 / scale, 1), bbox_y=round(y0 / scale, 1),
                       bbox_w=round((x1 - x0 + 1) / scale, 1), bbox_h=round((y1 - y0 + 1) / scale, 1),
                       edges=("L" if x0 <= 1 else "") + ("T" if y0 <= 1 else "") +
                             ("R" if x1 >= w - 2 else "") + ("B" if y1 >= h - 2 else ""))
    buf = io.BytesIO()
    Image.fromarray(mask).save(buf, "PNG")
    return metrics, buf.getvalue()


# ---------------------------------------------------------------- API

def health(req):
    return {"ok": True, "device": f"{DEVICE} · SAM 2.1 {MODEL_NAME}" if predictor else "SAM 2 없음",
            "sam2": predictor is not None, "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))}


def upload_video(req):
    """본문 = 영상 파일. 새 세션을 만들고 ffprobe 정보를 돌려준다."""
    name = Path(req.query.get("name", ["video.mp4"])[0]).name or "video.mp4"
    length = int(req.headers.get("Content-Length") or 0)
    if length <= 0:
        raise ApiError(400, "영상 파일이 비어 있습니다.")
    # 화면은 한 번에 영상 하나만 쓴다. 이전 세션의 파일과 메모리는 정리한다.
    for old in list(SESSIONS.values()):
        old.cancel.set()
        shutil.rmtree(old.dir, ignore_errors=True)
    SESSIONS.clear()
    session_id = uuid.uuid4().hex[:12]
    folder = DATA / session_id
    folder.mkdir(parents=True)
    video_path = folder / ("video" + (Path(name).suffix or ".mp4"))
    with open(video_path, "wb") as f:
        remaining = length
        while remaining:
            chunk = req.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                raise ApiError(400, "영상 업로드가 중간에 끊겼습니다.")
            f.write(chunk)
            remaining -= len(chunk)
    req.body_consumed = True
    info = probe(video_path)
    SESSIONS[session_id] = Session(session_id, video_path, info)
    return {"session_id": session_id, **info}


def prepare(req, session_id):
    """추적 해상도(가로 px)와 추적 간격으로 프레임을 뽑는다."""
    session = get_session(session_id)
    model_ready(session)
    body = req.json()
    stride = max(1, min(30, int(body.get("stride", 3))))
    width = int(body.get("width") or session.info["width"])
    width = min(width, session.info["width"]) // 2 * 2
    if session.prep and session.prep["stride"] == stride and session.prep["width"] == width:
        return prep_info(session)
    out_dir = session.dir / f"frames_{width}_{stride}"
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir()
    run(["ffmpeg", "-v", "error", "-i", str(session.video_path),
         "-vf", f"select='not(mod(n,{stride}))',scale={width}:-2",
         "-fps_mode", "passthrough", "-q:v", "3", "-start_number", "0", str(out_dir / "%06d.jpg")])
    count = len(jpg_frames(out_dir))
    with Image.open(out_dir / "000000.jpg") as first:
        track_w, track_h = first.size
    session.prep = {"width": width, "stride": stride, "scale": track_w / session.info["width"],
                    "count": count, "dir": out_dir, "track_w": track_w, "track_h": track_h}
    session.targets.clear()  # 표본이 바뀌면 SAM 2 상태를 새로 만들어야 한다
    return prep_info(session)


def prep_info(session):
    p = session.prep
    return {"width": p["width"], "stride": p["stride"], "count": p["count"], "track_w": p["track_w"], "track_h": p["track_h"]}


def read_click(session, body):
    try:
        frame, x, y = int(body["frame"]), float(body["x"]), float(body["y"])
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, "frame, x, y 값이 필요합니다.")
    s = session.prep["scale"] if session.prep else 1
    return frame, session.sample_index(frame), x * s, y * s


def add_target(req, session_id):
    session = get_session(session_id)
    model_ready(session)
    body = req.json()
    frame, k, x, y = read_click(session, body)
    name = str(body.get("name") or f"target{len(session.targets) + 1}")[:80]
    with MODEL_LOCK, amp():
        state = predictor.init_state(str(session.prep["dir"]), offload_state_to_cpu=DEVICE == "cuda")
        _, _, masks = predictor.add_new_points_or_box(state, k, 1, points=[[x, y]], labels=[1])
        metrics, png = mask_result(session, frame, masks[0, 0], frame_output(state, k, temp=True))
    target = Target(max(session.targets, default=0) + 1, name, state)
    target.positive.add(k)
    target.prompts.add(k)
    target.previews[frame] = (metrics, png)
    session.targets[target.id] = target
    return {"id": target.id, "name": name, "metrics": metrics, "mask_png_base64": base64.b64encode(png).decode()}


def add_point(req, session_id, target_id):
    session = get_session(session_id)
    target = get_target(session, target_id)
    model_ready(session)
    body = req.json()
    frame, k, x, y = read_click(session, body)
    label = 0 if body.get("label") == 0 else 1
    if label == 0 and k not in target.positive:
        # 양성 클릭 없이 제외 클릭만 주면 SAM 2는 그 프레임 마스크를 비우고 거기서부터 '대상 없음'으로 추적한다
        raise ApiError(400, "이 프레임에서 먼저 대상 안쪽을 클릭(포함)한 다음 Shift+클릭으로 제외 지점을 추가하세요.")
    with MODEL_LOCK, amp():
        _, _, masks = predictor.add_new_points_or_box(target.state, k, 1, points=[[x, y]], labels=[label],
                                                      clear_old_points=False)
        metrics, png = mask_result(session, frame, masks[0, 0], frame_output(target.state, k, temp=True))
    if label:
        target.positive.add(k)
    target.prompts.add(k)
    target.previews[frame] = (metrics, png)
    target.status = "클릭 추가됨 · 추적 필요"
    return {"metrics": metrics, "mask_png_base64": base64.b64encode(png).decode()}


def delete_target(req, session_id, target_id):
    session = get_session(session_id)
    model_ready(session)
    session.targets.pop(int(target_id), None)
    return {"ok": True}


def run_tracking(session, target, mode, start_k):
    started = time.time()
    try:
        with MODEL_LOCK, amp():
            if mode == "from":
                passes = [(start_k, False)]
            else:
                passes = [(None, False), (None, True)]  # 첫 클릭 표본부터 끝까지, 그다음 처음까지 거꾸로
            for start, reverse in passes:
                for k, _, masks in predictor.propagate_in_video(target.state, start_frame_idx=start, reverse=reverse):
                    if session.cancel.is_set():
                        break
                    frame = session.frame_of(k)
                    metrics, png = mask_result(session, frame, masks[0, 0], frame_output(target.state, k))
                    target.results[frame], target.masks[frame] = metrics, png
                    session.job["progress"] += 1
                    session.job["elapsed"] = round(time.time() - started, 1)
                if session.cancel.is_set():
                    break
        cancelled = session.cancel.is_set()
        target.status = "취소됨" if cancelled else "완료"
        session.job["status"] = "cancelled" if cancelled else "completed"
    except Exception as error:
        traceback.print_exc()
        target.status = "실패"
        session.job.update(status="failed", error=str(error))
    session.job["elapsed"] = round(time.time() - started, 1)


def start_tracking(req, session_id, target_id):
    """mode=full: 클릭한 프레임들에서 앞뒤 양방향. mode=from: frame부터 뒤쪽만 다시 추적해 이어 붙인다."""
    session = get_session(session_id)
    target = get_target(session, target_id)
    model_ready(session)
    body = req.json()
    mode = "from" if body.get("mode") == "from" else "full"
    count = session.prep["count"]
    if mode == "from":
        start_k = session.sample_index(body.get("frame"))
        for frame in [f for f in target.results if f >= session.frame_of(start_k)]:
            target.results.pop(frame)
            target.masks.pop(frame, None)
        total = count - start_k
    else:
        start_k = None
        target.results.clear()
        target.masks.clear()
        total = count + 1  # 앞으로 (count − m) + 뒤로 (m + 1), m = 첫 클릭 표본
    session.cancel.clear()
    target.status = "추적 중"
    # 클라이언트가 곧바로 상태를 물어도 running이 보이도록 스레드 시작 전에 바꾼다
    session.job = {"status": "running", "target": target.id, "progress": 0, "total": total, "elapsed": 0.0, "error": None}
    threading.Thread(target=run_tracking, args=(session, target, mode, start_k), daemon=True).start()
    return {"ok": True, "total": total}


def status(req, session_id):
    session = get_session(session_id)
    return {"job": session.job, "targets": [t.summary() for t in session.targets.values()]}


def results(req, session_id, target_id):
    target = get_target(get_session(session_id), target_id)
    return {"frames": [target.results[f] for f in sorted(target.results)]}


def mask(req, session_id, target_id, frame):
    target = get_target(get_session(session_id), target_id)
    frame = int(frame)
    png = target.masks.get(frame) or (target.previews.get(frame) or (None, None))[1]
    if png is None:
        raise ApiError(404, "이 프레임의 마스크가 없습니다.")
    return {"mask_png_base64": base64.b64encode(png).decode()}


def cancel(req, session_id):
    get_session(session_id).cancel.set()
    return {"ok": True}


def mux(req, session_id):
    """본문 = 4채널 WAV. 영상에 소리를 얹은 mp4를 돌려준다 (스피커 순서 FL FR RL RR = quad)."""
    session = get_session(session_id)
    wav = session.dir / "mix.wav"
    wav.write_bytes(req.body)
    out = session.dir / "mix_video.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-i", str(session.video_path), "-i", str(wav),
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "384k",
         "-channel_layout", "quad", "-shortest", str(out)])
    return Binary(out.read_bytes(), "video/mp4")


def safe_name(value, fallback):
    value = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", unquote(value or "")).strip(" .")
    return value or fallback


def export_file(req):
    folder = EXPORTS / safe_name(req.query.get("folder", [""])[0], "export")
    folder.mkdir(parents=True, exist_ok=True)
    name = safe_name(req.query.get("name", [""])[0], "file.bin")
    (folder / name).write_bytes(req.body)
    return {"ok": True, "path": str(folder / name)}


def export_zip(req):
    """폴더 안 파일을 '이름_학번.zip'으로 묶는다. 한글 파일 이름은 UTF-8 표시가 붙어 Windows에서도 풀린다."""
    folder = EXPORTS / safe_name(req.query.get("folder", [""])[0], "export")
    if not folder.is_dir():
        raise ApiError(404, "내보낸 파일이 없습니다.")
    zip_path = folder.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(folder.iterdir()):
            if path.is_file():
                z.write(path, path.name)
    return Binary(zip_path.read_bytes(), "application/zip")


ROUTES = [
    ("GET", r"/health", health),
    ("POST", r"/api/videos", upload_video),
    ("POST", r"/api/sessions/(\w+)/prepare", prepare),
    ("POST", r"/api/sessions/(\w+)/targets", add_target),
    ("POST", r"/api/sessions/(\w+)/targets/(\d+)/points", add_point),
    ("POST", r"/api/sessions/(\w+)/targets/(\d+)/delete", delete_target),
    ("POST", r"/api/sessions/(\w+)/targets/(\d+)/track", start_tracking),
    ("GET", r"/api/sessions/(\w+)/status", status),
    ("GET", r"/api/sessions/(\w+)/targets/(\d+)/results", results),
    ("GET", r"/api/sessions/(\w+)/targets/(\d+)/mask/(\d+)", mask),
    ("POST", r"/api/sessions/(\w+)/cancel", cancel),
    ("POST", r"/api/sessions/(\w+)/mux", mux),
    ("POST", r"/api/export/file", export_file),
    ("POST", r"/api/export/zip", export_zip),
]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        # file://로 연 HTML은 Origin이 "null". 로컬 페이지만 허용해 아무 웹사이트나 이 서버를 부르지 못하게 한다.
        origin = self.headers.get("Origin")
        if origin and (origin == "null" or re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin)):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, code, payload):
        if isinstance(payload, Binary):
            body, content_type = payload.data, payload.content_type
        else:
            body, content_type = json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8"
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    @property
    def body(self):
        if not hasattr(self, "_body"):
            self._body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        return self._body

    def json(self):
        try:
            return json.loads(self.body or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON 형식이 아닙니다.")

    def _route(self, method):
        url = urlparse(self.path)
        self.query = parse_qs(url.query)
        self.body_consumed = False
        try:
            for route_method, pattern, handler in ROUTES:
                match = re.fullmatch(pattern, url.path)
                if match and route_method == method:
                    return self._send(200, handler(self, *match.groups()))
            raise ApiError(404, f"없는 주소입니다: {method} {url.path}")
        except ApiError as error:
            self._discard_body()
            self._send(error.code, {"error": str(error)})
        except Exception as error:
            traceback.print_exc()
            self._discard_body()
            self._send(500, {"error": f"서버 오류: {error}"})

    def _discard_body(self):
        if not self.body_consumed and not hasattr(self, "_body"):
            _ = self.body  # 읽지 않은 본문이 남으면 브라우저가 응답을 못 받는다

    def log_message(self, *args):
        pass  # 상태 확인 요청이 자주 와서 로그를 끈다. 오류는 traceback으로 출력된다.


def load_model(model):
    global predictor, DEVICE, MODEL_NAME
    # Apple MPS는 뺐다: M1에서 SAM 2 추적이 CPU보다 느렸다 (메모리 어텐션 연산이 CPU로 되돌아감)
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    if DEVICE == "cpu" and shutil.which("nvidia-smi"):
        print("[주의] NVIDIA GPU가 있는데 CPU용 torch가 설치돼 있어 느립니다. README의 GPU 설치 방법을 보세요.")
    MODEL_NAME = model
    ckpt = HERE / "checkpoints" / f"sam2.1_hiera_{model}.pt"
    if not ckpt.exists():
        print(f"모델 다운로드 중: {ckpt.name} (처음 한 번)")
        ckpt.parent.mkdir(exist_ok=True)
        partial = ckpt.with_suffix(".part")
        urllib.request.urlretrieve(CKPT_URL.format(model), partial)
        partial.rename(ckpt)
    predictor = build_sam2_video_predictor(f"configs/sam2.1/sam2.1_hiera_{MODELS[model]}.yaml", str(ckpt), device=DEVICE)


def main():
    parser = argparse.ArgumentParser(description="3·4회차 작업실 서버 (SAM 2 추적, ffmpeg)")
    parser.add_argument("--model", choices=list(MODELS), default="tiny")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        print("[주의] ffmpeg/ffprobe를 찾을 수 없습니다. 영상 정보 읽기·추적 준비·mp4 합성이 안 됩니다.")
    load_model(args.model)
    shutil.rmtree(DATA, ignore_errors=True)  # 세션은 메모리에만 있으므로 지난 실행의 파일은 쓸모없다
    DATA.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"작업실 서버 실행 중 · http://127.0.0.1:{args.port} · {DEVICE} · {args.model}")
    print("xr_sound_studio.html 작업실에서 '서버 연결'을 누르세요. 끝내려면 Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
