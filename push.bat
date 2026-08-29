@echo off
cd /d "%~dp0"
echo Pushing jcjh-timetable to GitHub...
git push origin main --force

echo.
echo Pushing AI_Agent to GitHub...
cd /d "%~dp0..\..\..\.."
git push origin main --force

echo.
echo SUCCESS! All repositories pushed!
pause
