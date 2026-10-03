<#
.SYNOPSIS
  Install the Virtual Display Driver that 2ndscreen uses, without its GUI installer.

.DESCRIPTION
  Downloads the signed driver from github.com/VirtualDrivers/Virtual-Display-Driver
  (MIT), trusts its publisher certificate so the install does not prompt, creates
  the Root\MttVDD device and installs the driver, and puts the default settings in
  C:\VirtualDisplayDriver. Run as administrator. People can use the project's own
  installer instead; this script exists for unattended machines such as CI.
#>
[CmdletBinding()]
param(
    [string] $Release = "25.5.2",
    [string] $Asset = "Signed-Driver-v24.12.24-x64.zip"
)
$ErrorActionPreference = "Stop"

$work = Join-Path $env:TEMP "vdd-install"
New-Item -ItemType Directory -Force $work | Out-Null
$zip = Join-Path $work $Asset
Invoke-WebRequest "https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/$Release/$Asset" -OutFile $zip
Expand-Archive $zip -DestinationPath $work -Force
$inf = Get-ChildItem $work -Recurse -Filter MttVDD.inf | Select-Object -First 1
$cat = Get-ChildItem $work -Recurse -Filter *.cat | Select-Object -First 1

# Settings the driver reads when it starts.
New-Item -ItemType Directory -Force "C:\VirtualDisplayDriver" | Out-Null
$settings = Get-ChildItem $work -Recurse -Filter vdd_settings.xml | Select-Object -First 1
if (-not (Test-Path "C:\VirtualDisplayDriver\vdd_settings.xml")) {
    Copy-Item $settings.FullName "C:\VirtualDisplayDriver\vdd_settings.xml"
}
# Let the signed-in user's 2ndscreen edit the settings without elevation.
icacls "C:\VirtualDisplayDriver" /grant "*S-1-5-11:(OI)(CI)M" | Out-Null

# Trust the catalog's signer as a publisher so Windows installs without asking.
# Its chain already ends at a root Windows trusts, so no root is added.
$signer = (Get-AuthenticodeSignature $cat.FullName).SignerCertificate
if ($signer) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
    $store.Open("ReadWrite"); $store.Add($signer); $store.Close()
    Write-Host "Trusted driver publisher: $($signer.Subject)"
}

# A root-enumerated device needs a device node; devcon (from the WDK) creates it and installs.
$devcon = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Tools" -Recurse -Filter devcon.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } | Select-Object -First 1
if ($devcon) {
    & $devcon.FullName install $inf.FullName "Root\MttVDD"
    if ($LASTEXITCODE -gt 1) { throw "devcon install failed with $LASTEXITCODE" }
} else {
    # pnputil stages the driver; the device node then comes from nefcon.
    pnputil /add-driver $inf.FullName /install
    $nefcon = Join-Path $work "nefconw.exe"
    Invoke-WebRequest "https://github.com/nefarius/nefcon/releases/download/v1.14.0/nefcon_v1.14.0.zip" -OutFile "$work\nefcon.zip"
    Expand-Archive "$work\nefcon.zip" -DestinationPath "$work\nefcon" -Force
    $nefcon = Get-ChildItem "$work\nefcon" -Recurse -Filter nefconw.exe | Where-Object { $_.FullName -match "x64" } | Select-Object -First 1
    & $nefcon.FullName --create-device-node --hardware-id "Root\MttVDD" --class-name Display --class-guid "4D36E968-E325-11CE-BFC1-08002BE10318"
    & $nefcon.FullName --install-driver --inf-path $inf.FullName
}

# Bind the driver to the device node now that the node exists: staging it
# before the node was created leaves the device without a driver. Binding
# sometimes still misses on a fresh machine, so check and try again.
function Get-VirtualDisplay {
    Get-PnpDevice -Class Display | Where-Object { $_.Status -eq "OK" -and $_.FriendlyName -like "*Virtual Display*" }
}
for ($attempt = 1; $attempt -le 4 -and -not (Get-VirtualDisplay); $attempt++) {
    Write-Host "Binding the driver (attempt $attempt)"
    pnputil /add-driver $inf.FullName /install
    if (-not $devcon) { & $nefcon.FullName --install-driver --inf-path $inf.FullName }
    pnputil /scan-devices
    Start-Sleep -Seconds 5
}

# Report what Windows now sees.
$devices = Get-PnpDevice -Class Display | Where-Object { $_.InstanceId -like "ROOT\*" }
foreach ($device in $devices) {
    $problem = (Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName DEVPKEY_Device_ProblemCode).Data
    $bound = (Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName DEVPKEY_Device_DriverInfPath).Data
    Write-Host "$($device.InstanceId): $($device.FriendlyName) status $($device.Status), problem $problem, driver $bound"
}
if (-not (Get-VirtualDisplay)) {
    throw "the Virtual Display Driver did not start"
}
