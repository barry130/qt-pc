# Offline fix-up: the Tauri-generated NSIS artifacts depend on the nsis_tauri_utils
# plugin and on the Win/RestartManager.nsh header. Neither is available offline, so
# replace those parts with plain-NSIS equivalents to let the 1.1.0 installer be built
# with the locally cached NSIS 3.04.
# Only files under src-tauri/target/ (build artifacts) are modified.

$ErrorActionPreference = 'Stop'
$dir = "F:\qtMusic\qt-pc\src-tauri\target\release\nsis\x64"
$utf8 = New-Object System.Text.UTF8Encoding($false)

# ---------- 1) utils.nsh: replace the CheckIfAppIsRunning macro ----------
$newMacro = @'
!macro CheckIfAppIsRunning executablePath productName
  ; [offline-build] Plugin-free replacement. The upstream macro calls
  ; nsis_tauri_utils::StrReplace and the RestartManager_* macros; neither is
  ; available when building offline (the plugin DLL cannot be downloaded and
  ; NSIS 3.04 has no Win/RestartManager.nsh). Behaviour is preserved:
  ; detect the running app, offer to terminate it, abort when it survives.
  !define UniqueID ${__LINE__}

  ; tasklist piped into find: exit code 0 means the process is running
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
  Pop $0
  Pop $1
  StrCmp $0 "0" app_is_running_${UniqueID} app_check_done_${UniqueID}

  app_is_running_${UniqueID}:
    IfSilent kill_app_${UniqueID} ask_user_${UniqueID}

  ask_user_${UniqueID}:
    MessageBox MB_OKCANCEL "$(appRunningOkKill)" IDOK kill_app_${UniqueID} IDCANCEL cancel_install_${UniqueID}

  kill_app_${UniqueID}:
    nsExec::ExecToStack 'cmd /c taskkill /F /IM ${MAINBINARYNAME}.exe'
    Pop $0
    Pop $1
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
    Pop $0
    Pop $1
    StrCmp $0 "0" kill_failed_${UniqueID} app_check_done_${UniqueID}

  kill_failed_${UniqueID}:
    IfSilent kill_failed_silent_${UniqueID} kill_failed_ui_${UniqueID}

  kill_failed_silent_${UniqueID}:
    DetailPrint "$(failedToKillApp)"
    Abort

  kill_failed_ui_${UniqueID}:
    Abort "$(failedToKillApp)"

  cancel_install_${UniqueID}:
    Abort "$(appRunning)"

  app_check_done_${UniqueID}:
    !undef UniqueID
!macroend
'@

$u = Join-Path $dir "utils.nsh"
$t = [System.IO.File]::ReadAllText($u)
$before = ([regex]::Matches($t, 'nsis_tauri_utils')).Count
$start = $t.IndexOf('!macro CheckIfAppIsRunning')
$endMark = '!macroend'
$end = $t.IndexOf($endMark, $start) + $endMark.Length
$t = $t.Substring(0, $start) + $newMacro.TrimEnd() + $t.Substring($end)
$after = ([regex]::Matches($t, 'nsis_tauri_utils')).Count
[System.IO.File]::WriteAllText($u, $t, $utf8)
Write-Output "[utils.nsh] nsis_tauri_utils refs: $before -> $after"

# ---------- 2) installer.nsi: supply the 2 required macro arguments ----------
$i = Join-Path $dir "installer.nsi"
$t2 = [System.IO.File]::ReadAllText($i)
$t2 = $t2 -replace '!insertmacro CheckIfAppIsRunning(?!")', '!insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"'
[System.IO.File]::WriteAllText($i, $t2, $utf8)
Write-Output "[installer.nsi] call sites updated:"
Select-String -Path $i -Pattern '!insertmacro CheckIfAppIsRunning' | ForEach-Object { "  $($_.LineNumber): $($_.Line.Trim())" }

# ---------- 3) language files: no runtime StrReplace any more ----------
Get-ChildItem $dir -Filter "*.nsh" | ForEach-Object {
  $p = $_.FullName
  $c = [System.IO.File]::ReadAllText($p)
  if ($c.Contains('{{product_name}}')) {
    $n = ([regex]::Matches($c, '\{\{product_name\}\}')).Count
    $c = $c.Replace('{{product_name}}', 'QuietMusic')
    [System.IO.File]::WriteAllText($p, $c, $utf8)
    Write-Output "[$($_.Name)] {{product_name}} x$n -> QuietMusic"
  }
}

# ---------- 4) confirm no plugin call remains ----------
Write-Output "=== remaining plugin calls (empty = none) ==="
Select-String -Path (Join-Path $dir "*.nsi"), (Join-Path $dir "*.nsh") -Pattern 'nsis_tauri_utils::' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }
Write-Output "=== done ==="
