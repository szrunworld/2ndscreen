<#
.SYNOPSIS
  End-to-end acceptance test for 2ndscreen on Windows.

.DESCRIPTION
  Starts the tray app, creates an agent screen, launches TestTarget.exe (a tiny
  window with a text box and a button) onto it, checks that the window is there
  and that the user's foreground was left alone, takes a screenshot, clicks and
  types through cua-driver unless -SkipDriver, checks the MCP server, and cleans
  up. Prints PASS/FAIL per check and exits non-zero if any check failed.

  Run from the folder holding SecondScreen.exe, 2ndscreen.exe and TestTarget.exe:
    powershell -ExecutionPolicy Bypass -File e2e.ps1 [-Bin .\publish] [-Out .\e2e-out]
#>
[CmdletBinding()]
param(
    [string] $Bin = ".",
    [string] $Out = ".\e2e-out",
    [switch] $SkipDriver
)
$ErrorActionPreference = "Continue"
$Bin = (Resolve-Path $Bin).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$cli = Join-Path $Bin "2ndscreen.exe"
$app = Join-Path $Bin "SecondScreen.exe"
$target = Join-Path $Bin "TestTarget.exe"
$results = New-Object System.Collections.Generic.List[object]

function Check([string] $name, [bool] $ok, [string] $detail = "") {
    $results.Add([pscustomobject]@{ Check = $name; Result = $(if ($ok) { "PASS" } else { "FAIL" }); Detail = $detail })
    Write-Host ("[{0}] {1} {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail)
}

function Cli([string[]] $arguments) {
    $text = & $cli @arguments 2>&1 | Out-String
    try { return $text | ConvertFrom-Json } catch { return [pscustomobject]@{ ok = $false; error = $text.Trim() } }
}

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint Pid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
}
"@

# 1. App and control pipe.
Get-Process SecondScreen -ErrorAction SilentlyContinue | Stop-Process -Force
$appProcess = Start-Process $app -PassThru
$list = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $list = Cli @("screen", "list")
    if ($list.ok) { break }
}
Check "app starts and serves the control pipe" ([bool]$list.ok) $list.error

$virtual = Get-PnpDevice -FriendlyName "*Virtual Display*" -ErrorAction SilentlyContinue | Where-Object Status -eq "OK"
Check "Virtual Display Driver present" ([bool]$virtual) $(if ($virtual) { $virtual[0].InstanceId } else { "not installed; screen checks will fail" })

# 2. Create an agent screen.
$created = Cli @("screen", "create", "--name", "e2e", "--size", "1280x800", "--no-hidpi", "--ttl", "10m")
$frame = $created.screen.frame
Check "screen create" ([bool]$created.ok) $(if ($created.ok) { "frame $($frame.x),$($frame.y) $($frame.width)x$($frame.height)" } else { $created.error })
Check "screen has the requested size" ($created.ok -and $frame.width -eq 1280 -and $frame.height -eq 800)
Add-Type -AssemblyName System.Windows.Forms
$monitors = [System.Windows.Forms.Screen]::AllScreens
Check "Windows reports the new monitor" ([bool]($monitors | Where-Object { $_.Bounds.Width -eq 1280 -and $_.Bounds.Height -eq 800 })) (($monitors | ForEach-Object { "$($_.DeviceName) $($_.Bounds)" }) -join "; ")

# 3. Launch the test window onto it without taking the foreground.
$frontBefore = [Fg]::Pid()
$launched = Cli @("app", "launch", "--screen", "e2e", "--path", $target)
Start-Sleep -Seconds 1
$frontAfter = [Fg]::Pid()
$targetPid = $launched.pid
$window = $launched.windows | Select-Object -First 1
$onScreen = $launched.ok -and $window -and $window.frame.x -ge $frame.x -and $window.frame.x -lt ($frame.x + $frame.width)
Check "app launch onto the screen" ([bool]$onScreen) $(if ($launched.ok) { "pid $targetPid window $($window.windowID) at $($window.frame.x),$($window.frame.y)" } else { $launched.error })
Check "foreground left alone" ($frontAfter -ne $targetPid) "foreground pid before $frontBefore, after $frontAfter"

# 4. Guards.
$refused = Cli @("window", "move", "--screen", "nope", "--pid", "$targetPid")
Check "unknown screen is refused" (-not $refused.ok) $refused.error
$again = Cli @("app", "launch", "--screen", "e2e", "--path", $target)
Check "already-running program is refused without --new-instance" (-not $again.ok) $again.error

# 5. Screenshot.
$shot = Join-Path $Out "e2e-screen.png"
$taken = Cli @("screenshot", "--screen", "e2e", "--output", $shot)
$size = if (Test-Path $shot) { Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile($shot); "$($img.Width)x$($img.Height)"; $img.Dispose() } else { "missing" }
Check "screenshot" ($taken.ok -and $size -eq "1280x800") "$size $($taken.error)"

# 6. Typing through cua-driver, if installed.
if (-not $SkipDriver) {
    $state = Cli @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "state reads the window" ([bool]($state.ok -and $state.elements.Count -gt 0)) "$($state.elements.Count) elements $($state.error)"
    $clicked = Cli @("click", "--screen", "e2e", "--pid", "$targetPid", "--text", "Press me")
    Start-Sleep -Milliseconds 500
    $state = Cli @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "click through cua-driver" ([bool]($clicked.ok -and $state.tree -match "Pressed 1")) "$($clicked.effect) $($clicked.error)"
    $typed = Cli @("type", "--screen", "e2e", "--pid", "$targetPid", "--text", "Input", "--value", "hello from 2ndscreen")
    Start-Sleep -Milliseconds 500
    $state = Cli @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "type through cua-driver" ([bool]($typed.ok -and $state.tree -match "hello from 2ndscreen")) "$($typed.effect) $($typed.error)"
    Check "foreground still left alone" ([Fg]::Pid() -ne $targetPid)
    Cli @("screenshot", "--screen", "e2e", "--output", (Join-Path $Out "e2e-typed.png")) | Out-Null
}

# 7. MCP.
$requests = @(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"screen_list","arguments":{}}}'
) -join "`n"
$mcp = $requests | & $cli mcp | ForEach-Object { $_ | ConvertFrom-Json }
$tools = ($mcp | Where-Object id -eq 2).result.tools.name
Check "mcp lists tools" ($tools.Count -eq 10) ($tools -join ",")
Check "mcp screen_list" (-not ($mcp | Where-Object id -eq 3).result.isError)

# 8. Cleanup: destroying the screen moves the test window back to a real display.
$destroyed = Cli @("screen", "destroy", "e2e")
Start-Sleep -Seconds 1
$after = Cli @("screen", "list")
Check "screen destroy" ([bool]($destroyed.ok -and -not ($after.screens | Where-Object name -eq "e2e")))
if ($targetPid) { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue }
$appProcess | Stop-Process -Force -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize | Out-String | Set-Content (Join-Path $Out "e2e-results.txt")
if ($env:GITHUB_STEP_SUMMARY) {
    "| Check | Result | Detail |`n|---|---|---|" | Add-Content $env:GITHUB_STEP_SUMMARY
    $results | ForEach-Object { "| $($_.Check) | $($_.Result) | $($_.Detail -replace '\|', '/') |" } | Add-Content $env:GITHUB_STEP_SUMMARY
}
$failed = @($results | Where-Object Result -eq "FAIL").Count
Write-Host "$($results.Count - $failed) passed, $failed failed"
exit $(if ($failed) { 1 } else { 0 })
