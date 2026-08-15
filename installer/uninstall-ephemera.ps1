param([switch]$NoElevate, [switch]$NoPause, [switch]$Relaunched)

# Ephemera — full uninstaller.
# Stops the app, runs its registered uninstaller, then sweeps every leftover:
# the install folder, user data, shortcuts, and registry keys. Scoped to
# Ephemera only. Designed to run from %TEMP% so it can delete its own install
# folder, and to elevate automatically for the deepest clean.

$ErrorActionPreference = 'SilentlyContinue'
$AppName = 'Ephemera'

$script:removed = New-Object System.Collections.ArrayList
$script:failed  = New-Object System.Collections.ArrayList

function Write-Head($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-FsPath($p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return }
  if (-not (Test-Path -LiteralPath $p)) { return }
  try {
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
    [void]$script:removed.Add($p); Write-Host "  removed   $p" -ForegroundColor Green
  } catch {
    [void]$script:failed.Add($p); Write-Host "  FAILED    $p  ($($_.Exception.Message))" -ForegroundColor Red
  }
}

function Remove-RegKey($p) {
  if (-not (Test-Path -LiteralPath $p)) { return }
  try {
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
    [void]$script:removed.Add($p); Write-Host "  removed   $p" -ForegroundColor Green
  } catch {
    [void]$script:failed.Add($p); Write-Host "  FAILED    $p" -ForegroundColor Red
  }
}

# ---- Elevation -------------------------------------------------------------
if (-not $NoElevate -and -not (Test-Admin)) {
  Write-Host "Requesting administrator rights for a complete removal..."
  try {
    Start-Process powershell -Verb RunAs -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Relaunched'
    ) -ErrorAction Stop
    return
  } catch {
    Write-Host "Elevation declined - continuing with user-level cleanup." -ForegroundColor Yellow
  }
}

Write-Head "==== Ephemera - Full Uninstaller ===="
if (Test-Admin) { Write-Host "Running with administrator rights." }
else { Write-Host "Running without elevation (user-scope only)." -ForegroundColor Yellow }

# ---- 1. Stop running instances ---------------------------------------------
Write-Head "Stopping running Ephemera processes"
$procs = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($procs) { $procs | ForEach-Object { try { $_.Kill(); Write-Host "  stopped   pid $($_.Id)" } catch {} } }
else { Write-Host "  (none running)" }
Start-Sleep -Milliseconds 600

# ---- 2. Find registered installs and run their uninstallers ----------------
Write-Head "Locating registered installations"
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$installLocations = New-Object System.Collections.ArrayList
$uninstallKeys    = New-Object System.Collections.ArrayList
foreach ($root in $uninstallRoots) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($props.DisplayName -and $props.DisplayName -match '^Ephemera') {
      Write-Host "  found     $($props.DisplayName)  [$($_.PSChildName)]"
      [void]$uninstallKeys.Add($_.PSPath)
      if ($props.InstallLocation) { [void]$installLocations.Add($props.InstallLocation) }
      $cmd = $props.QuietUninstallString
      if (-not $cmd) { $cmd = $props.UninstallString }
      if ($cmd) {
        if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $uargs = $Matches[2] }
        else { $exe = $cmd; $uargs = '' }
        # Derive the install folder from the uninstaller's own location when the
        # registry doesn't record InstallLocation (covers custom install dirs).
        if ((Test-Path -LiteralPath $exe)) { [void]$installLocations.Add((Split-Path -Parent $exe)) }
        if ((Test-Path -LiteralPath $exe) -and ($uargs -notmatch '/S')) { $uargs = ($uargs + ' /S').Trim() }
        if (Test-Path -LiteralPath $exe) {
          Write-Host "  running   bundled uninstaller (silent)"
          try { Start-Process -FilePath $exe -ArgumentList $uargs -Wait -ErrorAction Stop } catch {}
        }
      }
    }
  }
}
if ($uninstallKeys.Count -eq 0) { Write-Host "  (no registry install entry found - sweeping known locations)" }
Start-Sleep -Seconds 2
Get-Process -Name $AppName -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }

# ---- 3. Remove application files and user data -----------------------------
Write-Head "Removing application files and data"
$paths = New-Object System.Collections.ArrayList
@(
  "$env:LOCALAPPDATA\Programs\Ephemera",
  "$env:LOCALAPPDATA\Programs\ephemera",
  "$env:APPDATA\Ephemera",
  "$env:APPDATA\ephemera",
  "$env:LOCALAPPDATA\Ephemera",
  "$env:LOCALAPPDATA\ephemera",
  "$env:LOCALAPPDATA\ephemera-updater",
  "$env:ProgramFiles\Ephemera",
  "${env:ProgramFiles(x86)}\Ephemera"
) | ForEach-Object { [void]$paths.Add($_) }
$installLocations | ForEach-Object { [void]$paths.Add($_) }
$paths | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { Remove-FsPath $_ }

# ---- 4. Remove registry entries --------------------------------------------
Write-Head "Removing registry entries"
$uninstallKeys | Select-Object -Unique | ForEach-Object { Remove-RegKey $_ }
@(
  "HKCU:\Software\Ephemera",
  "HKCU:\Software\ephemera",
  "HKCU:\Software\Classes\Ephemera",
  "HKCU:\Software\Classes\ephemera",
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\org.xenolab.ephemera",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\org.xenolab.ephemera"
) | ForEach-Object { Remove-RegKey $_ }

# ---- 5. Remove shortcuts (Revo-style: match by target, too) ----------------
Write-Head "Removing shortcuts"
$shortcutDirs = @(
  [Environment]::GetFolderPath('Desktop'),
  "$env:PUBLIC\Desktop",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$wsh = New-Object -ComObject WScript.Shell
foreach ($dir in $shortcutDirs) {
  Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $target = ''
    try { $target = $wsh.CreateShortcut($_.FullName).TargetPath } catch {}
    if ($_.BaseName -eq $AppName -or $target -match 'Ephemera\.exe') { Remove-FsPath $_.FullName }
  }
  $progFolder = Join-Path $dir $AppName
  if (Test-Path -LiteralPath $progFolder) { Remove-FsPath $progFolder }
}

# ---- 6. Summary ------------------------------------------------------------
Write-Head "==== Summary ===="
Write-Host ("  Items removed: {0}" -f $script:removed.Count) -ForegroundColor Green
if ($script:failed.Count -gt 0) {
  Write-Host ("  Items failed:  {0}" -f $script:failed.Count) -ForegroundColor Red
  $script:failed | ForEach-Object { Write-Host "    ! $_" -ForegroundColor Red }
  Write-Host "  (Locked items are usually removed after a reboot.)" -ForegroundColor Yellow
} else {
  Write-Host "  Items failed:  0"
}
Write-Host ""
Write-Host "Ephemera has been fully removed." -ForegroundColor Cyan

# Schedule deletion of our own temp copy once this process exits.
if ($PSCommandPath -and $PSCommandPath -like "$env:TEMP*") {
  Start-Process cmd.exe -WindowStyle Hidden -ArgumentList "/c timeout /t 2 >nul & del /f /q `"$PSCommandPath`"" | Out-Null
}

if (-not $NoPause) { Read-Host "`nPress Enter to close" | Out-Null }
