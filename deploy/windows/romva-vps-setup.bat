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
# romva server setup for a Windows VPS - everything from A to Z.
#
# Double-click this file on the VPS. It:
#   1. installs PostgreSQL 17, Node.js, Git, Chrome, NSSM and Caddy
#   2. creates the database (passwords are made for you)
#   3. copies your data from Supabase (asks for the Supabase address once)
#   4. downloads the code from GitHub (a GitHub sign-in window may open)
#   5. builds the website and the server and writes the settings (.env)
#   6. runs the server as a Windows service (starts with Windows)
#   7. turns on HTTPS (Caddy) and opens ports 80 and 443
#   8. makes a backup every night at 3 AM (keeps 14 days)
#   9. writes C:\romva\update.bat for later updates
#
# Safe to run again: finished steps are skipped or refreshed.
# Passwords are saved in C:\romva\SECRETS.txt (only administrators can read it).
# Everything shown on screen is also saved in C:\romva\setup-log.txt.
# ============================================================================

$ErrorActionPreference = 'Continue'
$Root = 'C:\romva'
New-Item -ItemType Directory -Force -Path $Root, "$Root\logs", "$Root\backups", 'C:\tools' | Out-Null
Start-Transcript -Path "$Root\setup-log.txt" -Append | Out-Null

function Say($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK: $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    NOTE: $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Write-Host 'Send a screenshot of this window (and the file C:\romva\setup-log.txt).' -ForegroundColor Red
  Stop-Transcript | Out-Null
  Read-Host 'Press Enter to close'
  exit 1
}
function NewPassword([int]$length = 24) {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  -join (1..$length | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}
function AddToPath($dir) { if ((Test-Path $dir) -and ($env:Path -notlike "*$dir*")) { $env:Path = "$env:Path;$dir" } }

Write-Host ''
Write-Host '  romva server setup' -ForegroundColor White
Write-Host '  This takes about 20-30 minutes. Keep this window open.' -ForegroundColor White
Write-Host ''

# ---------------------------------------------------------------- move kit
# Moving from another VPS: a folder "romva-move-kit" next to this file (made there
# with C:\romva\make-move-kit.bat) brings the database, the settings and the
# passwords, so nobody has to sign in again.
$Kit = $null
if ($f) {
  $candidate = Join-Path (Split-Path -Parent $f) 'romva-move-kit'
  if (Test-Path "$candidate\romva.dump") { $Kit = $candidate }
}
if ($Kit) {
  Write-Host "  Move kit found: $Kit" -ForegroundColor Green
  if ((Test-Path "$Kit\SECRETS.txt") -and -not (Test-Path "$Root\SECRETS.txt")) { Copy-Item "$Kit\SECRETS.txt" "$Root\SECRETS.txt" }
}

# ---------------------------------------------------------------- secrets
$SecretsFile = "$Root\SECRETS.txt"
$S = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $S[$matches[1]] = $matches[2] } }
}
if (-not $S['PG_ADMIN_PASSWORD']) { $S['PG_ADMIN_PASSWORD'] = NewPassword }
if (-not $S['DB_PASSWORD']) { $S['DB_PASSWORD'] = NewPassword }
function SaveSecrets {
  $lines = @('# romva server passwords - keep this file safe.')
  $lines += $S.Keys | Sort-Object | ForEach-Object { "$_=$($S[$_])" }
  Set-Content -Path $SecretsFile -Value $lines -Encoding ascii
  icacls $SecretsFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
}

$Domain = $S['DOMAIN']
if (-not $Domain) {
  $Domain = Read-Host 'Your domain name (just press Enter for romva.space)'
  if (-not $Domain) { $Domain = 'romva.space' }
}
$Domain = $Domain.Trim().ToLower() -replace '^https?://', '' -replace '^www\.', '' -replace '/.*$', ''
$S['DOMAIN'] = $Domain
SaveSecrets
Ok "Domain: $Domain (the site will be https://www.$Domain)"

# ---------------------------------------------------------------- 1. programs
Say '1/9 Installing the programs (10-15 minutes)'
$ChocoDir = "$env:ALLUSERSPROFILE\chocolatey"
AddToPath "$ChocoDir\bin"
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  AddToPath "$ChocoDir\bin"
}
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) { Fail 'The installer tool (Chocolatey) could not be installed. Check the internet on the VPS.' }

$pgInstalled = Test-Path 'C:\Program Files\PostgreSQL\*\bin\psql.exe'
if (-not $pgInstalled) {
  choco install -y --no-progress postgresql17 --params "/Password:$($S['PG_ADMIN_PASSWORD'])"
}
choco install -y --no-progress nodejs-lts git nssm caddy
function FindChrome {
  $places = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe')
  $places += Get-ChildItem 'C:\Users\*\AppData\Local\Google\Chrome\Application\chrome.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  $places | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not (FindChrome)) { choco install -y --no-progress googlechrome --ignore-checksums }

AddToPath 'C:\Program Files\nodejs'
AddToPath 'C:\Program Files\Git\cmd'
AddToPath "$env:APPDATA\npm"
foreach ($cmd in 'node', 'npm', 'git', 'nssm') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "$cmd was not installed. Run this file again." }
}
$PgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1).DirectoryName
if (-not $PgBin) { Fail 'PostgreSQL was not installed. Run this file again.' }
$Chrome = FindChrome
if ($Chrome) { Ok "Chrome found: $Chrome" }
if (-not $Chrome) { Warn 'Chrome was not found: PDF resumes need it. Install Google Chrome later and run this file again.' }
Ok "Node $(node --version), PostgreSQL in $PgBin"

# ---------------------------------------------------------------- 2. database
Say '2/9 Creating the database'
$env:PGPASSWORD = $S['PG_ADMIN_PASSWORD']
& "$PgBin\psql.exe" -U postgres -h localhost -tAc 'select 1' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Warn 'PostgreSQL was already on this computer, with its own password.'
  $S['PG_ADMIN_PASSWORD'] = Read-Host "Type the password of the 'postgres' database user"
  SaveSecrets
  $env:PGPASSWORD = $S['PG_ADMIN_PASSWORD']
  & "$PgBin\psql.exe" -U postgres -h localhost -tAc 'select 1' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Could not sign in to PostgreSQL as 'postgres'." }
}
$role = (& "$PgBin\psql.exe" -U postgres -h localhost -tAc "select 1 from pg_roles where rolname='romva'") -join ''
if ($role.Trim() -eq '1') {
  & "$PgBin\psql.exe" -U postgres -h localhost -c "ALTER USER romva WITH PASSWORD '$($S['DB_PASSWORD'])';" | Out-Null
} else {
  & "$PgBin\psql.exe" -U postgres -h localhost -c "CREATE USER romva WITH PASSWORD '$($S['DB_PASSWORD'])';" | Out-Null
}
$db = (& "$PgBin\psql.exe" -U postgres -h localhost -tAc "select 1 from pg_database where datname='romva'") -join ''
if ($db.Trim() -ne '1') {
  & "$PgBin\psql.exe" -U postgres -h localhost -c 'CREATE DATABASE romva OWNER romva;' | Out-Null
}
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
$DbUrl = "postgresql://romva:$($S['DB_PASSWORD'])@localhost:5432/romva"
& "$PgBin\psql.exe" $DbUrl -tAc 'select 1' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'The romva database could not be created.' }
Ok 'Database romva is ready (only this VPS can reach it).'

# ---------------------------------------------------------------- 3. data
Say '3/9 Copying your data from Supabase'
$count = (& "$PgBin\psql.exe" $DbUrl -tAc 'select count(*) from bids' 2>$null) -join ''
if ($LASTEXITCODE -eq 0 -and [int]("0" + $count.Trim()) -gt 0) {
  Ok "Your data is already here ($($count.Trim()) applications). Skipping the copy."
} elseif ($Kit) {
  Ok 'Loading the database from the move kit...'
  & "$PgBin\pg_restore.exe" --no-owner --no-privileges -d $DbUrl "$Kit\romva.dump"
  $count = (& "$PgBin\psql.exe" $DbUrl -tAc 'select count(*) from bids' 2>$null) -join ''
  if ([int]("0" + $count.Trim()) -le 0) { Fail 'The move kit did not load (no applications in the new database).' }
  Ok "Loaded from the move kit: $($count.Trim()) applications. (Red lines like 'already exists' are harmless.)"
} else {
  Write-Host ''
  Write-Host '    On YOUR OWN PC, open the file  D:\workspace\romvahub\backend\.env' -ForegroundColor White
  Write-Host '    and copy everything after  DIRECT_URL=  (it starts with postgresql://)' -ForegroundColor White
  Write-Host ''
  $Source = (Read-Host 'Paste the Supabase address here').Trim().Trim('"').Trim("'")
  if ($Source -notlike 'postgres*') { Fail 'That does not look like a database address (it must start with postgresql://).' }
  # Options only the Node.js driver knows (pg_dump refuses them), e.g. uselibpqcompat.
  if ($Source.Contains('?')) {
    $base, $query = $Source.Split('?', 2)
    $kept = $query.Split('&') | Where-Object { $_ -and $_ -notmatch '^(uselibpqcompat|pgbouncer|connection_limit|pool_timeout|schema)=' }
    $Source = if ($kept) { $base + '?' + ($kept -join '&') } else { $base }
  }
  & "$PgBin\pg_dump.exe" $Source --schema=public --no-owner --no-privileges -Fc -f "$Root\supabase.dump"
  if ($LASTEXITCODE -ne 0) { Fail 'Could not read from Supabase. Check the address and try again.' }
  Ok 'Downloaded. Loading it into the new database...'
  & "$PgBin\pg_restore.exe" --no-owner --no-privileges -d $DbUrl "$Root\supabase.dump"
  $count = (& "$PgBin\psql.exe" $DbUrl -tAc 'select count(*) from bids' 2>$null) -join ''
  if ([int]("0" + $count.Trim()) -le 0) { Fail 'The copy did not arrive (no applications in the new database).' }
  Ok "Copied: $($count.Trim()) applications. (Red lines above like 'already exists' are harmless.)"
}

# ---------------------------------------------------------------- 4. code
Say '4/9 Downloading the code from GitHub'
Write-Host '    If a GitHub sign-in window opens, sign in with your GitHub account.' -ForegroundColor White
$repos = @(
  @{ Name = 'backend'; Url = 'https://github.com/Idea-Pulse-Man/romvahub_back.git' },
  @{ Name = 'frontend'; Url = 'https://github.com/Idea-Pulse-Man/romvahub_front.git' }
)
foreach ($repo in $repos) {
  $dir = "$Root\$($repo.Name)"
  if (Test-Path "$dir\.git") { git -C $dir pull } else { git clone -b dev $repo.Url $dir }
  if (-not (Test-Path "$dir\package.json")) { Fail "Could not download the $($repo.Name) code from GitHub." }
}
Ok 'Code downloaded.'

# ---------------------------------------------------------------- 5. build
Say '5/9 Building the website and the server (5-10 minutes)'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { npm install -g corepack }
AddToPath "$env:APPDATA\npm"
corepack enable
if (-not (Get-Command yarn -ErrorAction SilentlyContinue)) { Fail 'yarn could not be set up (corepack).' }

Push-Location "$Root\frontend"
yarn install --immutable; if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Installing the website packages failed.' }
yarn build; if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Building the website failed.' }
Pop-Location
Ok 'Website built.'

$EnvFile = "$Root\backend\.env"
if (-not (Test-Path $EnvFile) -and $Kit -and (Test-Path "$Kit\backend.env")) {
  Copy-Item "$Kit\backend.env" $EnvFile
  Ok 'Settings taken from the move kit (same secret keys: everyone stays signed in).'
}
if (-not (Test-Path $EnvFile)) {
  $keys = (node -e "const c=require('crypto');console.log([c.randomBytes(48).toString('hex'),c.randomBytes(48).toString('hex'),c.randomBytes(32).toString('base64')].join(' '))").Split(' ')
  $lines = @(
    'NODE_ENV=production',
    'PORT=4000',
    'LOG_LEVEL=info',
    "DATABASE_URL=$DbUrl",
    "JWT_ACCESS_SECRET=$($keys[0])",
    "JWT_REFRESH_SECRET=$($keys[1])",
    "CONFIG_ENCRYPTION_KEY=$($keys[2])",
    'ACCESS_TOKEN_TTL=15m',
    'REFRESH_TOKEN_TTL_DAYS=30',
    "CORS_ORIGIN=https://www.$Domain",
    "FRONTEND_DIR=$Root\frontend\dist\public",
    'CHATGPT_AUTO_MAKE=false',
    '# No AI API key: resumes are made by the desktop app with ChatGPT / Claude / Gemini.',
    '# To use an API later, enter the key on the website: AI Settings.',
    'AI_PROVIDER=openai'
  )
  if ($Chrome) { $lines += "PUPPETEER_EXECUTABLE_PATH=$Chrome" }
  Set-Content -Path $EnvFile -Value $lines -Encoding ascii
  Ok 'Settings file written (C:\romva\backend\.env).'
} else {
  # Kept, but the lines that belong to THIS computer are set again.
  $here = @{ 'DATABASE_URL' = $DbUrl; 'FRONTEND_DIR' = "$Root\frontend\dist\public"; 'CORS_ORIGIN' = "https://www.$Domain" }
  if ($Chrome) { $here['PUPPETEER_EXECUTABLE_PATH'] = $Chrome }
  $lines = @(Get-Content $EnvFile | Where-Object { $_ -notmatch '^(DATABASE_URL|DIRECT_URL|FRONTEND_DIR|CORS_ORIGIN|PUPPETEER_EXECUTABLE_PATH)=' })
  $lines += $here.Keys | ForEach-Object { "$_=$($here[$_])" }
  Set-Content -Path $EnvFile -Value $lines -Encoding ascii
  Ok 'Settings file kept (database address and folders updated for this computer).'
}

Push-Location "$Root\backend"
yarn install --immutable; if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Installing the server packages failed.' }
yarn build; if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Building the server failed.' }
yarn prisma:deploy; if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Updating the database tables failed.' }
Pop-Location
Ok 'Server built and database tables up to date.'

# ---------------------------------------------------------------- 6. service
Say '6/9 Starting the server as a Windows service'
$Node = (Get-Command node).Source
if (-not (Get-Service romva -ErrorAction SilentlyContinue)) { nssm install romva $Node 'dist\index.js' | Out-Null }
nssm set romva Application $Node | Out-Null
nssm set romva AppParameters 'dist\index.js' | Out-Null
nssm set romva AppDirectory "$Root\backend" | Out-Null
nssm set romva AppStdout "$Root\logs\backend.log" | Out-Null
nssm set romva AppStderr "$Root\logs\backend.log" | Out-Null
nssm set romva AppRotateFiles 1 | Out-Null
nssm set romva AppRotateBytes 10485760 | Out-Null
nssm set romva Start SERVICE_AUTO_START | Out-Null
nssm stop romva 2>$null | Out-Null
nssm start romva | Out-Null
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing -TimeoutSec 5 | Out-Null; $healthy = $true; break } catch { }
}
if (-not $healthy) { Fail 'The server did not start. Look at C:\romva\logs\backend.log' }
Ok 'Server is running on this VPS (it starts by itself with Windows).'

# ---------------------------------------------------------------- 7. https
Say '7/9 Turning on HTTPS and opening ports 80 and 443'
$Caddy = (Get-ChildItem "$ChocoDir\lib\caddy" -Recurse -Filter caddy.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $Caddy) { Fail 'Caddy was not installed. Run this file again.' }
Set-Content -Path 'C:\tools\Caddyfile' -Value @("$Domain, www.$Domain {", '    reverse_proxy localhost:4000', '}') -Encoding ascii
if (-not (Get-Service caddy -ErrorAction SilentlyContinue)) { nssm install caddy $Caddy | Out-Null }
nssm set caddy Application $Caddy | Out-Null
nssm set caddy AppParameters 'run --config C:\tools\Caddyfile --adapter caddyfile' | Out-Null
nssm set caddy AppDirectory 'C:\tools' | Out-Null
nssm set caddy AppStdout "$Root\logs\caddy.log" | Out-Null
nssm set caddy AppStderr "$Root\logs\caddy.log" | Out-Null
nssm set caddy Start SERVICE_AUTO_START | Out-Null
nssm stop caddy 2>$null | Out-Null
nssm start caddy | Out-Null
foreach ($port in 80, 443) {
  if (-not (Get-NetFirewallRule -DisplayName "romva $port" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "romva $port" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
  }
}
Ok 'HTTPS is on. (The certificate arrives by itself once the domain points to this VPS.)'

# ---------------------------------------------------------------- 8. backup
Say '8/9 Nightly backup (3 AM, keeps 14 days)'
$backup = @(
  "& '$PgBin\pg_dump.exe' '$DbUrl' -Fc -f ('$Root\backups\romva-' + (Get-Date -Format yyyy-MM-dd) + '.dump')",
  "Get-ChildItem '$Root\backups\*.dump' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item"
)
Set-Content -Path "$Root\backup.ps1" -Value $backup -Encoding ascii
icacls "$Root\backup.ps1" /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Register-ScheduledTask -TaskName 'romva backup' -User 'SYSTEM' -RunLevel Highest -Force `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) `
  -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $Root\backup.ps1") | Out-Null
Ok 'Backups go to C:\romva\backups every night.'

# ---------------------------------------------------------------- 9. update file
Say '9/9 Writing C:\romva\update.bat (for later updates)'
$update = @(
  '@echo off',
  'rem Gets the newest code, builds it and restarts the server. Run as administrator.',
  'set COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
  'cd /d C:\romva\frontend && git pull && call yarn install --immutable && call yarn build || goto :failed',
  'cd /d C:\romva\backend && git pull && call yarn install --immutable && call yarn build && call yarn prisma:deploy || goto :failed',
  'nssm restart romva',
  'echo Updated.',
  'pause',
  'exit /b',
  ':failed',
  'echo Update FAILED. Send a screenshot of this window.',
  'pause'
)
Set-Content -Path "$Root\update.bat" -Value $update -Encoding ascii

# The move kit: everything needed to move romva to another VPS (or keep a copy on your PC).
$kitScript = @(
  "`$kit = '$Root\romva-move-kit'",
  'New-Item -ItemType Directory -Force -Path $kit | Out-Null',
  "Write-Host 'Making the move kit: saving the whole database...'",
  "& '$PgBin\pg_dump.exe' '$DbUrl' -Fc -f `"`$kit\romva.dump`"",
  'if ($LASTEXITCODE -ne 0) { Write-Host ''FAILED: the database could not be saved.'' -ForegroundColor Red; exit 1 }',
  "Copy-Item '$Root\backend\.env' `"`$kit\backend.env`" -Force",
  "Copy-Item '$Root\SECRETS.txt' `"`$kit\SECRETS.txt`" -Force",
  'Set-Content "$kit\README.txt" -Value @(''romva move kit - made '' + (Get-Date -Format ''yyyy-MM-dd HH:mm''), '''', ''To move romva to a new VPS: copy this whole folder AND romva-vps-setup.bat'', ''to the new VPS, side by side (same folder), then double-click romva-vps-setup.bat.'', '''', ''KEEP THIS FOLDER PRIVATE: it holds your whole database and the secret keys.'')',
  '$size = [math]::Round((Get-ChildItem $kit | Measure-Object Length -Sum).Sum / 1MB, 1)',
  'Write-Host "DONE: $kit ($size MB). Copy this folder to your own PC." -ForegroundColor Green',
  'Start-Process explorer.exe $kit'
)
Set-Content -Path "$Root\make-move-kit.ps1" -Value $kitScript -Encoding ascii
icacls "$Root\make-move-kit.ps1" /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Set-Content -Path "$Root\make-move-kit.bat" -Encoding ascii -Value @(
  '@echo off',
  'rem Saves the whole database + settings into C:\romva\romva-move-kit (run as administrator).',
  'powershell -NoProfile -ExecutionPolicy Bypass -File C:\romva\make-move-kit.ps1',
  'pause'
)
Ok 'Done. (To keep a copy on your PC or move to a new VPS: run C:\romva\make-move-kit.bat)'

# ---------------------------------------------------------------- finish
$ip = ''
try { $ip = (Invoke-RestMethod 'https://api.ipify.org' -TimeoutSec 10).ToString().Trim() } catch { $ip = '(your VPS IP)' }
Write-Host ''
Write-Host '======================================================================' -ForegroundColor Green
Write-Host '  ALL DONE. The server is running.' -ForegroundColor Green
Write-Host '======================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  LAST STEP (on namecheap.com -> Domain List -> ' -NoNewline; Write-Host $Domain -NoNewline -ForegroundColor Yellow; Write-Host ' -> Advanced DNS):'
Write-Host '    1. Delete the old Vercel records for @ and www'
Write-Host "    2. Add A Record   Host: @     Value: $ip" -ForegroundColor Yellow
Write-Host "    3. Add A Record   Host: www   Value: $ip" -ForegroundColor Yellow
Write-Host ''
Write-Host "  Then wait 5-30 minutes and open  https://www.$Domain"
Write-Host ''
Write-Host '  If your VPS company has a firewall in its own website panel, open ports 80 and 443 there.'
Write-Host '  Passwords: C:\romva\SECRETS.txt     Server log: C:\romva\logs\backend.log'
Write-Host '  Update later: right-click C:\romva\update.bat -> Run as administrator'
Write-Host '  Copy of the database for your PC / a new VPS: right-click C:\romva\make-move-kit.bat -> Run as administrator'
Write-Host ''
Stop-Transcript | Out-Null
