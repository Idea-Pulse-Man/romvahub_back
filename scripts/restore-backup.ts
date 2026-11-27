/**
 * Puts a backup back: the newest weekly full backup, then every daily changes
 * file made after it (scripts/backup-changes.ts), in order.
 *
 *   yarn backup:restore --folder C:\romva\backups --target <database link>
 *   yarn backup:restore --folder C:\romva\backups --check --admin <postgres link to the VPS's own PostgreSQL>
 *
 * --target   the database to restore INTO (everything in its public schema is replaced).
 * --check    a test: restores into a new scratch database on the VPS's own PostgreSQL
 *            (romva_restore_check, made with --admin and dropped after), then compares every
 *            table's row count with the live database (DATABASE_URL). Changes nothing live.
 * --full     a full backup (.dump) other than the newest one.
 * --pg-bin   where pg_restore.exe is (default: the newest C:\Program Files\PostgreSQL\*\bin).
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import pg from 'pg';

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const folder = path.resolve(option('--folder') ?? 'backups');
const check = args.includes('--check');

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const sslFor = (url: string) => (/localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false });

function pgBin(): string {
  const given = option('--pg-bin');
  if (given) return given;
  const root = 'C:\\Program Files\\PostgreSQL';
  if (existsSync(root)) {
    const versions = readdirSync(root).filter((name) => existsSync(path.join(root, name, 'bin', 'pg_restore.exe')));
    versions.sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return path.join(root, versions[0], 'bin');
  }
  return ''; // on PATH
}

/** Options only the Node.js driver knows: pg_restore refuses them. */
function forPgTools(url: string): string {
  const [base, query] = url.split('?', 2);
  if (!query) return url;
  const kept = query.split('&').filter((part) => part && !/^(uselibpqcompat|pgbouncer|connection_limit|pool_timeout|schema)=/.test(part));
  return kept.length ? `${base}?${kept.join('&')}` : base!;
}

/** The newest full backup (full-YYYYMMDDHHMM.dump) and when it was made. */
async function newestFull(): Promise<{ file: string; madeAt: Date }> {
  const given = option('--full');
  const names = (await fs.readdir(folder)).filter((name) => /^full-\d{12}\.dump$/.test(name)).sort();
  const name = given ? path.basename(given) : names[names.length - 1];
  if (!name) throw new Error(`No full backup (full-….dump) in ${folder}.`);
  const file = given ? path.resolve(given) : path.join(folder, name);
  const m = /full-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\.dump$/.exec(name);
  const madeAt = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)) : (await fs.stat(file)).mtime;
  return { file, madeAt };
}

interface TableMeta {
  name: string;
  primaryKey: string[];
  columns: string[];
}

/** Reads one changes file: per table its meta, its changed rows and the keys it has. */
async function readChanges(file: string) {
  const tables = new Map<string, { meta: TableMeta; rows: unknown[]; keys: string[][] }>();
  let until = '';
  let ended = false;
  const lines = readline.createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type === 'meta') until = entry.until;
    else if (entry.type === 'table') tables.set(entry.name, { meta: entry, rows: [], keys: [] });
    else if (entry.type === 'rows') tables.get(entry.table)?.rows.push(...entry.rows);
    else if (entry.type === 'keys') tables.get(entry.table)?.keys.push(...entry.keys);
    else if (entry.type === 'end') ended = true;
  }
  if (!ended) throw new Error(`${path.basename(file)} is incomplete (no end mark).`);
  return { until: new Date(until), tables };
}

/** Table names, parents before children (by the foreign keys). */
async function parentsFirst(client: pg.Client, names: string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(`
    SELECT cc.relname AS child, pc.relname AS parent
    FROM pg_constraint k JOIN pg_class cc ON cc.oid = k.conrelid JOIN pg_class pc ON pc.oid = k.confrelid
    WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND k.conrelid <> k.confrelid`);
  const parents = new Map<string, Set<string>>();
  for (const name of names) parents.set(name, new Set());
  for (const { child, parent } of rows) if (parents.has(child) && parents.has(parent)) parents.get(child)!.add(parent);
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (name: string, path: Set<string>) => {
    if (done.has(name) || path.has(name)) return;
    path.add(name);
    for (const parent of parents.get(name) ?? []) visit(parent, path);
    done.add(name);
    order.push(name);
  };
  for (const name of names) visit(name, new Set());
  return order;
}

/** One changes file on top of the database: changed rows written (parents first), then deleted rows removed (children first). */
async function applyChanges(client: pg.Client, file: string): Promise<number> {
  const { tables } = await readChanges(file);
  const order = await parentsFirst(client, [...tables.keys()]);
  let written = 0;
  await client.query('BEGIN');
  try {
    for (const name of order) {
      const { meta, rows } = tables.get(name)!;
      if (rows.length === 0) continue;
      const target = quote(name);
      const conflict = meta.primaryKey.length
        ? `ON CONFLICT (${meta.primaryKey.map(quote).join(', ')}) DO UPDATE SET ${meta.columns
            .filter((column) => !meta.primaryKey.includes(column))
            .map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`)
            .join(', ') || `${quote(meta.primaryKey[0]!)} = EXCLUDED.${quote(meta.primaryKey[0]!)}`}`
        : 'ON CONFLICT DO NOTHING';
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await client.query(
          `INSERT INTO ${target} SELECT * FROM json_populate_recordset(NULL::${target}, $1::json) ${conflict}`,
          [JSON.stringify(chunk)],
        );
        written += chunk.length;
      }
    }
    for (const name of [...order].reverse()) {
      const { meta, keys } = tables.get(name)!;
      if (meta.primaryKey.length === 0) continue;
      await client.query('CREATE TEMP TABLE IF NOT EXISTS restore_keep (k text[]) ON COMMIT DROP');
      await client.query('TRUNCATE restore_keep');
      for (let i = 0; i < keys.length; i += 5_000) {
        await client.query(
          `INSERT INTO restore_keep SELECT ARRAY(SELECT jsonb_array_elements_text(e)) FROM jsonb_array_elements($1::jsonb) e`,
          [JSON.stringify(keys.slice(i, i + 5_000))],
        );
      }
      const key = `ARRAY[${meta.primaryKey.map((column) => `${quote(column)}::text`).join(', ')}]`;
      await client.query(`DELETE FROM ${quote(name)} WHERE ${key} NOT IN (SELECT k FROM restore_keep)`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return written;
}

async function counts(url: string): Promise<Map<string, number>> {
  const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    );
    const result = new Map<string, number>();
    for (const { name } of rows) result.set(name, Number((await client.query(`SELECT count(*) AS n FROM ${quote(name)}`)).rows[0].n));
    return result;
  } finally {
    await client.end();
  }
}

async function restoreInto(target: string): Promise<void> {
  const full = await newestFull();
  console.log(`Full backup: ${path.basename(full.file)} (made ${full.madeAt.toISOString()})`);
  const bin = pgBin();
  const pgRestore = bin ? path.join(bin, 'pg_restore.exe') : 'pg_restore';
  const result = spawnSync(
    pgRestore,
    ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--schema=public', '-d', forPgTools(target), full.file],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  // pg_restore reports harmless notes (a schema that already exists) with a non-zero code: the counts tell.

  const changes = (await fs.readdir(folder)).filter((name) => /^changes-\d{12}\.jsonl\.gz$/.test(name)).sort();
  const client = new pg.Client({ connectionString: target, ssl: sslFor(target) });
  await client.connect();
  try {
    for (const name of changes) {
      const m = /changes-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)!;
      const madeAt = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
      if (madeAt <= full.madeAt) continue; // older than the full backup: already in it
      const written = await applyChanges(client, path.join(folder, name));
      console.log(`  + ${name}: ${written} rows`);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (!check) {
    const target = option('--target');
    if (!target) throw new Error('Give --target <database link> (or --check for a test).');
    await restoreInto(target);
    console.log('Restored.');
    return;
  }

  const admin = option('--admin');
  const live = process.env.DATABASE_URL;
  if (!admin || !live) throw new Error('--check needs --admin <postgres link to this VPS\'s PostgreSQL> and DATABASE_URL.');
  const scratchName = 'romva_restore_check';
  const adminClient = new pg.Client({ connectionString: admin, ssl: sslFor(admin) });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${scratchName}`);
  await adminClient.query(`CREATE DATABASE ${scratchName}`);
  const scratch = new URL(admin);
  scratch.pathname = `/${scratchName}`;
  try {
    await restoreInto(scratch.toString());
    const [restored, current] = await Promise.all([counts(scratch.toString()), counts(live)]);
    let differ = 0;
    console.log('\nTable                      restored   live');
    for (const [name, n] of current) {
      const back = restored.get(name) ?? 0;
      const mark = back === n ? '' : '   <- differs';
      if (mark) differ += 1;
      console.log(`${name.padEnd(26)} ${String(back).padStart(8)} ${String(n).padStart(6)}${mark}`);
    }
    console.log(
      differ === 0
        ? '\nRESTORE CHECK PASSED: every table came back with the same number of rows.'
        : `\nRESTORE CHECK: ${differ} table(s) differ. Rows written since the last backup are expected to be missing.`,
    );
  } finally {
    await adminClient.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined);
    await adminClient.end();
  }
}

main().catch((error) => {
  console.error('Restore FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
