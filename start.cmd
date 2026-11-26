@echo off
rem Starts the "Foto til 3D" app: double-click this file.
title Foto til 3D
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 pause
