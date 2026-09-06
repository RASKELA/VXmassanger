[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$hostnameFile = Join-Path $root 'tor\vx_service\hostname'

if (!(Test-Path -LiteralPath $hostnameFile -PathType Leaf)) {
  throw 'The onion hostname is not available yet. Start Tor first with scripts\Start-VX.ps1.'
}

$hostname = (Get-Content -LiteralPath $hostnameFile -Raw).Trim().ToLowerInvariant()
if ($hostname -notmatch '^[a-z2-7]{56}\.onion$') {
  throw "Unexpected Tor hostname in $hostnameFile"
}

Write-Output "http://$hostname/"