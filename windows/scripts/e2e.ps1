<#
.SYNOPSIS
  End-to-end acceptance test for 2ndscreen on Windows.

.DESCRIPTION
  Starts the tray app, creates an agent screen, launches TestTarget.exe (a tiny
  window with a text box and a button) onto it, checks that the window is there
  and that the user's foreground was left alone, takes a screenshot, clicks,
  types, scrolls and drags in the background, checks the MCP server, and cleans
  up. Prints PASS/FAIL per check and exits non-zero if any check failed.

  Run from the folder holding SecondScreen.exe, 2ndscreen.exe and TestTarget.exe:
    powershell -ExecutionPolicy Bypass -File e2e.ps1 [-Bin .\publish] [-Out .\e2e-out]
#>
[CmdletBinding()]
param(
    [string] $Bin = ".",
    [string] $Out = ".\e2e-out"
)
# 2ndscreen writes UTF-8 to pipes; Windows PowerShell would read the console code page.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# Read monitor bounds and the pointer in physical pixels, as 2ndscreen reports them,
# rather than scaled for the main display.
Add-Type -Name Dpi -Namespace SecondScreenE2e -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);'
[SecondScreenE2e.Dpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
$ErrorActionPreference = "Continue"
$Bin = (Resolve-Path $Bin).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$cli = Join-Path $Bin "2ndscreen.exe"
$app = Join-Path $Bin "SecondScreen.exe"
$target = Join-Path $Bin "TestTarget.exe"
$results = New-Object System.Collections.Generic.List[object]

function Check([string] $name, [bool] $ok, [string] $detail = "") {
    $result = if ($ok) { "PASS" } else { "FAIL" }
    $results.Add([pscustomobject]@{ Check = $name; Result = $result; Detail = $detail })
    Write-Host "[$result] $name $detail"
}

# A check whose precondition failed is skipped, not passed or failed.
function Skip([string] $name, [string] $why) {
    $results.Add([pscustomobject]@{ Check = $name; Result = "SKIP"; Detail = $why })
    Write-Host "[SKIP] $name $why"
}

function Invoke-2ndscreen([string[]] $arguments) {
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

function Start-App {
    Get-Process SecondScreen -ErrorAction SilentlyContinue | Stop-Process -Force
    $process = Start-Process $app -PassThru
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if ((Invoke-2ndscreen @("screen", "list")).ok) { break }
    }
    return $process
}

# 1. App and control pipe.
$appProcess = Start-App
$list = Invoke-2ndscreen @("screen", "list")
Check "app starts and serves the control pipe" ([bool]$list.ok) $list.error

$doctor = Invoke-2ndscreen @("doctor")
$outputs = @($doctor.virtualOutputs)
Check "Virtual Display Driver provides outputs" ($outputs.Count -gt 0) "$($outputs.Count) outputs; $($doctor.driverSettings)"

# Virtual monitors need a GPU that can render them. Without one (as on CI virtual
# machines) the driver's outputs have no monitor, so stand in an existing display
# and test everything except creating the screen itself.
$standIn = $false
$virtualDevices = @($outputs | ForEach-Object { $_.device })
$hosted = @($doctor.paths | Where-Object { $virtualDevices -contains $_.source -and $_.targetAvailable }).Count -gt 0
if (-not $hosted) {
    $standIn = $true
    $primary = ($doctor.displays | Where-Object primary | Select-Object -First 1).device
    Write-Host "No virtual monitor can attach on this machine; standing in $primary for the agent screen."
    $env:SECONDSCREEN_TEST_DISPLAY = $primary
    $appProcess | Stop-Process -Force -ErrorAction SilentlyContinue
    $appProcess = Start-App
}

# 2. Create an agent screen.
$width = 1280; $height = 800
$created = Invoke-2ndscreen @("screen", "create", "--name", "e2e", "--size", "${width}x${height}", "--no-hidpi", "--ttl", "10m")
$frame = $created.screen.frame
Check "screen create" ([bool]$created.ok) $(if ($created.ok) { "frame $($frame.x),$($frame.y) $($frame.width)x$($frame.height)" } else { $created.error })
if (-not $created.ok) {
    & $cli doctor | Set-Content (Join-Path $Out "doctor-after-create.json")
    Get-Content (Join-Path $Out "doctor-after-create.json") | Write-Host
}
if ($standIn) {
    Skip "screen has the requested size" "no virtual monitor can attach; $primary stands in"
    Skip "Windows reports the new monitor" "no virtual monitor can attach"
    $width = $frame.width; $height = $frame.height
} elseif ($created.ok) {
    Check "screen has the requested size" ($frame.width -eq 1280 -and $frame.height -eq 800) "$($frame.width)x$($frame.height)"
} else {
    Skip "screen has the requested size" "screen create failed"
}
Add-Type -AssemblyName System.Windows.Forms
$monitors = [System.Windows.Forms.Screen]::AllScreens
if (-not $standIn) { Check "Windows reports the new monitor" ([bool]($monitors | Where-Object { $_.Bounds.Width -eq 1280 -and $_.Bounds.Height -eq 800 })) (($monitors | ForEach-Object { "$($_.DeviceName) $($_.Bounds)" }) -join "; ") }

# 3. Launch the test window onto it without taking the foreground.
$frontBefore = [Fg]::Pid()
$launched = Invoke-2ndscreen @("app", "launch", "--screen", "e2e", "--path", $target)
Start-Sleep -Seconds 1
$frontAfter = [Fg]::Pid()
$targetPid = $launched.pid
$window = $launched.windows | Select-Object -First 1
$onScreen = $launched.ok -and $window -and $window.frame.x -ge $frame.x -and $window.frame.x -lt ($frame.x + $frame.width)
Check "app launch onto the screen" ([bool]$onScreen) $(if ($launched.ok) { "pid $targetPid window $($window.windowID) at $($window.frame.x),$($window.frame.y)" } else { $launched.error })
Check "foreground left alone" ($frontAfter -ne $targetPid) "foreground pid before $frontBefore, after $frontAfter"

# 4. Guards. Use this script's own pid, which certainly exists.
$refused = Invoke-2ndscreen @("window", "move", "--screen", "nope", "--pid", "$PID")
Check "unknown screen is refused" ((-not $refused.ok) -and $refused.error -match "no screen named") $refused.error
if ($launched.ok) {
    $again = Invoke-2ndscreen @("app", "launch", "--screen", "e2e", "--path", $target)
    Check "already-running program is refused without --new-instance" ((-not $again.ok) -and $again.error -match "already running") $again.error
    $foreign = Invoke-2ndscreen @("click", "--screen", "e2e", "--pid", "$PID", "--text", "x")
    Check "acting on a window off the screen is refused" ((-not $foreign.ok) -and $foreign.error -match "no window on screen") $foreign.error
} else {
    Skip "already-running program is refused without --new-instance" "launch failed"
    Skip "acting on a window off the screen is refused" "launch failed"
}

# 5. Screenshot.
$shot = Join-Path $Out "e2e-screen.png"
$taken = Invoke-2ndscreen @("screenshot", "--screen", "e2e", "--output", $shot)
$size = if (Test-Path $shot) { Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile($shot); "$($img.Width)x$($img.Height)"; $img.Dispose() } else { "missing" }
if ($created.ok) {
    Check "screenshot" ($taken.ok -and $size -eq "${width}x${height}") "$size $($taken.error)"
} else {
    Skip "screenshot" "screen create failed"
}

# 6. Clicking, typing, scrolling and dragging in the background, if the launch worked.
if (-not $launched.ok) {
    foreach ($name in "state reads the window", "click in the background", "type in the background",
                      "scroll a list in the background", "double-click", "right-click", "drag", "wheel at a point in the background",
                      "wheel at a point with --foreground", "pointer put back after --foreground") {
        Skip $name "launch failed"
    }
} else {
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "state reads the window" ([bool]($state.ok -and $state.elements.Count -gt 0)) "$($state.elements.Count) elements $($state.error)"
    $clicked = Invoke-2ndscreen @("click", "--screen", "e2e", "--pid", "$targetPid", "--text", "Press me")
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "click in the background" ([bool]($clicked.ok -and $state.tree -match "Pressed 1")) "$($clicked.route) $($clicked.error)"
    $typed = Invoke-2ndscreen @("type", "--screen", "e2e", "--pid", "$targetPid", "--text", "Input", "--value", "hello from 2ndscreen")
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "type in the background" ([bool]($typed.ok -and $state.tree -match "hello from 2ndscreen")) "$($typed.route) $($typed.error)"
    # A shortcut in the background: ctrl+a selects the box's text, which typing then replaces.
    $selected = Invoke-2ndscreen @("key", "--screen", "e2e", "--pid", "$targetPid", "--key", "a", "--modifiers", "ctrl")
    $replaced = Invoke-2ndscreen @("type", "--screen", "e2e", "--pid", "$targetPid", "--text", "Input", "--value", "z")
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    $value = ($state.elements | Where-Object label -eq "Input" | Select-Object -First 1).value
    Check "ctrl+a in the background" ([bool]($selected.ok -and $replaced.ok -and $value -eq "z")) "value '$value' $($selected.route) $($selected.error) $($replaced.error)"
    Check "foreground still left alone" ([Fg]::Pid() -ne $targetPid)
    Invoke-2ndscreen @("screenshot", "--screen", "e2e", "--output", (Join-Path $Out "e2e-typed.png")) | Out-Null

    # Scrolling, double- and right-clicks, and drags. TestTarget reports the list's top
    # row as "Top N" and what reached its pad as "Pad idle double right drag".
    $onTarget = @("--screen", "e2e", "--pid", "$targetPid")
    $scrolled = Invoke-2ndscreen (@("scroll") + $onTarget + @("--text", "Rows", "--direction", "down", "--amount", "10"))
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "scroll a list in the background" ([bool]($scrolled.ok -and $state.tree -match "Top [1-9]")) "$($scrolled.route) $($scrolled.error)"
    Check "foreground left alone after scroll" ([Fg]::Pid() -ne $targetPid)

    # Place the pad from the list, which UI Automation names: in TestTarget the list is
    # 200 wide at (20, 130) and the pad's center is at (360, 270), scaled for DPI.
    $rows = ($state.elements | Where-Object label -eq "Rows" | Select-Object -First 1).frame
    if (-not $rows) { Write-Host "elements: $(($state.elements | ForEach-Object { "$($_.role)/$($_.label)" }) -join ', ')" }
    $scale = $rows.width / 200
    $cx = $rows.x + [int]((360 - 20) * $scale); $cy = $rows.y + [int]((270 - 130) * $scale)
    $double = Invoke-2ndscreen (@("click") + $onTarget + @("--x", "$cx", "--y", "$cy", "--double"))
    $right = Invoke-2ndscreen (@("click") + $onTarget + @("--x", "$cx", "--y", "$cy", "--right"))
    $drag = Invoke-2ndscreen (@("drag") + $onTarget + @("--from-x", "$($cx - 80)", "--from-y", "$cy", "--to-x", "$($cx + 80)", "--to-y", "$cy"))
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    Check "double-click" ([bool]($double.ok -and $state.tree -match "Pad idle.* double")) "$($double.route) $($double.error)"
    Check "right-click" ([bool]($right.ok -and $state.tree -match "Pad idle.* right")) "$($right.route) $($right.error)"
    Check "drag" ([bool]($drag.ok -and $state.tree -match "Pad idle.* drag")) "$($drag.route) $($drag.error)"
    Check "foreground left alone after clicks and drag" ([Fg]::Pid() -ne $targetPid)

    # A wheel at a point, in the background: the list was scrolled down above, so scroll back up.
    $listFrame = ($state.elements | Where-Object label -eq "Rows" | Select-Object -First 1).frame
    $lx = $listFrame.x + [int]($listFrame.width / 2); $ly = $listFrame.y + [int]($listFrame.height / 2)
    Add-Type -AssemblyName System.Windows.Forms
    $topBefore = [int]([regex]::Match($state.tree, "Top (\d+)").Groups[1].Value)
    $wheel = Invoke-2ndscreen (@("scroll") + $onTarget + @("--x", "$lx", "--y", "$ly", "--direction", "up", "--amount", "5"))
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    $topAfter = [int]([regex]::Match($state.tree, "Top (\d+)").Groups[1].Value)
    Check "wheel at a point in the background" ([bool]($wheel.ok -and $topAfter -lt $topBefore)) "Top $topBefore -> $topAfter $($wheel.route) $($wheel.error)"
    Check "foreground left alone after the wheel" ([Fg]::Pid() -ne $targetPid)

    # With --foreground the wheel goes through the real pointer, which is put back afterwards.
    $before = [System.Windows.Forms.Cursor]::Position
    $topBefore = $topAfter
    $wheel = Invoke-2ndscreen (@("scroll") + $onTarget + @("--x", "$lx", "--y", "$ly", "--direction", "down", "--amount", "5", "--foreground"))
    $after = [System.Windows.Forms.Cursor]::Position
    Start-Sleep -Milliseconds 500
    $state = Invoke-2ndscreen @("state", "--screen", "e2e", "--pid", "$targetPid")
    $topAfter = [int]([regex]::Match($state.tree, "Top (\d+)").Groups[1].Value)
    Check "wheel at a point with --foreground" ([bool]($wheel.ok -and $topAfter -gt $topBefore)) "Top $topBefore -> $topAfter $($wheel.error)"
    Check "pointer put back after --foreground" ($before -eq $after) "$before -> $after"
    Invoke-2ndscreen @("screenshot", "--screen", "e2e", "--output", (Join-Path $Out "e2e-input.png")) | Out-Null
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
Check "mcp lists tools" ($tools.Count -eq 12) ($tools -join ",")
Check "mcp screen_list" (-not ($mcp | Where-Object id -eq 3).result.isError)

# 7b. Moving one window of a program the user is running leaves its other windows alone,
# now and after: the screen keeps only the moved window and the program's later windows.
# Last before cleanup: closing this program hands the foreground to the next window, which
# would fail the foreground checks above.
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static int CenterX(long h) { RECT r; GetWindowRect(new IntPtr(h), out r); return (r.Left + r.Right) / 2; }
}
"@
$user = Start-Process $target -ArgumentList "--second-window" -PassThru
Start-Sleep -Seconds 2
$user.Refresh()
$taken = Invoke-2ndscreen @("window", "move", "--screen", "e2e", "--pid", "$($user.Id)", "--window-id", "$([long]$user.MainWindowHandle)")
$other = $taken.windows | Where-Object { $_.windowID -ne [long]$user.MainWindowHandle } | Select-Object -First 1
if ($taken.ok -and $other) {
    Start-Sleep -Milliseconds 1500
    $cx = [Win]::CenterX([long]$other.windowID)
    Check "moving one window leaves the program's others alone" (-not ($cx -ge $frame.x -and $cx -lt ($frame.x + $frame.width))) "other window center x $cx; screen $($frame.x)..$($frame.x + $frame.width)"
} else {
    Check "moving one window leaves the program's others alone" $false "move: $($taken.ok) $($taken.error); other window found: $([bool]$other)"
}
$user | Stop-Process -Force -ErrorAction SilentlyContinue

# 8. Cleanup: destroying the screen moves the test window back to a real display.
if ($created.ok) {
    $destroyed = Invoke-2ndscreen @("screen", "destroy", "e2e")
    Start-Sleep -Seconds 1
    $after = Invoke-2ndscreen @("screen", "list")
    Check "screen destroy" ([bool]($destroyed.ok -and -not ($after.screens | Where-Object name -eq "e2e")))
} else {
    Skip "screen destroy" "screen create failed"
}
if ($targetPid) { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue }
$appProcess | Stop-Process -Force -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize | Out-String | Set-Content (Join-Path $Out "e2e-results.txt")
if ($env:GITHUB_STEP_SUMMARY) {
    "| Check | Result | Detail |`n|---|---|---|" | Add-Content $env:GITHUB_STEP_SUMMARY
    $results | ForEach-Object { "| $($_.Check) | $($_.Result) | $($_.Detail -replace '\|', '/') |" } | Add-Content $env:GITHUB_STEP_SUMMARY
}
$failed = @($results | Where-Object Result -eq "FAIL").Count
$skipped = @($results | Where-Object Result -eq "SKIP").Count
Write-Host "$($results.Count - $failed - $skipped) passed, $failed failed, $skipped skipped"
exit $(if ($failed) { 1 } else { 0 })
