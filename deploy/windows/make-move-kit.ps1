# The romva move kit for a server on Supabase. Copied to C:\romva\make-move-kit.ps1 by
# romva-move-to-supabase.bat and romva-vps-setup.bat; run it with C:\romva\make-move-kit.bat.
#
# The database stays in Supabase, so the kit carries what is on this VPS only: the
# settings (.env, with the database link and the secret keys), the passwords, and the
# old Resumes kept as files (C:\romva\files\kept). No database copy.
$Root = 'C:\romva'
$kit = "$Root\romva-move-kit"
New-Item -ItemType Directory -Force -Path $kit | Out-Null
Copy-Item "$Root\backend\.env" "$kit\backend.env" -Force
Copy-Item "$Root\SECRETS.txt" "$kit\SECRETS.txt" -Force
if (Test-Path "$Root\files\kept") { Copy-Item "$Root\files\kept" "$kit\kept" -Recurse -Force }
Set-Content "$kit\README.txt" -Encoding ascii -Value @(
  ('romva move kit - made ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')),
  '',
  'The database is in Supabase: this kit holds the settings, the passwords and the kept old Resumes.',
  'To move romva to a new VPS:',
  '  1. In Supabase -> Project Settings -> Database -> Network Restrictions, allow the NEW VPS IP address.',
  '  2. Copy this folder AND romva-vps-setup.bat side by side to the new VPS.',
  '  3. Double-click romva-vps-setup.bat there.',
  '  4. Point the domain (DNS A records) at the new VPS.',
  '',
  'KEEP THIS FOLDER PRIVATE: it holds the secret keys and the database password.'
)
Write-Host "DONE: $kit. Copy this folder to your own PC." -ForegroundColor Green
Start-Process explorer.exe $kit
