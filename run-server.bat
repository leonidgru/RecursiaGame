@echo off
chcp 65001 >nul
echo ==========================================================
echo   מפעיל שרת חידון כיתתי ב-C# (פורט 5050 - פתוח לסריקת QR)
echo ==========================================================
cd /d "%~dp0"
start "" "http://localhost:5050"
dotnet run --project "NestedForQuiz.csproj"
pause
