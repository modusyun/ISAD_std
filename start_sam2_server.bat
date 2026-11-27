@echo off
chcp 65001 > nul
title SAM 2 영상 대상 추적 서버
cd /d "%~dp0"
set "PY=.venv-win\Scripts\python.exe"

if exist "%PY%" goto check
echo 처음 실행: Python 가상환경을 만듭니다...
py -3 -m venv .venv-win 2> nul || python -m venv .venv-win
if not exist "%PY%" goto no_python

:check
"%PY%" -c "import sam2" 2> nul && goto run
echo SAM 2를 설치합니다. 처음 한 번만, 몇 분 걸립니다...
"%PY%" -m pip install --upgrade pip setuptools wheel
rem NVIDIA GPU가 있으면 GPU용 torch를 받는다. 기본 pip torch는 Windows에서 CPU 전용이다
set "TORCH_INDEX="
where nvidia-smi > nul 2> nul && set "TORCH_INDEX=--index-url https://download.pytorch.org/whl/cu132"
"%PY%" -m pip install torch torchvision %TORCH_INDEX%
if errorlevel 1 goto install_failed
rem git 없이 zip으로 받는다. CUDA 확장은 선택 기능이라 빌드하지 않는다
set SAM2_BUILD_CUDA=0
"%PY%" -m pip install --no-build-isolation pillow https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip
if errorlevel 1 goto install_failed

:run
"%PY%" sam2_server.py %*
pause
exit /b

:no_python
echo [오류] Python을 찾을 수 없습니다. https://www.python.org 에서 설치한 뒤 다시 실행하세요.
pause
exit /b 1

:install_failed
echo [오류] 설치에 실패했습니다. 위 메시지를 확인하세요. 인터넷 연결이 필요합니다.
pause
exit /b 1
