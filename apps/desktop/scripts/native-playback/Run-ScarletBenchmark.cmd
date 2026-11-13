@echo off
where py.exe >nul 2>nul
if errorlevel 1 goto plainpython
py -3 "%~dp0driver\windows-suite.py" %*
exit /b %errorlevel%
:plainpython
python.exe "%~dp0driver\windows-suite.py" %*
exit /b %errorlevel%
