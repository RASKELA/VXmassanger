[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$TorExe
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'Start-VX.ps1'
$torPath = (Resolve-Path -LiteralPath $TorExe -ErrorAction Stop).Path

if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "VX launcher was not found: $launcher" }
if (![IO.Path]::GetFileName($torPath).Equals('tor.exe', [StringComparison]::OrdinalIgnoreCase)) {
  throw "Expected the full path to tor.exe, received: $torPath"
}

$powerShell = Join-Path $PSHOME 'powershell.exe'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -TorExe `"$torPath`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 0)

Register-ScheduledTask -TaskName 'VX Messenger' -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the VX Node server and its Tor onion service after sign-in.' -Force | Out-Null
Write-Host 'Autostart task “VX Messenger” was registered for the current Windows user.'
Write-Host 'You can test it now with:'
Write-Host '  Start-ScheduledTask -TaskName "VX Messenger"'
