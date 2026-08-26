@echo off
title WhatsApp Payment Reader - RE-LOGIN

set PROJECT=D:\Projects\WhatsappPaymentReaderV2

cd /d "%PROJECT%" || (echo Could not find %PROJECT% & pause & exit /b 1)

echo ================================
echo  RE-LOGIN
echo.
echo  Use this only when a run reports that the
echo  session has expired and shows the QR screen.
echo.
echo  A browser will open. Scan the QR code with:
echo    WhatsApp - Settings - Linked devices - Link a device
echo.
echo  Wait until your chats have loaded, then press
echo  Enter in THIS window to save the session.
echo ================================
echo.

REM Anything still holding the profile will block the launch.
taskkill /F /IM node.exe >nul 2>&1
del /q "session\Singleton*" >nul 2>&1

node login.js

echo.
echo Done. Press any key to close.
pause >nul
