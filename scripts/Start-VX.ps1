[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$TorExe
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server.js'
$torConfig = Join-Path $root 'tor\torrc.local'
$logs = Join-Path $root 'logs'

if (!(Test-Path -LiteralPath $TorExe -PathType Leaf)) { throw "tor.exe was not found: $TorExe" }
if (!(Test-Path -LiteralPath $torConfig -PathType Leaf)) { throw "Tor configuration was not found: $torConfig" }
if (!(Test-Path -LiteralPath $server -PathType Leaf)) { throw "VX server was not found: $server" }

$node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Is-RunningFor([string]$processName, [string]$needle) {
  return [bool](Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$needle*" } |
    Select-Object -First 1)
}

if (!(Is-RunningFor 'tor.exe' $torConfig)) {
  Start-Process -FilePath $TorExe -ArgumentList @('-f', $torConfig) -WorkingDirectory $root -WindowStyle Hidden
}

if (!(Is-RunningFor 'node.exe' $server)) {
  Start-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'vx-server.out.log') `
    -RedirectStandardError (Join-Path $logs 'vx-server.err.log')
}
