# XR 사운드 디자인 실습 파일

| 파일 | 내용 |
| --- | --- |
| `xr_sound_studio.html` | 통합 웹 스튜디오 (4채널 테스트, 동선 시각화, 영상 방향 분석, SAM 2 추적, 믹스). 브라우저로 연다 |
| `channel_test_b64.js`, `moving_sound_b64.js`, `presets.js` | 스튜디오가 읽는 기본 음원과 동선 프리셋. HTML과 같은 폴더에 둔다 |
| `xr_sound_design.py` | 터미널판 1회차 프로그램 (채널 테스트, 동선 렌더링, 4채널 WAV 저장) |
| `sam2_server.py` | 스튜디오의 'SAM 2 영상 대상 추적'이 쓰는 로컬 서버 |
| `run_xr_sound_design.bat`, `start_sam2_server.bat` | Windows용 실행 파일 (더블클릭) |
| `settings_format.md`, `settings_template.json` | 3회차 설정 JSON 형식과 빈 틀 |

## Windows

[python.org](https://www.python.org)에서 Python을 설치한 뒤 `.bat` 파일을 더블클릭한다. 처음 실행할 때 `.venv-win/`에 필요한 패키지를 자동으로 설치한다 (인터넷 필요, SAM 2는 몇 분 걸림).

- `run_xr_sound_design.bat`: 터미널판 1회차 프로그램
- `start_sam2_server.bat`: SAM 2 서버. 창을 켜 둔 채로 스튜디오에서 'SAM 2 서버 연결'

NVIDIA GPU가 있으면 GPU용 torch(CUDA 13.2)를 받는다. GPU 드라이버가 오래돼 서버 창에 `cpu`라고 나오면 드라이버를 업데이트한 뒤 `.venv-win` 폴더를 지우고 다시 실행한다.

## macOS

```bash
python3 -m venv .venv
.venv/bin/pip install numpy soundfile sounddevice          # xr_sound_design.py용
.venv/bin/pip install setuptools wheel torch torchvision   # SAM 2용 (아래 줄까지)
SAM2_BUILD_CUDA=0 .venv/bin/pip install --no-build-isolation pillow https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip

.venv/bin/python xr_sound_design.py
.venv/bin/python sam2_server.py   # 켜 둔 채로 스튜디오에서 'SAM 2 서버 연결'
```

맥에는 NVIDIA GPU가 없어 SAM 2가 CPU로 돈다 (M1 기준 프레임당 2~3초).

## 파일 위치

- `xr_sound_design.py`는 음원과 동선 CSV를 `Sample/음원 및 영상/`, `Sample/동선/`에서 찾는다 (`ISAD_1회차/Sample/`도 찾음).
- `sam2_server.py`는 처음 실행할 때 `checkpoints/`에 모델을 받고, 추적 데이터를 `sam2_tracker_data/`에 저장한다.
