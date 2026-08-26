@echo off
cd /d "D:\Projects\WhatsappPaymentReaderV2"
taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq WhatsApp*" >nul 2>&1
del /q "session\Singleton*" >nul 2>&1
if not exist logs mkdir logs
node app.js >> "logs\run.log" 2>&1