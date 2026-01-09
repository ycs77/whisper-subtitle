@echo off

cd /d "%~dp0"
node srt-to-txt.js "%~1"
