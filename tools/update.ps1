<#
.SYNOPSIS
  Installs or updates Stop The Slop from the latest GitHub release.
.DESCRIPTION
  Downloads the newest release zip and extracts it into a stable folder that
  survives repo rebuilds. Chromium cannot hot-swap an unpacked extension, so
  the new files take effect when you restart the browser (or hit Reload on the
  extension in opera://extensions).
.PARAMETER InstallDir
  Where the unpacked extension lives. Point your browser's "Load unpacked" here.
.PARAMETER Schedule
  Also register a daily scheduled task that runs this script.
.PARAMETER Force
  Reinstall even when the installed version already matches the latest release.
#>
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\StopTheSlop\extension",
  [switch]$Schedule,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = 'Deaeath/stop-the-slop'

function Get-InstalledVersion {
  $mf = Join-Path $InstallDir 'manifest.json'
  if (-not (Test-Path $mf)) { return $null }
  try { (Get-Content $mf -Raw | ConvertFrom-Json).version } catch { $null }
}

Write-Host "Stop The Slop updater"
Write-Host "  install dir: $InstallDir"

$installed = Get-InstalledVersion
Write-Host "  installed  : $(if ($installed) { "v$installed" } else { '(nothing yet)' })"

$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" `
                         -Headers @{ 'User-Agent' = 'stop-the-slop-updater' }
$latest = $rel.tag_name -replace '^v', ''
$asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $asset) { throw "Release $($rel.tag_name) has no zip asset" }
Write-Host "  latest     : v$latest"

if ($installed -eq $latest -and -not $Force) {
  Write-Host "Already up to date."
} else {
  $tmp = Join-Path $env:TEMP "sts-update-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp 'release.zip'

  Write-Host "  downloading $($asset.name) ..."
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'unpacked') -Force

  $newManifest = Join-Path $tmp 'unpacked\manifest.json'
  if (-not (Test-Path $newManifest)) { throw "Downloaded zip has no manifest.json - refusing to install" }

  # Replace contents in place so the browser keeps pointing at the same folder.
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Get-ChildItem $InstallDir -Force | Remove-Item -Recurse -Force
  Copy-Item (Join-Path $tmp 'unpacked\*') $InstallDir -Recurse -Force
  Remove-Item $tmp -Recurse -Force

  Write-Host "  installed v$(Get-InstalledVersion)"
  Write-Host "Restart the browser (or click Reload on the extension) to apply."
}

if ($Schedule) {
  $taskName = 'StopTheSlop Update'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallDir `"$InstallDir`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 9am
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Description 'Keeps the Stop The Slop browser extension up to date' -Force | Out-Null
  Write-Host "Scheduled daily update task registered as '$taskName'."
}

Write-Host ""
Write-Host "Load unpacked from: $InstallDir"
