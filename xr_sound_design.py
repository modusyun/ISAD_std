"""
=============================================================================
 XR 사운드 디자인 1회차 - 4채널 공간 음향 패닝 및 동선 기반 사운드 시스템
=============================================================================
 - 필수 기능 1: 원하는 음원으로 4채널 스피커(FL: -30°, FR: +30°, RL: -135°, RR: +135°) 출력 테스트
 - 필수 기능 2: 동선 CSV 파일에 따른 객체 경로 시각화 (ASCII 레이더 & 인터랙티브 HTML)
 - 필수 기능 3: 동선에 따른 VBAP 4채널 공간 음향 및 거리 감쇄 계산, 실시간 출력 및 WAV 내보내기
 - 필수 기능 4: 최종 출력 소리 보정 (채널별 트림 dB, 딜레이 ms, 거리 감쇄 파라미터, 피크 리미터)
=============================================================================
"""

import copy
import time
import math
import csv
import webbrowser
from pathlib import Path
import numpy as np
import sounddevice as sd
import soundfile as sf

# =============================================================================
# 0. 스피커 구성 정의
# =============================================================================
# 0° = 전면(Front, +Y), +90° = 우측(Right, +X), -90° = 좌측(Left, -X), ±180° = 후면(Rear, -Y)
SPEAKERS = [
    {"ch": 0, "id": "FL", "name": "Front Left  (전면 좌)", "azimuth": -30.0, "color": "#3b82f6"},
    {"ch": 1, "id": "FR", "name": "Front Right (전면 우)", "azimuth":  30.0, "color": "#10b981"},
    {"ch": 2, "id": "RL", "name": "Rear Left   (후면 좌)", "azimuth": -135.0, "color": "#f59e0b"},
    {"ch": 3, "id": "RR", "name": "Rear Right  (후면 우)", "azimuth":  135.0, "color": "#ec4899"},
]

# 기본 사운드 보정 파라미터
DEFAULT_CALIBRATION = {
    "trim_db": [0.0, 0.0, 0.0, 0.0],       # FL, FR, RL, RR 게인 트림 (dB)
    "delay_ms": [0.0, 0.0, 0.0, 0.0],      # FL, FR, RL, RR 스피커 거리 편차 딜레이 (ms)
    "ref_dist_m": 2.0,                     # 기준 거리 (이 거리 이하에서는 감쇄 없음)
    "dist_exponent": 1.0,                  # 거리 감쇄 지수 (1.0 = 역거리 법칙 -6dB/oct)
    "min_gain_floor": 0.02,                # 최소 음량 바닥 (-34dB)
    "master_gain": 1.0,                    # 마스터 볼륨 배율
    "soft_limiter": True,                  # 클리핑 방지 소프트 리미터 활성화 여부
}

# =============================================================================
# 파일 경로 탐색 유틸리티
# =============================================================================
BASE_DIR = Path(__file__).resolve().parent

def resolve_file(candidates):
    """지정된 후보 경로 목록에서 존재하는 첫 번째 파일 경로를 반환합니다."""
    search_dirs = [
        BASE_DIR,
        BASE_DIR / "ISAD_1회차",
        BASE_DIR.parent,
        BASE_DIR.parent / "ISAD_1회차",
    ]
    for c in candidates:
        p = Path(c)
        if p.is_file():
            return p.resolve()
        for s in search_dirs:
            full = s / p
            if full.is_file():
                return full.resolve()
    return None

def get_default_paths():
    """기본 오디오 및 동선 파일 경로들을 자동으로 감지하여 반환합니다."""
    # ISAD_1회차/ 아래도 resolve_file의 search_dirs가 찾는다
    channel_test_wav = resolve_file([
        "Sample/음원 및 영상/channel_test.wav",
        "Sample/음원 및 영상/Channel_test.wav",
        "channel_test.wav"
    ])
    moving_sound_wav = resolve_file([
        "Sample/음원 및 영상/Moving_sound.wav",
        "Moving_sound.wav"
    ])
    default_csv = resolve_file([
        "Sample/동선/object_path.csv",
        "Sample/동선/object_path_1.csv",
        "object_path.csv"
    ])
    return channel_test_wav, moving_sound_wav, default_csv

# =============================================================================
# 1. 2D VBAP (Vector Base Amplitude Panning) 알고리즘
# =============================================================================
def calculate_vbap_gains(azimuth_deg):
    """
    4채널 스피커(FL:-30°, FR:+30°, RR:+135°, RL:-135°)에 대한 2D VBAP 게인을 계산합니다.
    - 정규화: Constant Power (에너지 보존, sum(g^2) = 1.0)
    - 반환값: [g_FL, g_FR, g_RL, g_RR]
    """
    az = (azimuth_deg + 180.0) % 360.0 - 180.0  # [-180, 180) 정규화
    g = np.zeros(4, dtype=np.float32)

    # 섹터 구분 (인접 스피커 쌍)
    # 인덱스: 0:FL, 1:FR, 2:RL, 3:RR
    if -30.0 <= az <= 30.0:
        sp1, sp2 = 0, 1  # FL, FR
        th1, th2, th = -30.0, 30.0, az
    elif 30.0 < az <= 135.0:
        sp1, sp2 = 1, 3  # FR, RR
        th1, th2, th = 30.0, 135.0, az
    elif -135.0 <= az < -30.0:
        sp1, sp2 = 2, 0  # RL, FL
        th1, th2, th = -135.0, -30.0, az
    else:
        # 후방 경계 (RR +135° ~ RL -135° -> 180° / 225°)
        sp1, sp2 = 3, 2  # RR, RL
        th1, th2 = 135.0, 225.0
        th = az if az >= 0.0 else az + 360.0

    th1_rad = math.radians(th1)
    th2_rad = math.radians(th2)
    th_rad = math.radians(th)

    denom = math.sin(th2_rad - th1_rad)
    if abs(denom) < 1e-6:
        g1, g2 = 0.5, 0.5
    else:
        g1 = max(0.0, math.sin(th2_rad - th_rad) / denom)
        g2 = max(0.0, math.sin(th_rad - th1_rad) / denom)

    # Constant Power Normalization
    norm = math.sqrt(g1 * g1 + g2 * g2)
    if norm > 1e-6:
        g1 /= norm
        g2 /= norm

    g[sp1] = g1
    g[sp2] = g2
    return g

def calculate_distance_gain(distance_m, ref_dist=2.0, exponent=1.0, min_floor=0.02):
    """
    거리에 따른 음량 감쇄를 계산합니다.
    A_dist(d) = max(min_floor, (ref_dist / max(ref_dist, d)) ^ exponent)
    """
    d = max(ref_dist, float(distance_m))
    gain = (ref_dist / d) ** exponent
    return max(min_floor, min(1.0, gain))

# =============================================================================
# 2. 동선 CSV 로드 및 파싱
# =============================================================================
def load_trajectory_csv(csv_path):
    """CSV 파일에서 프레임, 시간(초), 방위각, 고도각, 거리 정보를 로드합니다."""
    times = []
    azimuths = []
    elevations = []
    distances = []

    with open(csv_path, "r", encoding="utf-8-sig") as f:  # 엑셀/웹 스튜디오가 붙이는 BOM 허용
        reader = csv.DictReader(f)
        for r in reader:
            times.append(float(r["time_s"]))
            azimuths.append(float(r["azimuth_deg"]))
            elevations.append(float(r.get("elevation_deg", 0.0)))
            dist_val = float(r.get("distance_m", r.get("dist", 2.0)))
            distances.append(dist_val)

    times = np.array(times, dtype=np.float32)
    azimuths = np.array(azimuths, dtype=np.float32)
    elevations = np.array(elevations, dtype=np.float32)
    distances = np.array(distances, dtype=np.float32)

    if len(times) < 2:
        raise ValueError("동선 CSV에는 최소 2개의 프레임이 필요합니다.")
    if not all(np.all(np.isfinite(values)) for values in (times, azimuths, elevations, distances)):
        raise ValueError("동선 CSV에 비어 있거나 유효하지 않은 숫자 값이 있습니다.")
    if np.any(np.diff(times) <= 0):
        raise ValueError("동선 CSV의 time_s 값은 오름차순이어야 합니다.")
    if np.any(distances < 0):
        raise ValueError("동선 CSV의 distance_m 값은 0 이상이어야 합니다.")

    # 각도 불연속(±180° 도약) 제거를 위한 unwrap
    az_unwrapped = np.degrees(np.unwrap(np.radians(azimuths)))

    return {
        "path": Path(csv_path),
        "count": len(times),
        "duration": float(times[-1] - times[0]),
        "times": times,
        "azimuths": azimuths,
        "az_unwrapped": az_unwrapped,
        "elevations": elevations,
        "distances": distances,
    }

# =============================================================================
# 3. 객체 경로 시각화 (ASCII 레이더 & 인터랙티브 HTML)
# =============================================================================
def display_ascii_radar(traj_data):
    """터미널에 2D 레이더 평면 및 객체 동선 궤적을 텍스트 아트로 시각화합니다."""
    width, height = 45, 23
    grid = [[" " for _ in range(width)] for _ in range(height)]
    cx, cy = width // 2, height // 2

    # 거리 원(반지름) 표시
    max_d = max(traj_data["distances"])
    if max_d <= 0:
        max_d = 2.0
    scale = (min(cx, cy) - 2) / max_d

    # 방사선 및 십자선
    for y in range(height):
        grid[y][cx] = "│"
    for x in range(width):
        grid[cy][x] = "─"
    grid[cy][cx] = "┼"

    # 스피커 위치 마킹
    for spk in SPEAKERS:
        az_r = math.radians(spk["azimuth"])
        # x = sin(az), y = cos(az)  (Front = 0° -> Y+, Right = +90° -> X+)
        sx = int(cx + (cx - 3) * math.sin(az_r) * 1.5)
        sy = int(cy - (cy - 2) * math.cos(az_r))
        sx = max(1, min(width - 3, sx))
        sy = max(1, min(height - 2, sy))
        tag = spk["id"]
        grid[sy][sx] = tag[0]
        if sx + 1 < width:
            grid[sy][sx + 1] = tag[1]

    # 객체 궤적 점 표시
    az_u = traj_data["az_unwrapped"]
    dist = traj_data["distances"]
    sample_step = max(1, len(az_u) // 60)
    for i in range(0, len(az_u), sample_step):
        az_rad = math.radians(az_u[i])
        d = dist[i]
        px = int(cx + (d * scale * 1.8) * math.sin(az_rad))
        py = int(cy - (d * scale) * math.cos(az_rad))
        if 0 <= px < width and 0 <= py < height:
            if grid[py][px] in [" ", "─", "│", "┼"]:
                grid[py][px] = "•"

    # 시작점과 끝점 표시
    start_rad = math.radians(az_u[0])
    s_x = int(cx + (dist[0] * scale * 1.8) * math.sin(start_rad))
    s_y = int(cy - (dist[0] * scale) * math.cos(start_rad))
    if 0 <= s_x < width and 0 <= s_y < height:
        grid[s_y][s_x] = "S"

    end_rad = math.radians(az_u[-1])
    e_x = int(cx + (dist[-1] * scale * 1.8) * math.sin(end_rad))
    e_y = int(cy - (dist[-1] * scale) * math.cos(end_rad))
    if 0 <= e_x < width and 0 <= e_y < height:
        grid[e_y][e_x] = "E"

    print("\n" + "┌" + "─" * width + "┐")
    print(f"│  2D 공간 음향 레이더 뷰 (S:시작, E:종료, •:동선)   │".center(width))
    print("├" + "─" * width + "┤")
    for row in grid:
        print("│" + "".join(row) + "│")
    print("└" + "─" * width + "┘")
    print(" [범례] FL:전면좌(-30°)  FR:전면우(+30°)  RL:후면좌(-135°)  RR:후면우(+135°)")
    print(f" [동선 정보] 총 {traj_data['count']}프레임 | {traj_data['duration']:.2f}초 | 거리 범위: {dist.min():.1f}m ~ {dist.max():.1f}m")

def generate_interactive_html_visualizer(traj_data, output_html="trajectory_plot.html"):
    """동선 궤적, 시간별 방위각/거리, 4채널 게인 곡선을 보여주는 인터랙티브 HTML 파일을 생성합니다."""
    out_path = BASE_DIR / output_html

    # 각 프레임별 4채널 게인 미리 계산
    gains_list = []
    for az, dist in zip(traj_data["azimuths"], traj_data["distances"]):
        g_vbap = calculate_vbap_gains(az)
        g_dist = calculate_distance_gain(dist)
        gains_list.append((g_vbap * g_dist).tolist())

    html_content = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>XR 사운드 디자인 - 객체 동선 및 4채널 게인 시각화</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }}
  .container {{ max-width: 1200px; margin: 0 auto; }}
  h1 {{ font-size: 24px; margin-bottom: 8px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }}
  .subtitle {{ color: #94a3b8; font-size: 14px; margin-bottom: 24px; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }}
  .card {{ background: #1e293b; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); border: 1px solid #334155; }}
  canvas {{ width: 100%; height: 420px; background: #0b1120; border-radius: 8px; display: block; }}
  .badge {{ display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; margin-right: 8px; }}
  .legend {{ display: flex; gap: 14px; margin-top: 12px; font-size: 13px; flex-wrap: wrap; }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; }}
  .dot {{ width: 12px; height: 12px; border-radius: 50%; }}
  .stat-row {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 20px; }}
  .stat-box {{ background: #0f172a; padding: 14px; border-radius: 8px; text-align: center; border: 1px solid #334155; }}
  .stat-val {{ font-size: 20px; font-weight: bold; color: #38bdf8; margin-top: 4px; }}
  .stat-lbl {{ font-size: 12px; color: #94a3b8; }}
</style>
</head>
<body>
<div class="container">
  <h1><span>🎧</span> XR 사운드 디자인 - 4채널 스피커 동선 시각화</h1>
  <div class="subtitle">파일: {traj_data['path'].name} | 총 프레임: {traj_data['count']} | 재생 시간: {traj_data['duration']:.2f}초</div>

  <div class="stat-row">
    <div class="stat-box"><div class="stat-lbl">총 시간</div><div class="stat-val">{traj_data['duration']:.2f} s</div></div>
    <div class="stat-box"><div class="stat-lbl">거리 범위</div><div class="stat-val">{traj_data['distances'].min():.1f}m ~ {traj_data['distances'].max():.1f}m</div></div>
    <div class="stat-box"><div class="stat-lbl">방위각 변화</div><div class="stat-val">{traj_data['azimuths'].min():.0f}° ~ {traj_data['azimuths'].max():.0f}°</div></div>
    <div class="stat-box"><div class="stat-lbl">스피커 구성</div><div class="stat-val">4채널 (±30°, ±135°)</div></div>
  </div>

  <div class="grid" style="margin-top: 20px;">
    <!-- 2D 공간 레이더 플롯 -->
    <div class="card">
      <h3 style="margin-top:0; color:#e2e8f0;">2D 공간 레이더 (리스너 & 스피커 배치 및 객체 궤적)</h3>
      <canvas id="radarCanvas" width="600" height="420"></canvas>
      <div class="legend">
        <div class="legend-item"><div class="dot" style="background:#3b82f6;"></div>FL (-30°)</div>
        <div class="legend-item"><div class="dot" style="background:#10b981;"></div>FR (+30°)</div>
        <div class="legend-item"><div class="dot" style="background:#f59e0b;"></div>RL (-135°)</div>
        <div class="legend-item"><div class="dot" style="background:#ec4899;"></div>RR (+135°)</div>
        <div class="legend-item"><div class="dot" style="background:#38bdf8;"></div>객체 이동 동선</div>
      </div>
    </div>

    <!-- 시간별 4채널 게인 변화 곡선 -->
    <div class="card">
      <h3 style="margin-top:0; color:#e2e8f0;">시간(초)에 따른 4채널 출력 게인 (VBAP × 거리감쇄)</h3>
      <canvas id="gainCanvas" width="600" height="420"></canvas>
      <div class="legend">
        <div class="legend-item"><div class="dot" style="background:#3b82f6;"></div>FL 게인</div>
        <div class="legend-item"><div class="dot" style="background:#10b981;"></div>FR 게인</div>
        <div class="legend-item"><div class="dot" style="background:#f59e0b;"></div>RL 게인</div>
        <div class="legend-item"><div class="dot" style="background:#ec4899;"></div>RR 게인</div>
      </div>
    </div>
  </div>
</div>

<script>
const times = {traj_data['times'].tolist()};
const az_u = {traj_data['az_unwrapped'].tolist()};
const dists = {traj_data['distances'].tolist()};
const gains = {gains_list};

// 1. Radar Canvas 그리기
const rCanvas = document.getElementById('radarCanvas');
const rCtx = rCanvas.getContext('2d');
const rcx = rCanvas.width / 2, rcy = rCanvas.height / 2;
const maxD = Math.max(...dists, 5);
const scale = (Math.min(rcx, rcy) - 45) / maxD;

// 배경 격자 및 거리 동심원
rCtx.strokeStyle = '#334155';
rCtx.lineWidth = 1;
[1, 2, 5, 10, 20, 50].forEach(r => {{
  if (r * scale < Math.min(rcx, rcy)) {{
    rCtx.beginPath();
    rCtx.arc(rcx, rcy, r * scale, 0, Math.PI * 2);
    rCtx.stroke();
    rCtx.fillStyle = '#64748b';
    rCtx.font = '10px sans-serif';
    rCtx.fillText(r + 'm', rcx + 5, rcy - r * scale + 12);
  }}
}});

// 십자선 (Front/Rear, Left/Right)
rCtx.beginPath();
rCtx.moveTo(rcx, 20); rCtx.lineTo(rcx, rCanvas.height - 20);
rCtx.moveTo(20, rcy); rCtx.lineTo(rCanvas.width - 20, rcy);
rCtx.stroke();
rCtx.fillStyle = '#94a3b8';
rCtx.font = '12px sans-serif';
rCtx.fillText('Front (0°)', rcx - 28, 16);
rCtx.fillText('Rear (180°)', rcx - 30, rCanvas.height - 6);
rCtx.fillText('L (-90°)', 6, rcy + 4);
rCtx.fillText('R (+90°)', rCanvas.width - 48, rcy + 4);

// 리스너 마커 (중앙)
rCtx.beginPath();
rCtx.arc(rcx, rcy, 8, 0, Math.PI * 2);
rCtx.fillStyle = '#f8fafc';
rCtx.fill();
rCtx.fillStyle = '#0f172a';
rCtx.font = 'bold 9px sans-serif';
rCtx.fillText('L', rcx - 3, rcy + 3);

// 4개 스피커 마커
const spks = [
  {{ name: 'FL (-30°)', az: -30, col: '#3b82f6' }},
  {{ name: 'FR (+30°)', az:  30, col: '#10b981' }},
  {{ name: 'RL (-135°)', az: -135, col: '#f59e0b' }},
  {{ name: 'RR (+135°)', az:  135, col: '#ec4899' }}
];
const spkDist = Math.min(rcx, rcy) - 35;
spks.forEach(s => {{
  const rad = s.az * Math.PI / 180;
  const sx = rcx + spkDist * Math.sin(rad);
  const sy = rcy - spkDist * Math.cos(rad);
  rCtx.beginPath();
  rCtx.arc(sx, sy, 10, 0, Math.PI * 2);
  rCtx.fillStyle = s.col;
  rCtx.fill();
  rCtx.strokeStyle = '#f8fafc';
  rCtx.lineWidth = 1.5;
  rCtx.stroke();
  rCtx.fillStyle = '#f8fafc';
  rCtx.font = 'bold 11px sans-serif';
  rCtx.fillText(s.name.split(' ')[0], sx + (Math.sin(rad) > 0 ? 12 : -32), sy + 4);
}});

// 객체 동선 궤적 그리기
rCtx.beginPath();
rCtx.strokeStyle = '#38bdf8';
rCtx.lineWidth = 3;
for (let i = 0; i < az_u.length; i++) {{
  const rad = az_u[i] * Math.PI / 180;
  const d = dists[i];
  const px = rcx + d * scale * Math.sin(rad);
  const py = rcy - d * scale * Math.cos(rad);
  if (i === 0) rCtx.moveTo(px, py);
  else rCtx.lineTo(px, py);
}}
rCtx.stroke();

// 시작점(초록) 및 끝점(빨강)
const sRad = az_u[0] * Math.PI / 180;
const sx = rcx + dists[0] * scale * Math.sin(sRad), sy = rcy - dists[0] * scale * Math.cos(sRad);
rCtx.beginPath(); rCtx.arc(sx, sy, 6, 0, Math.PI*2); rCtx.fillStyle = '#22c55e'; rCtx.fill();
rCtx.fillStyle = '#22c55e'; rCtx.font = 'bold 11px sans-serif'; rCtx.fillText('Start', sx+8, sy+4);

const eRad = az_u[az_u.length-1] * Math.PI / 180;
const ex = rcx + dists[dists.length-1] * scale * Math.sin(eRad), ey = rcy - dists[dists.length-1] * scale * Math.cos(eRad);
rCtx.beginPath(); rCtx.arc(ex, ey, 6, 0, Math.PI*2); rCtx.fillStyle = '#ef4444'; rCtx.fill();
rCtx.fillStyle = '#ef4444'; rCtx.font = 'bold 11px sans-serif'; rCtx.fillText('End', ex+8, ey+4);

// 2. Gain Canvas 그리기
const gCanvas = document.getElementById('gainCanvas');
const gCtx = gCanvas.getContext('2d');
const gw = gCanvas.width, gh = gCanvas.height;
const pad = {{ top: 30, right: 20, bottom: 40, left: 45 }};
const pw = gw - pad.left - pad.right;
const ph = gh - pad.top - pad.bottom;
const totalTime = times[times.length - 1];

// 축 그리기
gCtx.strokeStyle = '#334155';
gCtx.lineWidth = 1;
gCtx.beginPath();
gCtx.moveTo(pad.left, pad.top);
gCtx.lineTo(pad.left, pad.top + ph);
gCtx.lineTo(pad.left + pw, pad.top + ph);
gCtx.stroke();

// Y축 라벨 (0.0 ~ 1.0)
gCtx.fillStyle = '#94a3b8';
gCtx.font = '10px sans-serif';
[0.0, 0.25, 0.5, 0.75, 1.0].forEach(v => {{
  const y = pad.top + ph * (1 - v);
  gCtx.fillText(v.toFixed(2), 10, y + 3);
  gCtx.beginPath();
  gCtx.strokeStyle = '#1e293b';
  gCtx.moveTo(pad.left, y);
  gCtx.lineTo(pad.left + pw, y);
  gCtx.stroke();
}});

// X축 라벨 (시간)
for (let t = 0; t <= totalTime; t += Math.max(1, Math.round(totalTime / 6))) {{
  const x = pad.left + (t / totalTime) * pw;
  gCtx.fillText(t + 's', x - 6, pad.top + ph + 18);
}}

// 4개 채널 곡선 그리기
const cols = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899'];
for (let ch = 0; ch < 4; ch++) {{
  gCtx.beginPath();
  gCtx.strokeStyle = cols[ch];
  gCtx.lineWidth = 2.5;
  for (let i = 0; i < gains.length; i++) {{
    const x = pad.left + (times[i] / totalTime) * pw;
    const y = pad.top + ph * (1 - Math.min(1.0, gains[i][ch]));
    if (i === 0) gCtx.moveTo(x, y);
    else gCtx.lineTo(x, y);
  }}
  gCtx.stroke();
}}
</script>
</body>
</html>"""

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    print(f" ✅ 시각화 HTML 생성 완료: {out_path.name}")
    return out_path

# =============================================================================
# 4. 객체 이동 경로에 따른 4채널 공간 음향 렌더링 엔진
# =============================================================================
def render_spatial_audio(audio_path, traj_data, calibration=None):
    """
    모노/스테레오 오디오 소스에 동선 CSV와 VBAP 및 사운드 보정 알고리즘을 적용하여
    최종 4채널 버퍼(shape: [samples, 4])를 렌더링합니다.
    """
    if calibration is None:
        calibration = DEFAULT_CALIBRATION

    # 1. 오디오 소스 로드
    data, sr = sf.read(str(audio_path), dtype="float32")
    if data.ndim > 1:
        mono_src = data.mean(axis=1)  # 스테레오 -> 모노 믹스
    else:
        mono_src = data

    # 2. 재생 시간 결정 (동선 시간과 음원 길이 맞춤)
    traj_duration = traj_data["duration"]
    total_samples = int(traj_duration * sr)
    if total_samples <= 0:
        raise ValueError("동선 길이가 0초이므로 오디오를 렌더링할 수 없습니다.")
    source_length = len(mono_src)
    if source_length == 0:
        raise ValueError("오디오 파일에 렌더링할 샘플이 없습니다.")
    
    # 페이드인/아웃으로 클릭음 방지 (각 30ms), 반복 음원 전체에 적용
    fade_len = min(int(sr * 0.03), total_samples // 4)
    fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32) if fade_len else None
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32) if fade_len else None

    # 3. 시간축에 따른 방위각 및 거리 연속 보간 (Sample-accurate)
    t0 = float(traj_data["times"][0])
    sample_times = np.linspace(t0, t0 + traj_duration, total_samples, endpoint=False, dtype=np.float32)
    interp_az = np.interp(sample_times, traj_data["times"], traj_data["az_unwrapped"])
    interp_dist = np.interp(sample_times, traj_data["times"], traj_data["distances"])

    # 4. 블록 단위로 4채널 게인 계산 및 버퍼 렌더링 (블록 크기: 256샘플)
    block_size = 256
    num_blocks = int(math.ceil(total_samples / block_size))
    output_4ch = np.zeros((total_samples, 4), dtype=np.float32)

    ref_d = calibration["ref_dist_m"]
    dist_exp = calibration["dist_exponent"]
    min_floor = calibration["min_gain_floor"]

    # 채널별 트림 게인 (dB -> 리니어)
    trim_linear = np.array([10.0 ** (db / 20.0) for db in calibration["trim_db"]], dtype=np.float32)

    prev_gains = None
    for b in range(num_blocks):
        start = b * block_size
        end = min(total_samples, start + block_size)
        mid_idx = (start + end) // 2
        block_indices = np.arange(start, end)
        source_block = mono_src[block_indices % source_length]
        if fade_len:
            fade_in_mask = block_indices < fade_len
            fade_out_start = total_samples - fade_len
            fade_out_mask = block_indices >= fade_out_start
            source_block[fade_in_mask] *= fade_in[block_indices[fade_in_mask]]
            source_block[fade_out_mask] *= fade_out[block_indices[fade_out_mask] - fade_out_start]

        cur_az = interp_az[mid_idx]
        cur_dist = interp_dist[mid_idx]

        g_vbap = calculate_vbap_gains(cur_az)
        g_dist = calculate_distance_gain(cur_dist, ref_d, dist_exp, min_floor)
        target_gains = g_vbap * g_dist * trim_linear

        if prev_gains is None:
            prev_gains = target_gains

        # 지퍼 노이즈 방지를 위한 블록 내 선형 보간 (Ramp)
        ramp = np.linspace(prev_gains, target_gains, end - start, dtype=np.float32)
        for ch in range(4):
            output_4ch[start:end, ch] = source_block * ramp[:, ch]

        prev_gains = target_gains

    # 5. 사운드 보정 기능 적용
    # a. 스피커 거리 차이에 따른 채널별 딜레이 보정
    for ch in range(4):
        d_ms = calibration["delay_ms"][ch]
        if d_ms > 0.0:
            shift = int((d_ms / 1000.0) * sr)
            if 0 < shift < total_samples:
                shifted = np.zeros_like(output_4ch[:, ch])
                shifted[shift:] = output_4ch[:-shift, ch]
                output_4ch[:, ch] = shifted

    # b. 마스터 게인
    output_4ch *= calibration["master_gain"]

    # c. 클리핑 방지 소프트 리미터 / 노멀라이제이션
    if calibration["soft_limiter"]:
        peak = np.max(np.abs(output_4ch))
        if peak > 0.98:
            # 피크를 0.98로 맞추는 전체 노멀라이즈 (tanh 압축 아님)
            scale = 0.98 / peak
            output_4ch *= scale

    return output_4ch, sr

# =============================================================================
# 5. 오디오 출력 및 실시간 모니터링
# =============================================================================
def get_audio_device():
    """사용 가능한 오디오 장치 중 4채널 지원 장치 또는 기본 장치를 선택합니다."""
    devices = sd.query_devices()
    default_out_idx = sd.default.device[1]
    
    # 4채널 이상 물리 장치 검색
    multi_idx = None
    for idx, d in enumerate(devices):
        if d["max_output_channels"] >= 4:
            multi_idx = idx
            break

    if multi_idx is not None:
        return multi_idx, 4, f"[{multi_idx}] {devices[multi_idx]['name']} (물리 4채널)"
    else:
        def_d = sd.query_devices(default_out_idx)
        ch_count = def_d["max_output_channels"]
        return default_out_idx, ch_count, f"[{default_out_idx}] {def_d['name']} (스테레오 다운믹스 모드)"

def play_multichannel_audio(audio_4ch, sr, title="공간 음향 재생"):
    """
    4채널 오디오 버퍼를 사운드카드로 출력하며 터미널에 실시간 4채널 레벨 미터를 표시합니다.
    """
    dev_idx, dev_channels, dev_desc = get_audio_device()
    print(f"\n▶ 오디오 출력 장치: {dev_desc}")
    print(f"▶ 재생 시작: {title} (총 {len(audio_4ch)/sr:.2f}초)")

    is_hardware_4ch = (dev_channels >= 4)
    if is_hardware_4ch:
        stream_buffer = audio_4ch
        stream_channels = 4
    else:
        # 2채널 이어폰/스피커용 스테레오 다운믹스
        # Left = FL + 0.707 * RL, Right = FR + 0.707 * RR
        stereo_buffer = np.zeros((len(audio_4ch), 2), dtype=np.float32)
        stereo_buffer[:, 0] = audio_4ch[:, 0] + 0.707 * audio_4ch[:, 2]
        stereo_buffer[:, 1] = audio_4ch[:, 1] + 0.707 * audio_4ch[:, 3]
        peak = np.max(np.abs(stereo_buffer))
        if peak > 0.98:
            stereo_buffer *= (0.95 / peak)
        stream_buffer = stereo_buffer
        stream_channels = 2

    # 재생 시작
    sd.play(stream_buffer, samplerate=sr, device=dev_idx)

    # 터미널 실시간 4채널 VU 레벨 미터 표시
    duration = len(audio_4ch) / sr
    block_dur = 0.15
    block_samples = int(block_dur * sr)
    total_blocks = int(duration / block_dur)

    print("\n   [실시간 4채널 VU 레벨 미터]")
    print("   시간     │ FL (전면좌) │ FR (전면우) │ RL (후면좌) │ RR (후면우)")
    print("  ──────────┼─────────────┼─────────────┼─────────────┼────────────")

    for b in range(total_blocks):
        st = b * block_samples
        en = min(len(audio_4ch), st + block_samples)
        rms = np.sqrt(np.mean(audio_4ch[st:en] ** 2, axis=0) + 1e-9)

        # 막대그래프 문자열 생성 (0~10칸)
        bars = []
        for ch in range(4):
            val = min(1.0, rms[ch] * 3.5)
            n_bar = int(val * 9)
            bars.append("█" * n_bar + "░" * (9 - n_bar))

        cur_t = b * block_dur
        print(f"\r  {cur_t:4.1f}s/{duration:4.1f}s │ {bars[0]} │ {bars[1]} │ {bars[2]} │ {bars[3]}", end="", flush=True)
        time.sleep(block_dur)

    sd.wait()
    print("\n  ──────────┴─────────────┴─────────────┴─────────────┴────────────")
    print(" ✅ 재생 완료!\n")

# =============================================================================
# 6. 필수 기능 1: 4채널 스피커 순차/개별 출력 테스트
# =============================================================================
def run_speaker_channel_test(audio_path=None):
    """
    원하는 음원으로 4개 스피커(FL: -30°, FR: +30°, RL: -135°, RR: +135°)를
    순차적으로 테스트 출력합니다.
    """
    if audio_path is None or not Path(audio_path).is_file():
        default_test, _, _ = get_default_paths()
        audio_path = default_test

    if audio_path is None or not Path(audio_path).is_file():
        print(" [!] 테스트 음원 파일을 찾을 수 없어 기본 440Hz 신호음(Beep)을 생성합니다.")
        sr = 48000
        t = np.linspace(0, 1.0, sr, endpoint=False, dtype=np.float32)
        mono_signal = 0.4 * np.sin(2 * np.pi * 440 * t)
        mono_signal[:2400] *= np.linspace(0, 1, 2400)
        mono_signal[-2400:] *= np.linspace(1, 0, 2400)
    else:
        print(f"\n [1] 테스트 음원 로드: {Path(audio_path).name}")
        data, sr = sf.read(str(audio_path), dtype="float32")
        mono_signal = data.mean(axis=1) if data.ndim > 1 else data
        # 너무 긴 음원은 1.5초로 제한
        if len(mono_signal) > int(sr * 1.5):
            mono_signal = mono_signal[:int(sr * 1.5)]

    dev_idx, dev_channels, dev_desc = get_audio_device()
    print(f" [2] 출력 장치: {dev_desc}")
    print("\n" + "=" * 65)
    print(" 🔊 4채널 스피커 순차 출력 테스트 시작 (FL -> FR -> RL -> RR)")
    print("=" * 65)

    silence_samples = int(sr * 0.3)
    total_len = len(mono_signal) + silence_samples

    for spk in SPEAKERS:
        ch = spk["ch"]
        name = spk["name"]
        az = spk["azimuth"]
        print(f"\n ▶ [채널 {ch+1}/4] {name} (방위각: {az:+.0f}°)")

        if dev_channels >= 4:
            buf = np.zeros((total_len, 4), dtype=np.float32)
            buf[:len(mono_signal), ch] = mono_signal
        else:
            # 2채널 다운믹스 (FL, RL -> Left / FR, RR -> Right)
            buf = np.zeros((total_len, 2), dtype=np.float32)
            st_idx = 0 if ch in [0, 2] else 1
            buf[:len(mono_signal), st_idx] = mono_signal

        sd.play(buf, samplerate=sr, device=dev_idx)

        # 프로그레스 바 표시
        steps = 15
        step_time = (len(mono_signal) / sr) / steps
        print("   진행: [", end="", flush=True)
        for _ in range(steps):
            time.sleep(step_time)
            print("■", end="", flush=True)
        print("] 출력 중")

        sd.wait()
        time.sleep(0.2)

    print("\n" + "=" * 65)
    print(" ✅ 4채널 스피커 순차 출력이 성공적으로 완료되었습니다!")
    print("=" * 65)

# =============================================================================
# 7. 필수 기능 4: 최종 출력 소리 보정 설정 메뉴
# =============================================================================
def configure_calibration_menu(calib):
    """채널별 트림, 딜레이, 거리 감쇄 파라미터, 리미터 설정을 대화형으로 조정합니다."""
    while True:
        print("\n" + "=" * 65)
        print(" 🛠️  최종 출력 소리 보정 (Calibration) 설정")
        print("=" * 65)
        print(f" 1. FL 채널 트림 (전면 좌) : {calib['trim_db'][0]:+.1f} dB")
        print(f" 2. FR 채널 트림 (전면 우) : {calib['trim_db'][1]:+.1f} dB")
        print(f" 3. RL 채널 트림 (후면 좌) : {calib['trim_db'][2]:+.1f} dB")
        print(f" 4. RR 채널 트림 (후면 우) : {calib['trim_db'][3]:+.1f} dB")
        print(f" 5. 채널별 딜레이 보정 (ms): FL:{calib['delay_ms'][0]}ms, FR:{calib['delay_ms'][1]}ms, RL:{calib['delay_ms'][2]}ms, RR:{calib['delay_ms'][3]}ms")
        print(f" 6. 기준 거리 (Ref Dist)   : {calib['ref_dist_m']:.1f} m")
        print(f" 7. 거리 감쇄 지수 (Exp)   : {calib['dist_exponent']:.2f} (1.0 = 역거리 법칙)")
        print(f" 8. 마스터 볼륨 (Master)   : {calib['master_gain']:.2f}")
        print(f" 9. 소프트 피크 리미터     : {'ON (활성)' if calib['soft_limiter'] else 'OFF'}")
        print(" 0. 설정 저장 및 메인 메뉴로 복귀")
        print("=" * 65)

        sel = input(" 조정할 항목 번호를 입력하세요 [0-9]: ").strip()
        if sel == "0":
            break
        elif sel in ["1", "2", "3", "4"]:
            ch_idx = int(sel) - 1
            spk_name = SPEAKERS[ch_idx]["name"]
            val = input(f" {spk_name} 트림 게인 (dB 입력, 예: -3.0 ~ +3.0): ").strip()
            try:
                calib["trim_db"][ch_idx] = float(val)
                print(f" >> {spk_name} 트림이 {calib['trim_db'][ch_idx]:+.1f} dB로 설정되었습니다.")
            except ValueError:
                print(" [!] 올바른 숫자를 입력하세요.")
        elif sel == "5":
            val = input(" 4채널 딜레이(ms)를 쉼표로 입력하세요 (예: 0.0, 0.0, 1.5, 1.5): ").strip()
            try:
                delays = [float(x.strip()) for x in val.split(",")]
                if len(delays) == 4:
                    calib["delay_ms"] = delays
                    print(f" >> 딜레이 보정 완료: {calib['delay_ms']}")
                else:
                    print(" [!] 4개의 값을 입력해야 합니다.")
            except ValueError:
                print(" [!] 올바른 형식으로 입력하세요.")
        elif sel == "6":
            val = input(f" 기준 거리(m) 입력 (현재 {calib['ref_dist_m']}m): ").strip()
            try:
                calib["ref_dist_m"] = max(0.5, float(val))
            except ValueError:
                print(" [!] 올바른 숫자를 입력하세요.")
        elif sel == "7":
            val = input(f" 거리 감쇄 지수 입력 (현재 {calib['dist_exponent']}): ").strip()
            try:
                calib["dist_exponent"] = max(0.0, float(val))
            except ValueError:
                print(" [!] 올바른 숫자를 입력하세요.")
        elif sel == "8":
            val = input(f" 마스터 볼륨 배율 입력 (0.1 ~ 2.0, 현재 {calib['master_gain']}): ").strip()
            try:
                calib["master_gain"] = max(0.0, float(val))
            except ValueError:
                print(" [!] 올바른 숫자를 입력하세요.")
        elif sel == "9":
            calib["soft_limiter"] = not calib["soft_limiter"]
            print(f" >> 피크 리미터: {calib['soft_limiter']}")

# =============================================================================
# 8. 메인 대화형 콘솔 메뉴
# =============================================================================
def main():
    print("=" * 65)
    print("      XR 사운드 디자인 1회차 - 4채널 공간 음향 마스터 프로그램")
    print("=" * 65)

    # 기본 파일 자동 탐색
    channel_test_wav, moving_sound_wav, default_csv = get_default_paths()
    cur_audio_path = moving_sound_wav or channel_test_wav
    cur_csv_path = default_csv
    calibration = copy.deepcopy(DEFAULT_CALIBRATION)

    print(f" * 현재 음원 파일 : {cur_audio_path.name if cur_audio_path else '미지정'}")
    print(f" * 현재 동선 CSV  : {cur_csv_path.name if cur_csv_path else '미지정'}")

    while True:
        print("\n" + "─" * 65)
        print(" [실습 메뉴]")
        print("  1. [기능 1] 4채널 스피커 순차 출력 테스트 (FL, FR, RL, RR)")
        print("  2. [기능 2] 동선 CSV 파일 로드 및 객체 경로 시각화 (ASCII & HTML)")
        print("  3. [기능 3] 동선에 따른 4채널 공간 음향 렌더링 및 실시간 출력")
        print("  4. [기능 4] 최종 출력 사운드 보정 설정 (트림, 딜레이, 감쇄, 리미터)")
        print("  5. [내보내기] 렌더링된 4채널 마스터 오디오를 WAV 파일로 저장")
        print("  6. [설정] 음원 및 CSV 파일 변경")
        print("  7. [웹 스튜디오] 그래픽 UI (브라우저 인터랙티브 스튜디오) 열기")
        print("  0. 프로그램 종료")
        print("─" * 65)

        choice = input(" 메뉴 번호를 선택하세요 [0-7]: ").strip()

        try:
            if choice == "1":
                print("\n [테스트 음원 선택]")
                print(f"  1) 기본 채널 테스트 음원 ({channel_test_wav.name if channel_test_wav else 'channel_test.wav'})")
                print(f"  2) 객체 이동 음원 ({moving_sound_wav.name if moving_sound_wav else 'Moving_sound.wav'})")
                print("  3) 직접 경로 입력")
                sub = input("  선택 [기본: 1]: ").strip()
                test_wav = channel_test_wav
                if sub == "2":
                    test_wav = moving_sound_wav
                elif sub == "3":
                    custom = input("  음원 파일 경로 입력: ").strip()
                    if Path(custom).is_file():
                        test_wav = Path(custom)
                run_speaker_channel_test(test_wav)

            elif choice == "2":
                if cur_csv_path is None or not cur_csv_path.is_file():
                    print(" [!] 동선 CSV 파일이 존재하지 않습니다. 먼저 파일 경로를 설정하세요.")
                    continue
                traj_data = load_trajectory_csv(cur_csv_path)
                display_ascii_radar(traj_data)
                html_path = generate_interactive_html_visualizer(traj_data)
                open_browser = input(" 브라우저에서 인터랙티브 그래프를 열까요? (y/n) [기본: y]: ").strip().lower()
                if open_browser != "n":
                    webbrowser.open(str(html_path))

            elif choice == "3":
                if cur_csv_path is None or not cur_csv_path.is_file():
                    print(" [!] 동선 CSV 파일을 찾을 수 없습니다.")
                    continue
                if cur_audio_path is None or not cur_audio_path.is_file():
                    print(" [!] 음원 파일을 찾을 수 없습니다.")
                    continue

                print("\n [계산 중] 동선 CSV 기반 4채널 VBAP 공간 음향 합성 진행 중...")
                traj_data = load_trajectory_csv(cur_csv_path)
                rendered_4ch, sr = render_spatial_audio(cur_audio_path, traj_data, calibration)
                play_multichannel_audio(rendered_4ch, sr, f"{cur_audio_path.name} + {cur_csv_path.name}")

            elif choice == "4":
                configure_calibration_menu(calibration)

            elif choice == "5":
                if cur_csv_path is None or cur_audio_path is None:
                    print(" [!] 음원과 동선 CSV 파일이 필요합니다.")
                    continue
                traj_data = load_trajectory_csv(cur_csv_path)
                rendered_4ch, sr = render_spatial_audio(cur_audio_path, traj_data, calibration)
            
                out_name = f"rendered_4ch_{cur_csv_path.stem}.wav"
                out_file = BASE_DIR / out_name
                sf.write(str(out_file), rendered_4ch, sr, subtype="FLOAT")
                print(f"\n ✅ 4채널 오디오 파일 저장 완료!")
                print(f"    - 저장 경로: {out_file.resolve()}")
                print(f"    - 채널 수  : 4 채널 (FL, FR, RL, RR)")
                print(f"    - 샘플 레이트: {sr} Hz (32-bit Float WAV)")
                print("    * Blender, DAW(Reaper, Pro Tools), Unreal Engine에 직접 임포트 가능합니다.")

            elif choice == "6":
                print("\n [파일 변경 메뉴]")
                print("  1. 동선 CSV 선택 (1: object_path_1, 2: object_path_2, 3: object_path_3, 4: object_path_4)")
                print("  2. 음원 파일 선택 (1: Moving_sound.wav, 2: channel_test.wav, 3: Heli_sound.wav)")
                f_sel = input(" 선택: ").strip()
                if f_sel == "1":
                    idx = input(" 동선 번호 (1-4): ").strip()
                    cand = resolve_file([f"Sample/동선/object_path_{idx}.csv", f"object_path_{idx}.csv"])
                    if cand:
                        cur_csv_path = cand
                        print(f" >> 동선 변경됨: {cur_csv_path.name}")
                    else:
                        print(" [!] 파일을 찾을 수 없습니다.")
                elif f_sel == "2":
                    w_sel = input(" 음원 번호 (1:Moving, 2:Channel, 3:Heli): ").strip()
                    mapping = {"1": "Moving_sound.wav", "2": "channel_test.wav", "3": "Heli_sound.wav"}
                    fname = mapping.get(w_sel, "Moving_sound.wav")
                    cand = resolve_file([f"Sample/음원 및 영상/{fname}", fname])
                    if cand:
                        cur_audio_path = cand
                        print(f" >> 음원 변경됨: {cur_audio_path.name}")
                    else:
                        print(" [!] 파일을 찾을 수 없습니다.")

            elif choice == "7":
                studio_html = BASE_DIR / "xr_sound_studio.html"
                if studio_html.is_file():
                    print(" 🌐 웹 스튜디오를 브라우저에서 실행합니다...")
                    webbrowser.open(str(studio_html))
                else:
                    print(" [!] xr_sound_studio.html 파일을 찾을 수 없습니다.")

            elif choice == "0":
                print("\n 프로그램을 종료합니다. 수고하셨습니다!")
                break
        except (ValueError, OSError, sd.PortAudioError) as error:
            # 잘못된 CSV·없는 파일·오디오 장치 오류가 나도 메뉴로 돌아온다
            print(f" [!] {error}")

if __name__ == "__main__":
    main()

