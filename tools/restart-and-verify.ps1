# Relaunch DSH from inside DSH, then verify what the new process is serving.
#
#   powershell -File tools/restart-and-verify.ps1 -Force                  # 12s delay
#   powershell -File tools/restart-and-verify.ps1 -Force -DelaySeconds 0   # right now
#
# **-Force is required on purpose.** The operator asked for "不要随便重启", and a
# restart is not a side effect of finishing some code: it drops every live session's
# agent (including the turn that asked for it) and every in-flight tool call. So the
# default is to print what it *would* do and exit 2 — an agent has to be told to
# restart, not decide it on its own.
#
# What it does, once allowed:
#
#  1. Restarting the server kills the very process this agent runs in, so the tool
#     call that started it can never return. Running the restart DETACHED (and
#     after a short delay) lets the current turn finish and deliver its answer
#     first, while the restart still happens afterwards.
#  2. "I edited the files" is not "the running instance serves them" — Node's ESM
#     registry caches modules by URL and the Host builds each client bundle once at
#     boot. `--log` captures the server's own startup output (including the
#     authenticated URL and the plugin's build hash), and `verify-live.py` turns
#     that into PASS/FAIL lines written next to it.
#
# Both outputs land in the log file, so the result is readable on the next turn
# even though nothing survived to print it.
#
# NOTE: the captured server log holds the authenticated URL, i.e. a browser token.
# It is a credential: keep it in $DSH_HOME, and delete it when you are done.

param(
    [int]$DelaySeconds = 12,
    [string]$ServerLog = '',
    [string]$ReportLog = '',
    [switch]$Force
)

$ErrorActionPreference = 'Continue'
$pluginRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ServerLog)) {
    $home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $ServerLog = Join-Path $home_ 'logs\dsh-web.log'
}
if ([string]::IsNullOrWhiteSpace($ReportLog)) {
    $home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $ReportLog = Join-Path $home_ 'logs\restart-remote.log'
}
if (-not $Force) {
    Write-Host 'Refusing to restart without an explicit go-ahead.'
    Write-Host "  would stop the dsh web listening on port 3080 (and end the turn that called this),"
    Write-Host "  relaunch it from the recorded serverCwd after $DelaySeconds s, then run tools/verify-live.py."
    Write-Host '  re-run with -Force when the operator actually asked for a restart.'
    exit 2
}
foreach ($path in @($ServerLog, $ReportLog)) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

Set-Location $pluginRoot
"[$(Get-Date -Format o)] restarting DSH so lib/*.js changes go live" | Out-File -FilePath $ReportLog -Encoding utf8 -Append
& python tools/restart-dsh.py --log $ServerLog *>> $ReportLog
"[$(Get-Date -Format o)] restart-dsh.py exit=$LASTEXITCODE" | Out-File -FilePath $ReportLog -Encoding utf8 -Append

# Give the new server a moment to finish printing its startup banner.
Start-Sleep -Seconds 3
"[$(Get-Date -Format o)] verifying the live instance" | Out-File -FilePath $ReportLog -Encoding utf8 -Append
& python tools/verify-live.py --log $ServerLog *>> $ReportLog
"[$(Get-Date -Format o)] verify-live.py exit=$LASTEXITCODE" | Out-File -FilePath $ReportLog -Encoding utf8 -Append
