[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TurnHost,
  [Parameter(Mandatory = $true)]
  [string]$TurnUsername,
  [Parameter(Mandatory = $true)]
  [string]$TurnCredential
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (!(Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "Missing .env: $envFile" }
$ice = '[{"urls":["turn:' + $TurnHost + ':443?transport=tcp","turn:' + $TurnHost + ':3478?transport=udp"],"username":"' + $TurnUsername + '","credential":"' + $TurnCredential + '"}]'
$lines = [System.Collections.Generic.List[string]]::new([string[]][IO.File]::ReadAllLines($envFile))
function Set-Key([string]$key, [string]$value) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like "$key=*") { $lines[$i] = "$key=$value"; return } }
  [void]$lines.Add("$key=$value")
}
Set-Key 'TOR_ONLY' 'false'
Set-Key 'ICE_SERVERS' $ice
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Calls enabled with the supplied TURN server. Restart VX to apply.'
