@echo off
REM Thin wrapper around make.ps1 for users who don't want to think
REM about PowerShell execution policy. Forwards every arg.
REM
REM Usage:
REM   build.bat              ; build + test
REM   build.bat publish      ; publish self-contained win-x64 build
REM   build.bat test         ; just tests
REM   build.bat clean

SETLOCAL
SET "SCRIPT_DIR=%~dp0"
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%make.ps1" %*
EXIT /B %ERRORLEVEL%
