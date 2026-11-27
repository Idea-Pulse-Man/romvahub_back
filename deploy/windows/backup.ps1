# romva backup for a server on Supabase. Copied to C:\romva\backup.ps1 by
# romva-move-to-supabase.bat (and by romva-vps-setup.bat on a Supabase server);
# the "romva backup" task runs it every night at 3 AM.
#
# Sunday (or no full backup yet): the whole database -> full-<UTC time>.dump (the newest 8 are kept).
# The other nights: only what changed -> changes-<UTC time>.jsonl.gz (yarn backup:changes).
# Restore: yarn backup:restore (see backend\scripts\restore-backup.ts).
# The database link is read from C:\romva\backend\.env each time, so a new password needs no change here.
$Root = 'C:\romva'; $Backups = "$Root\backups"; $Log = "$Root\logs\backup.log"
New-Item -ItemType Directory -Force -Path $Backups, "$Root\logs" | Out-Null
function Log($t) { Add-Content $Log ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $t) }
$PgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' | Sort-Object FullName -Descending | Select-Object -First 1).DirectoryName
$url = ((Get-Content "$Root\backend\.env" | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=', '')
$base, $query = $url.Split('?', 2)
$keep = @()
if ($query) { $keep = @($query.Split('&') | Where-Object { $_ -and $_ -notmatch '^(uselibpqcompat|pgbouncer|connection_limit|pool_timeout|schema)=' }) }
$tool = if ($keep.Count) { $base + '?' + ($keep -join '&') } else { $base }

$fulls = @(Get-ChildItem "$Backups\full-*.dump" -ErrorAction SilentlyContinue | Sort-Object Name)
if ((Get-Date).DayOfWeek -eq 'Sunday' -or $fulls.Count -eq 0) {
  $file = "$Backups\full-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm') + '.dump'
  & "$PgBin\pg_dump.exe" $tool --schema=public --no-owner --no-privileges -Fc -f $file
  if ($LASTEXITCODE -eq 0) { Log "full backup: $file ($([math]::Round((Get-Item $file).Length / 1MB, 1)) MB)" } else { Log 'FULL BACKUP FAILED' }
} else {
  Push-Location "$Root\backend"
  $out = & '__NODE__' 'node_modules\tsx\dist\cli.mjs' 'scripts\backup-changes.ts' $Backups 2>&1
  Pop-Location
  Log ($out -join ' ')
}

# Keep the newest 8 full backups, and the change files from the oldest kept one on.
$fulls = @(Get-ChildItem "$Backups\full-*.dump" -ErrorAction SilentlyContinue | Sort-Object Name)
if ($fulls.Count -gt 8) { $fulls | Select-Object -First ($fulls.Count - 8) | Remove-Item }
$oldest = Get-ChildItem "$Backups\full-*.dump" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
if ($oldest) {
  $cut = $oldest.Name -replace '^full-', 'changes-' -replace '\.dump$', ''
  Get-ChildItem "$Backups\changes-*.jsonl.gz" -ErrorAction SilentlyContinue | Where-Object { $_.Name -lt $cut } | Remove-Item
}
# The nightly copies of the old database on this VPS (before Supabase): 14 days.
Get-ChildItem "$Backups\romva-*.dump" -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item
