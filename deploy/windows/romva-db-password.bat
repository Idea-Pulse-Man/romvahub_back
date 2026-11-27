<# : -- batch part: PowerShell reads this block as a comment --
@echo off
net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; Invoke-Expression ([System.IO.File]::ReadAllText($f))"
pause
exit /b
#>

# ============================================================================
# A new Supabase database password for romva (run ON THE VPS).
#
# First, in Supabase: Project Settings -> Database -> Reset database password.
# Then run this file right away (the website cannot reach the database between
# the two). It:
#   1. asks for the new password (not shown on screen, not written to any log)
#   2. checks Supabase takes it - if not, nothing is changed
#   3. puts it in C:\romva\backend\.env (DATABASE_URL and DIRECT_URL)
#   4. restarts the server and checks it reaches the database again
#
# The nightly backup reads the link from .env each time: it needs no change.
# ============================================================================

$ErrorActionPreference = 'Continue'
$Root = 'C:\romva'
$EnvFile = "$Root\backend\.env"

function Say($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK: $text" -ForegroundColor Green }
function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Write-Host 'Send a screenshot of this window.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

# A link like postgresql://user:PASSWORD@host:5432/postgres?...
$LinkPattern = '^(postgres(?:ql)?://[^:/@]+:)([^@]*)(@.+)$'

if (-not (Test-Path $EnvFile)) { Fail 'C:\romva\backend\.env was not found.' }
$lines = @(Get-Content $EnvFile)
$current = (@($lines | Where-Object { $_ -match '^DATABASE_URL=' }) | Select-Object -First 1) -replace '^DATABASE_URL=', ''
if ($current -notmatch 'supabase\.com') { Fail 'The server does not use Supabase (C:\romva\backend\.env), so there is no Supabase password to change.' }
if ($current -notmatch $LinkPattern) { Fail 'The database link in C:\romva\backend\.env does not look as expected.' }
$PgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1).DirectoryName
if (-not $PgBin) { Fail 'PostgreSQL tools were not found on this VPS.' }

Write-Host ''
Write-Host '  A new database password for romva (Supabase)' -ForegroundColor White
Write-Host '  First reset it in Supabase: Project Settings -> Database -> Reset database password.' -ForegroundColor White

# ---------------------------------------------------------------- 1. the password
Say '1/3 The new password'
$secure = Read-Host 'Type (or paste) the NEW database password - it is not shown' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ($plain) { $plain = $plain.Trim() }
if (-not $plain) { Fail 'No password was given. Nothing was changed.' }
$encoded = [Uri]::EscapeDataString($plain)

# ---------------------------------------------------------------- 2. check
Say '2/3 Checking Supabase takes it'
$null = $current -match $LinkPattern
$new = $matches[1] + $encoded + $matches[3]
$base, $query = $new.Split('?', 2)
$kept = @()
if ($query) { $kept = @($query.Split('&') | Where-Object { $_ -and $_ -notmatch '^(uselibpqcompat|pgbouncer|connection_limit|pool_timeout|schema|sslmode)=' }) }
$tool = $base + '?' + (@('sslmode=require') + $kept -join '&')
$one = ((& "$PgBin\psql.exe" $tool -tAc 'select 1' 2>$null) -join '').Trim()
if ($one -ne '1') {
  Fail ('Supabase did not take that password, so nothing was changed. Copy it again from where you saved it ' +
        'and run this file again (right after a reset, wait a minute first).')
}
Ok 'Supabase takes the new password.'

# ---------------------------------------------------------------- 3. switch
Say '3/3 Putting it in the server settings and restarting the server'
Copy-Item $EnvFile "$EnvFile.before-password" -Force
$updated = @($lines | ForEach-Object {
  # (The link pattern is matched last, so $matches holds its parts.)
  if ($_ -match 'supabase\.com' -and $_ -match '^(DATABASE_URL|DIRECT_URL)=(postgres(?:ql)?://[^:/@]+:)([^@]*)(@.+)$') {
    $matches[1] + '=' + $matches[2] + $encoded + $matches[4]
  } else { $_ }
})
Set-Content -Path $EnvFile -Value $updated -Encoding ascii
nssm restart romva 2>$null | Out-Null
$healthy = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  # /health answers 200 only when the server reaches the database.
  try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing -TimeoutSec 5 | Out-Null; $healthy = $true; break } catch { }
}
if (-not $healthy) {
  # The old password no longer works after a reset, so the new one stays in .env.
  Fail ('The server did not reach the database within 90 seconds. The new password is in .env ' +
        '(the settings from before are in .env.before-password). Look at C:\romva\logs\backend.log.')
}
# The copy from before holds the old password, which no longer works: not needed.
Remove-Item "$EnvFile.before-password" -Force -ErrorAction SilentlyContinue
Ok 'The server reaches the database with the new password.'

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Green
Write-Host '  DONE. romva uses the new database password.' -ForegroundColor Green
Write-Host '======================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Open https://www.romva.space and check it works.'
Write-Host ''
