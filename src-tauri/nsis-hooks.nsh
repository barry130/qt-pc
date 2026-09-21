; QuietMusic NSIS 安装钩子（tauri.conf.json -> bundle.windows.nsis.installerHooks）。
;
; 用途一：清理更名前的旧可执行文件。
;   应用更名（LightListen -> QuietMusic）后主程序从 lightlisten.exe 变成 quietmusic.exe。
;   Tauri 的 /UPDATE 就地覆盖模式只按新构建的文件清单安装，不会主动删掉旧名字的
;   lightlisten.exe，升级后安装目录里会残留一个 12MB 的僵尸 exe。写入文件前先清掉。
;
; 用途二：把快捷方式显示名改成中文「轻听」。
;   Tauri 的 NSIS 模板用 ${PRODUCTNAME}（= QuietMusic）同时当「安装目录名 / 注册表键名 /
;   快捷方式名 / 卸载项显示名」。前两者不能动——动了 1.0.4 装在同名目录里的版本就认不出来，
;   就地升级会变成另装一份。所以只在安装完成后把快捷方式换成中文名，并覆盖控制面板显示名。
;
;   注意两个模板行为：
;   1) 更新模式（$UpdateMode=1）下 CreateOrUpdate*Shortcut 会直接 return，不会改名，
;      所以必须在这里显式重建，不能指望模板。
;   2) 全新安装时结束页的 CreateOrUpdateDesktopShortcut 在本钩子之后才执行，会再建一个
;      英文名快捷方式。故这里置 $NoShortcutMode=1 让它提前 return（中文名已由本钩子建好）。
;
; 编码：本文件必须保存为 UTF-8 带 BOM，否则 makensis 读不到中文。

; 在 ${DIR} 目录下把英文名快捷方式换成中文「轻听」，指向当前主程序。
; 用重建而非改名：更新模式下旧快捷方式可能不存在，且需修正指向的 exe 名。
!macro QuietMusic_MakeShortcut DIR
  ; 清掉英文名（含 LightListen 时代的遗留）
  Delete "${DIR}\${PRODUCTNAME}.lnk"
  Delete "${DIR}\LightListen.lnk"
  ; 重建为中文名（已存在则覆盖）
  CreateShortcut "${DIR}\轻听.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ; 与模板保持一致：写入 AppUserModelID，保证任务栏分组/通知归属正确
  !insertmacro SetLnkAppUserModelId "${DIR}\轻听.lnk"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; $INSTDIR 在更新模式下会从注册表恢复成既有安装目录
  IfFileExists "$INSTDIR\lightlisten.exe" 0 +2
  Delete "$INSTDIR\lightlisten.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ---- 快捷方式改为中文「轻听」 ----
  !insertmacro QuietMusic_MakeShortcut "$DESKTOP"

  ; 开始菜单：$AppStartMenuFolder 由 MUI_STARTMENU_GETFOLDER 从注册表恢复
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  ${If} $AppStartMenuFolder == ""
    StrCpy $AppStartMenuFolder "${PRODUCTNAME}"
  ${EndIf}
  !insertmacro QuietMusic_MakeShortcut "$SMPROGRAMS\$AppStartMenuFolder"

  ; 抑制结束页再建英文名桌面快捷方式（中文名已建好，避免桌面上出现两个图标）
  StrCpy $NoShortcutMode 1

  ; ---- 控制面板「程序和功能」显示名改为「轻听」 ----
  ; 注册表键名仍是 QuietMusic（UNINSTKEY 不可变），只覆盖对用户可见的 DisplayName
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "轻听"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时清掉中文名快捷方式（模板只认 ${PRODUCTNAME}.lnk，不管这个）
  Delete "$DESKTOP\轻听.lnk"
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  ${If} $AppStartMenuFolder != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\轻听.lnk"
  ${EndIf}
  Delete "$SMPROGRAMS\轻听.lnk"
!macroend
