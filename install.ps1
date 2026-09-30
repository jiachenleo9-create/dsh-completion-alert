# dsh-completion-alert installer.
#
# Installs this plugin into a DSH profile the way the plugin manager expects a
# local package to look, so it appears on the app's Plugins page ("已安装" /
# Installed group) with a working enable switch:
#
#   <profile>/plugins/dsh-completion-alert        the package itself
#   <profile>/node_modules/dsh-completion-alert   a junction to it
#   <profile>/package.json  dependencies[name] = "file:plugins/dsh-completion-alert"
#                           dsh.profile.bundles  += name
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall

param(
  [string]$ProfileDir,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-completion-alert'
$source = $PSScriptRoot
$items = @('package.json', 'cordis.patch.yml', 'lib', 'assets', 'docs', 'README.md')

if (-not $ProfileDir) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
  $ProfileDir = Join-Path $dshHome 'profiles\desktop'
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile directory not found: $ProfileDir (pass -ProfileDir)" }
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path

$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "profile manifest not found: $manifestPath" }

$packageDir = Join-Path (Join-Path $ProfileDir 'plugins') $packageName
$linkDir = Join-Path (Join-Path $ProfileDir 'node_modules') $packageName
$dependencySpec = "file:plugins/$packageName"

Write-Host "profile : $ProfileDir"
Write-Host "package : $packageName"

<#
  Remove a filesystem entry without ever recursing through a junction: a plain
  Remove-Item -Recurse on a link would follow it into the real package.
#>
function Remove-Entry([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.LinkType -in @('Junction', 'SymbolicLink')) { [System.IO.Directory]::Delete($path, $false) }
  else { Remove-Item -LiteralPath $path -Recurse -Force }
}

<#
  Rewrite the profile manifest: set or drop the dependency entry and add or
  remove the bundle selection, preserving the rest of the file byte for byte
  where possible (a .bak copy is kept next to it).
#>
function Update-Manifest([bool]$enable) {
  $raw = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8

  # --- dependencies ---------------------------------------------------------
  $depMatch = [regex]::Match($raw, '(?s)"dependencies"\s*:\s*\{(?<body>[^}]*)\}')
  if (-not $depMatch.Success) { throw "no dependencies object found in $manifestPath" }
  $body = $depMatch.Groups['body'].Value
  $entry = '"' + $packageName + '": "' + $dependencySpec + '"'
  $body = ($body -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and $_ -notmatch [regex]::Escape('"' + $packageName + '"') }) -join ', '
  if ($enable) { $body = if ($body -eq '') { $entry } else { "$body, $entry" } }
  $depNew = '"dependencies": {' + $body + '}'
  $raw = $raw.Substring(0, $depMatch.Index) + $depNew + $raw.Substring($depMatch.Index + $depMatch.Length)

  # --- dsh.profile.bundles --------------------------------------------------
  $bundleMatch = [regex]::Match($raw, '(?s)"bundles"\s*:\s*\[(?<body>.*?)\]')
  if (-not $bundleMatch.Success) { throw "no dsh.profile.bundles array found in $manifestPath" }
  $body = $bundleMatch.Groups['body'].Value
  $names = ($body -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and $_ -notmatch [regex]::Escape('"' + $packageName + '"') })
  if ($enable) { $names += '"' + $packageName + '"' }
  $bundleNew = '"bundles": [' + ($names -join ', ') + ']'
  $raw = $raw.Substring(0, $bundleMatch.Index) + $bundleNew + $raw.Substring($bundleMatch.Index + $bundleMatch.Length)

  Copy-Item -LiteralPath $manifestPath -Destination "$manifestPath.bak" -Force
  [System.IO.File]::WriteAllText($manifestPath, $raw, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Uninstall) {
  Remove-Entry $linkDir
  Write-Host "removed  $linkDir"
  Remove-Entry $packageDir
  Write-Host "removed  $packageDir"
  Update-Manifest $false
  Write-Host "unregistered $packageName in package.json"
  Write-Host ''
  Write-Host 'Done. Restart DeepSeek Harness to apply the removal.'
  exit 0
}

# --- copy the package to its canonical home --------------------------------
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
foreach ($item in $items) {
  $from = Join-Path $source $item
  if (-not (Test-Path -LiteralPath $from)) { continue }
  $to = Join-Path $packageDir $item
  if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
}
Write-Host "copied   $packageDir"

# --- node_modules link ------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $linkDir) | Out-Null
Remove-Entry $linkDir
New-Item -ItemType Junction -Path $linkDir -Target $packageDir | Out-Null
Write-Host "linked   $linkDir -> $packageDir"

# --- manifest ---------------------------------------------------------------
Update-Manifest $true
Write-Host "registered $packageName as dependencies['$packageName'] = '$dependencySpec' (backup: package.json.bak)"

if (-not (Test-Path -LiteralPath (Join-Path $linkDir 'package.json'))) { throw "link does not resolve to the package: $linkDir" }

Write-Host ''
Write-Host 'Installed. Next steps:'
Write-Host '  1. Restart DeepSeek Harness (the desktop app owns this profile and loads bundles at boot).'
Write-Host '  2. Open the Plugins page: the plugin now appears in the Installed group with a switch.'
Write-Host "  3. Verify: curl http://127.0.0.1:19387/completion-alert/ping"
