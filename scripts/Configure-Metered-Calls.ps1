[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9-]+$')]
  [string]$AppName
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (!(Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "Missing .env: $envFile" }

Write-Host 'Enter the Metered credential API key. It will not be displayed.'
$secureKey = Read-Host -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try { $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

$url = "https://$AppName.metered.live/api/v1/turn/credentials?apiKey=$([uri]::EscapeDataString($apiKey))"
$iceServers = Invoke-RestMethod -Uri $url -Method Get
if ($iceServers -isnot [array] -or $iceServers.Count -eq 0) { throw 'Metered returned no ICE servers.' }
$hasTurn = @($iceServers | ForEach-Object { $_.urls } | ForEach-Object { @($_) } | Where-Object { $_ -match '^turns?:' }).Count -gt 0
if (!$hasTurn) { throw 'Metered response contains no TURN server.' }
$iceJson = @($iceServers) | ConvertTo-Json -Compress -Depth 8

$lines = [System.Collections.Generic.List[string]]::new([string[]][IO.File]::ReadAllLines($envFile))
function Set-Key([string]$key, [string]$value) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like "$key=*") { $lines[$i] = "$key=$value"; return } }
  [void]$lines.Add("$key=$value")
}
Set-Key 'TOR_ONLY' 'false'
Set-Key 'ICE_SERVERS' $iceJson
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
Write-Host "Calls enabled using TURN credentials from $AppName.metered.live. Restart VX to apply."
