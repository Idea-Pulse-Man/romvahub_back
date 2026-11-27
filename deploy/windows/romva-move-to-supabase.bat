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
# Move romva's database from this VPS to Supabase (run ON THE VPS, once).
#
# Before: run C:\romva\update.bat (the newest code), and in Supabase allow this
# VPS's IP address (Project Settings -> Database -> Network Restrictions).
#
# It:
#   1. checks the code is up to date and the database fits Supabase Free (500 MB)
#   2. asks for the Supabase "Session pooler" link and the database password
#   3. stops the server, saves the whole database to C:\romva\backups (safety copy)
#   4. copies it into Supabase and checks every table has the same number of rows
#   5. switches the server to Supabase and starts it again (undone if it fails)
#   6. backups: a full one every Sunday 3 AM (keeps 8), only the changes on the
#      other nights; makes the first full backup now
#
# The database on this VPS is left as it is (not used any more, kept as a fallback).
# Everything on screen is also saved in C:\romva\move-to-supabase-log.txt.
# ============================================================================

$ErrorActionPreference = 'Continue'
$Root = 'C:\romva'
$Backups = "$Root\backups"
New-Item -ItemType Directory -Force -Path $Backups, "$Root\logs" | Out-Null
Start-Transcript -Path "$Root\move-to-supabase-log.txt" -Append | Out-Null

function Say($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK: $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    NOTE: $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Write-Host 'Nothing was switched: the server still uses the database on this VPS.' -ForegroundColor Red
  Write-Host 'Send a screenshot of this window (and C:\romva\move-to-supabase-log.txt).' -ForegroundColor Red
  Stop-Transcript | Out-Null
  Read-Host 'Press Enter to close'
  exit 1
}

# ---------------------------------------------------------------- what is here
$S = @{}
if (Test-Path "$Root\SECRETS.txt") {
  Get-Content "$Root\SECRETS.txt" | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $S[$matches[1]] = $matches[2] } }
}
if (-not $S['DB_PASSWORD']) { Fail 'C:\romva\SECRETS.txt has no DB_PASSWORD (was this VPS set up with romva-vps-setup.bat?).' }
$PgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1).DirectoryName
if (-not $PgBin) { Fail 'PostgreSQL tools were not found on this VPS.' }
$Local = "postgresql://romva:$($S['DB_PASSWORD'])@localhost:5432/romva"
$EnvFile = "$Root\backend\.env"
if (-not (Test-Path $EnvFile)) { Fail 'C:\romva\backend\.env was not found.' }
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

function Psql($url, $sql) { (& "$PgBin\psql.exe" $url -tAc $sql 2>$null) -join "`n" }

Write-Host ''
Write-Host '  Move the romva database to Supabase' -ForegroundColor White
Write-Host '  About 5-15 minutes. The website is offline for a few minutes in the middle.' -ForegroundColor White

# ---------------------------------------------------------------- 1. checks
Say '1/6 Checking this VPS'
if ((Get-Content $EnvFile | Where-Object { $_ -match '^DATABASE_URL=.*supabase\.com' })) {
  Fail 'The server already uses Supabase (C:\romva\backend\.env). Nothing to move.'
}
$latest = (Psql $Local "select count(*) from information_schema.tables where table_schema='public' and table_name='maker_computers'").Trim()
if ($latest -ne '1') { Fail 'The code is not the newest yet. Run C:\romva\update.bat as administrator first, then this file again.' }
$bytes = [int64]("0" + (Psql $Local 'select pg_database_size(current_database())').Trim())
$mb = [math]::Round($bytes / 1MB)
$bids = (Psql $Local 'select count(*) from bids').Trim()
Ok "Database on this VPS: $mb MB, $bids applications."
if ($mb -gt 450) {
  Fail "The database is $mb MB; Supabase Free holds 500 MB. First move the old Resume files out: in C:\romva\backend run  yarn resumes:to-json --apply  (or use Storage -> Backup and remove), then run this file again."
}
if ($mb -gt 300) { Warn "$mb MB is more than half of Supabase Free's 500 MB. Running  yarn resumes:to-json --apply  after the move frees most of it." }

# ---------------------------------------------------------------- 2. the link
Say '2/6 The Supabase link'
Write-Host '    In Supabase: the green Connect button -> Direct -> Session pooler -> copy the link.' -ForegroundColor White
# Not written to the log: the link may hold the password.
Stop-Transcript | Out-Null
$Link = (Read-Host 'Paste the link here (best as Supabase shows it, with [YOUR-PASSWORD])').Trim().Trim('"').Trim("'")
if ($Link -notmatch '^postgres(ql)?://') { Fail 'That is not a database link (it must start with postgresql://).' }
if ($Link -match ':6543') { Fail 'That is the Transaction pooler (port 6543). Choose "Session pooler" (port 5432).' }
if ($Link -notmatch 'pooler\.supabase\.com') { Fail 'That is not the Session pooler link (it must contain pooler.supabase.com). "Direct connection" needs IPv6.' }
if ($Link -match '\[YOUR-PASSWORD\]') {
  $secure = Read-Host 'Type (or paste) the database password - it is not shown' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if (-not $plain) { Fail 'No password was given.' }
  $Link = $Link.Replace('[YOUR-PASSWORD]', [Uri]::EscapeDataString($plain))
}
Start-Transcript -Path "$Root\move-to-supabase-log.txt" -Append | Out-Null
$base, $query = $Link.Split('?', 2)
$kept = @()
if ($query) { $kept = @($query.Split('&') | Where-Object { $_ -and $_ -notmatch '^(uselibpqcompat|pgbouncer|connection_limit|pool_timeout|schema|sslmode)=' }) }
$Tool = $base + '?' + (@('sslmode=require') + $kept -join '&')              # for psql / pg_dump / pg_restore
$Server = $base + '?' + (@('sslmode=require', 'uselibpqcompat=true') + $kept -join '&')   # for the server (Node.js)

$one = (Psql $Tool 'select 1').Trim()
if ($one -ne '1') {
  Fail ("Could not connect to Supabase. Check: the password; in Supabase -> Project Settings -> Database -> " +
        "Network Restrictions, this VPS's IP address is allowed; the project is not paused.")
}
$version = (Psql $Tool 'show server_version').Trim()
Ok "Connected to Supabase (PostgreSQL $version)."
$tables = [int]("0" + (Psql $Tool "select count(*) from pg_tables where schemaname='public'").Trim())
$Clean = @()
if ($tables -gt 0) {
  Warn "Supabase already has $tables table(s) in it."
  $answer = Read-Host 'Replace everything in Supabase with the database from this VPS? Type YES to go on'
  if ($answer -ne 'YES') { Fail 'Stopped: Supabase was left as it is.' }
  $Clean = @('--clean', '--if-exists')
}

# ---------------------------------------------------------------- 3. stop + save
Say '3/6 Stopping the server and saving the database (safety copy)'
nssm stop romva 2>$null | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$Dump = "$Backups\before-supabase-$stamp.dump"
& "$PgBin\pg_dump.exe" $Local --schema=public --no-owner --no-privileges -Fc -f $Dump
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Dump)) { nssm start romva | Out-Null; Fail 'The database could not be saved.' }
Ok "Saved: $Dump ($([math]::Round((Get-Item $Dump).Length / 1MB, 1)) MB)"

# ---------------------------------------------------------------- 4. copy + check
Say '4/6 Copying into Supabase (a few minutes)'
& "$PgBin\pg_restore.exe" --no-owner --no-privileges @Clean -d $Tool $Dump
Write-Host '    (Red lines like "already exists" are harmless: the counts below decide.)' -ForegroundColor DarkGray
$names = (Psql $Local "select tablename from pg_tables where schemaname='public' order by 1").Split("`n") | Where-Object { $_.Trim() }
$bad = 0
Write-Host ''
Write-Host ('    {0,-28} {1,10} {2,10}' -f 'Table', 'this VPS', 'Supabase')
foreach ($name in $names) {
  $a = (Psql $Local "select count(*) from `"$name`"").Trim()
  $b = (Psql $Tool "select count(*) from `"$name`"").Trim()
  $mark = if ($a -eq $b) { '' } else { $bad++; '  <- DIFFERENT' }
  Write-Host ('    {0,-28} {1,10} {2,10}{3}' -f $name, $a, $b, $mark)
}
if ($bad -gt 0) { nssm start romva | Out-Null; Fail "$bad table(s) did not copy completely." }
Ok 'Every table has the same number of rows in Supabase.'

# ---------------------------------------------------------------- 5. switch
Say '5/6 Switching the server to Supabase'
Copy-Item $EnvFile "$EnvFile.before-supabase" -Force
$lines = @(Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^DATABASE_URL=(.*)$') { "# LOCAL_DATABASE_URL=$($matches[1])" }
  elseif ($_ -match '^(DIRECT_URL|DATABASE_SIZE_LIMIT_MB)=') { }
  else { $_ }
})
$lines += "DATABASE_URL=$Server"
$lines += "DIRECT_URL=$Server"
$lines += 'DATABASE_SIZE_LIMIT_MB=500'
Set-Content -Path $EnvFile -Value $lines -Encoding ascii
nssm start romva | Out-Null
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing -TimeoutSec 5 | Out-Null; $healthy = $true; break } catch { }
}
if (-not $healthy) {
  Copy-Item "$EnvFile.before-supabase" $EnvFile -Force
  nssm restart romva | Out-Null
  Fail 'The server did not start with Supabase, so it was switched back. Look at C:\romva\logs\backend.log'
}
Ok 'The server runs on Supabase now.'

# ---------------------------------------------------------------- 6. backups
Say '6/6 Backups: full every Sunday (keeps 8), only the changes on the other nights'
$template = "$Root\backend\deploy\windows\backup.ps1"
if (-not (Test-Path $template)) { Fail 'backend\deploy\windows\backup.ps1 is missing: run C:\romva\update.bat first, then this file again.' }
$backup = (Get-Content $template -Raw)
$backup = $backup.Replace('__NODE__', $Node)
Set-Content -Path "$Root\backup.ps1" -Value $backup -Encoding ascii
icacls "$Root\backup.ps1" /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Register-ScheduledTask -TaskName 'romva backup' -User 'SYSTEM' -RunLevel Highest -Force `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) `
  -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $Root\backup.ps1") | Out-Null
# The move kit from now on: the database stays in Supabase, so the kit carries the settings,
# the passwords and the kept old Resumes (C:\romva\files\kept) - no database copy.
Copy-Item "$Root\backend\deploy\windows\make-move-kit.ps1" "$Root\make-move-kit.ps1" -Force
icacls "$Root\make-move-kit.ps1" /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null

# The first full backup now; the changes count from now on.
& "$PgBin\pg_dump.exe" $Tool --schema=public --no-owner --no-privileges -Fc -f ("$Backups\full-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm') + '.dump')
Set-Content -Path "$Backups\changes-state.json" -Value ('{"lastStart": "' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + '"}') -Encoding ascii
Ok 'First full backup made. From tonight: changes every night, a full backup every Sunday.'

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Green
Write-Host '  DONE. romva runs on Supabase (Tokyo) now.' -ForegroundColor Green
Write-Host '======================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Open https://www.romva.space and check your applications are there.'
Write-Host "  Safety copy of the old database: $Dump"
Write-Host "  To switch back if ever needed: copy $EnvFile.before-supabase over .env and restart the romva service."
Write-Host ''
Write-Host '  To test that a backup can really be put back (changes nothing live), in C:\romva\backend:'
Write-Host '    yarn backup:restore --folder C:\romva\backups --check --admin "postgresql://postgres:<PG_ADMIN_PASSWORD from SECRETS.txt>@localhost:5432/postgres"'
Write-Host ''
Stop-Transcript | Out-Null
