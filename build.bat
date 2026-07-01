@echo off
chcp 65001 >nul 2>&1
echo ========================================
echo   API Key Manager - 打包脚本
echo ========================================
echo.

set "ELECTRON_CACHE=%~dp0.electron-cache"
set "TEMP=%~dp0.tmp"
set "TMP=%~dp0.tmp"

echo [1/3] 正在检查 Electron...
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
    echo Electron 未安装，正在下载（使用淘宝镜像）...
    call npm install electron --prefix "%~dp0" --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo [错误] Electron 下载失败，请手动运行: npm install electron
        pause
        exit /b 1
    )
) else (
    echo Electron 已安装，跳过下载
)
echo.

echo [2/3] 正在启动打包...
call npx electron-builder --win --x64 --publish never 2>&1
echo.

if errorlevel 1 (
    echo [错误] 打包失败
    pause
    exit /b 1
)

echo [3/3] 打包完成！
echo.
echo 安装包位置:
dir /b "%~dp0dist\*.exe" 2>nul
dir /b "%~dp0dist\*.msi" 2>nul
echo.
echo 按任意键打开 dist 文件夹...
pause >nul
explorer "%~dp0dist"
