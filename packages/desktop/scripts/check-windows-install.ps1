# Installs the Squirrel installer `make:windows` built, as a person's silent install does, and starts
# the installed app: its files are where they should be, and its window opens. With -Signed, every
# executable in the app and the install, and the installer, must carry a valid signature. Run by
# desktop.yml (unsigned) and desktop-release.yml (-Signed) on a runner that has no Sanoma installed.
param(
  # packages/desktop/out
  [Parameter(Mandatory)] [string] $Out,
  [Parameter(Mandatory)] [string] $Version,
  [switch] $Signed
)
$ErrorActionPreference = "Stop"

$setup = Join-Path $Out "make/squirrel.windows/x64/Sanoma-Setup.exe"
$root = Join-Path $env:LOCALAPPDATA "Sanoma"

$install = Start-Process -FilePath $setup -ArgumentList "--silent" -PassThru
if (-not $install.WaitForExit(300000)) { throw "the installer still runs after 5 minutes" }
if ($install.ExitCode -ne 0) { throw "the installer exited with $($install.ExitCode)" }

foreach ($file in "Update.exe", "Sanoma.exe", "app-$Version/Sanoma.exe", "app-$Version/resources/node/node.exe") {
  if (-not (Test-Path (Join-Path $root $file))) { throw "$file is missing after the install" }
}
# The shortcut comes from the app's own --squirrel-install run, which the installer may not wait for,
# in a Start Menu folder Squirrel names after the app's company.
$startMenu = Join-Path $env:APPDATA "Microsoft/Windows/Start Menu/Programs"
$deadline = (Get-Date).AddSeconds(60)
while (-not (Get-ChildItem -Path $startMenu -Recurse -Filter "Sanoma.lnk")) {
  if ((Get-Date) -gt $deadline) {
    Get-ChildItem -Path $startMenu -Recurse -Name
    throw "no Sanoma shortcut in the Start Menu after the install"
  }
  Start-Sleep -Seconds 1
}

if ($Signed) {
  # What `@electron/windows-sign` signs, in the app as packaged and as installed, and the installer.
  $files = @(Get-Item $setup) + @(
    Get-ChildItem -Recurse -File -Include *.exe, *.dll, *.node, *.sys, *.scr, *.efi `
      -Path (Join-Path $Out "Sanoma-win32-x64"), $root
  )
  $unsigned = $files | Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -ne "Valid" }
  if ($unsigned) {
    $unsigned | ForEach-Object { Write-Output "::error::not validly signed: $($_.FullName)" }
    throw "$(@($unsigned).Count) of $($files.Count) executables are not validly signed"
  }
  $signer = (Get-AuthenticodeSignature (Join-Path $root "app-$Version/Sanoma.exe")).SignerCertificate.Subject
  Write-Output "all $($files.Count) executables are signed, by $signer"
}

# Through the shortcut's stub, as a person starts it; the stub starts the version it finds and exits.
$userData = Join-Path $env:RUNNER_TEMP "sanoma-installed-user-data"
Start-Process -FilePath (Join-Path $root "Sanoma.exe") -ArgumentList "--user-data-dir=$userData"
try {
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Get-Process Sanoma -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle })) {
    if ((Get-Date) -gt $deadline) { throw "the installed app showed no window in 90 seconds" }
    Start-Sleep -Seconds 1
  }
  # Still there 15 seconds on: past Squirrel's first-run lock, it has not exited at start.
  Start-Sleep -Seconds 15
  if (-not (Get-Process Sanoma -ErrorAction SilentlyContinue)) { throw "the installed app exited" }
  Write-Output "the installed app runs, its window open"
} finally {
  Get-Process Sanoma -ErrorAction SilentlyContinue | Stop-Process -Force
}
