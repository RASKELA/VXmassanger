[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
  [string]$GmailAddress,

  [string]$FromName = 'VX security code'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

Write-Host 'Enter the 16-character Gmail App Password. It will not be displayed.'
$securePassword = Read-Host -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $appPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) -replace '\s', ''
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ($appPassword.Length -lt 12) {
  throw 'The Gmail App Password is unexpectedly short. Create a new App Password in the Google Account security settings and try again.'
}

$lines = @(
  '# Local VX settings. This file contains a secret and is excluded from Git.',
  'HOST=127.0.0.1',
  'PORT=3000',
  'NODE_ENV=production',
  'TOR_ONLY=true',
  'SMTP_HOST=smtp.gmail.com',
  'SMTP_PORT=465',
  'SMTP_SECURE=true',
  "SMTP_USER=$GmailAddress",
  "SMTP_PASS=$appPassword",
  "SMTP_FROM=$FromName <$GmailAddress>",
  'DEV_SHOW_OTP=false'
)

[System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

# Keep the plaintext App Password readable only by the current Windows user and SYSTEM.
$acl = Get-Acl $envFile
# Preserve the directory's existing rights (notably the local Administrators
# group) so the account selected for the scheduled task can read this file.
$acl.SetAccessRuleProtection($true, $true)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($identity in @($currentUser, 'NT AUTHORITY\SYSTEM')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $envFile -AclObject $acl

Write-Host "SMTP is configured in $envFile"
Write-Host 'Restart VX before testing. The verification code will no longer be returned on screen.'
