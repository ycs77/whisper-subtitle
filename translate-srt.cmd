@echo off

cd /d "%~dp0"
node translate-srt.js %*
