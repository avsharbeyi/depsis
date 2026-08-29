@echo off
rem DEPSIS lisans verme — cift tiklanir.
rem
rem chcp 65001: cmd.exe varsayilan kod sayfasinda Turkce harfler bozuk cikiyor.
chcp 65001 >nul
node "%~dp0lisans-ver.mjs" %*
echo.
pause
