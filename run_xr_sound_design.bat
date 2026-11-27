@echo off
chcp 65001 > nul
title XR 사운드 디자인 1회차
cd /d "%~dp0"
set "PY=.venv-win\Scripts\python.exe"

if exist "%PY%" goto check
echo 처음 실행: Python 가상환경을 만듭니다...
py -3 -m venv .venv-win 2> nul || python -m venv .venv-win
if not exist "%PY%" goto no_python

:check
"%PY%" -c "import numpy, soundfile, sounddevice" 2> nul && goto run
echo 필요한 패키지를 설치합니다 (처음 한 번)...
"%PY%" -m pip install numpy soundfile sounddevice
if errorlevel 1 goto install_failed

:run
"%PY%" xr_sound_design.py
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
