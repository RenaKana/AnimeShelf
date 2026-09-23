@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launcher.ps1"
exit /b %errorlevel%
