; QuietMusic NSIS 安装钩子（tauri.conf.json -> bundle.windows.nsis.installerHooks）。
;
; 背景：应用更名（LightListen -> QuietMusic）后，主程序从 lightlisten.exe 变成
; quietmusic.exe。Tauri 的 /UPDATE 就地覆盖模式只按新构建的文件清单安装，不会主动
; 删掉旧名字的 lightlisten.exe，升级后安装目录里会残留一个 12MB 的僵尸 exe。
; 这里在写入文件之前把它清掉，让更新保持干净（也覆盖从 1.0.2 及更早直接升级的场景）。

!macro NSIS_HOOK_PREINSTALL
  ; $INSTDIR 在更新模式下会从注册表恢复成既有安装目录
  IfFileExists "$INSTDIR\lightlisten.exe" 0 +2
  Delete "$INSTDIR\lightlisten.exe"
!macroend
