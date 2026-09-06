[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$torDirectory = Join-Path $root 'tor'
$configPath = Join-Path $torDirectory 'torrc.local'

if ((Test-Path -LiteralPath $configPath) -and !$Force) {
  throw "Tor configuration already exists: $configPath. Use -Force only if you intentionally want to replace it."
}

function ConvertTo-TorPath([string]$Path) {
  return ($Path -replace '\\', '/')
}

$runtime = ConvertTo-TorPath (Join-Path $torDirectory 'runtime')
$service = ConvertTo-TorPath (Join-Path $torDirectory 'vx_service')
$log = ConvertTo-TorPath (Join-Path $torDirectory 'tor.log')

New-Item -ItemType Directory -Path $torDirectory -Force | Out-Null
$lines = @(
  '# Local, machine-specific Tor configuration. This file and the onion private key stay out of Git.',
  "DataDirectory $runtime",
  'SocksPort 0',
  "HiddenServiceDir $service",
  'HiddenServicePort 80 127.0.0.1:3000',
  "Log notice file $log"
)
[System.IO.File]::WriteAllLines($configPath, $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Created $configPath"
Write-Host 'Start VX with scripts\Start-VX.ps1 and the full path to tor.exe.'
Write-Host 'After Tor starts, run scripts\Get-VXOnionAddress.ps1 to display the address to share.'