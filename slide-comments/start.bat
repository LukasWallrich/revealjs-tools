@echo off
REM Double-click this file on Windows to launch the slide-comments server.
cd /d "%~dp0"
where py >NUL 2>&1
if %ERRORLEVEL%==0 (
  py server.py %*
  goto :eof
)
where python >NUL 2>&1
if %ERRORLEVEL%==0 (
  python server.py %*
  goto :eof
)
echo Python 3 not found. Install from https://www.python.org/ and try again.
pause
