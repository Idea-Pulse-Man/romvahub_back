/**
 * The daily backup between the weekly full ones: only what changed.
 *
 *   yarn backup:changes <folder>          (the VPS's backup task runs it on the nights a full backup is not made)
 *
 * Writes <folder>\changes-<date>.jsonl.gz with, for every table:
 *   - the rows added or changed since the last run (by "updatedAt", else "createdAt";
 *     a small table is written whole, so nothing in it can slip through),
 *   - the keys of every row it has now, so a restore knows which rows were deleted.
 * A run covers from the start of the previous one (minus 10 minutes, to be safe) to now;
 * the time is kept in <folder>\changes-state.json. scripts/restore-backup.ts puts a full
 * backup and these files back together.
 *
 * Only reads the database. Rows are read with row_to_json, and written back by the
 * restore with json_populate_record, so every column type comes back as it was.
 */
import 'dotenv/config';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import pg from 'pg';

const SMALL_TABLE = 5_000;
const OVERLAP_MS = 10 * 60_000;
const CHUNK = 500;

export interface TableInfo {
  name: string;
  primaryKey: string[];
  columns: string[];
}

/** The tables of the public schema, with their primary keys and columns. */
export async function tablesOf(client: pg.Client): Promise<TableInfo[]> {
  const { rows } = await client.query<{ name: string; pk: string[] | null; columns: string[] }>(`
    SELECT c.relname AS name,
      (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = c.oid AND i.indisprimary) AS pk,
      (SELECT array_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`);
  return rows.map((row) => ({ name: row.name, primaryKey: row.pk ?? [], columns: row.columns }));
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function main(): Promise<void> {
  const folder = path.resolve(process.argv[2] ?? 'backups');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  await fs.mkdir(folder, { recursive: true });
  const stateFile = path.join(folder, 'changes-state.json');
  const started = new Date();
  let since: Date | null = null;
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { lastStart?: string };
    if (state.lastStart) since = new Date(Date.parse(state.lastStart) - OVERLAP_MS);
  } catch {
    // First run: everything counts as changed.
  }

  const client = new pg.Client({ connectionString: url, ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  const stamp = started.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const file = path.join(folder, `changes-${stamp}.jsonl.gz`);
  const temporary = `${file}.part`;
  const gzip = createGzip();
  const out = createWriteStream(temporary);
  gzip.pipe(out);
  const write = (value: unknown) =>
    new Promise<void>((resolve) => {
      if (gzip.write(`${JSON.stringify(value)}\n`)) resolve();
      else gzip.once('drain', () => resolve());
    });

  let changedRows = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await write({ type: 'meta', version: 1, since: since?.toISOString() ?? null, until: started.toISOString() });
    for (const table of await tablesOf(client)) {
      const count = Number((await client.query(`SELECT count(*) AS n FROM ${quote(table.name)}`)).rows[0].n);
      const timeColumn = table.columns.includes('updatedAt') ? 'updatedAt' : table.columns.includes('createdAt') ? 'createdAt' : null;
      const whole = !since || count <= SMALL_TABLE || !timeColumn;
      await write({ type: 'table', name: table.name, primaryKey: table.primaryKey, columns: table.columns, whole, count });
      const where = whole ? '' : `WHERE ${quote(timeColumn!)} >= $1`;
      const params = whole ? [] : [since!.toISOString().replace('T', ' ').replace('Z', '')];
      const cursorName = `rows_${table.name.replace(/\W/g, '_')}`;
      await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT row_to_json(t) AS r FROM ${quote(table.name)} t ${where}`, params);
      for (;;) {
        const { rows } = await client.query<{ r: unknown }>(`FETCH ${CHUNK} FROM ${cursorName}`);
        if (rows.length === 0) break;
        changedRows += rows.length;
        await write({ type: 'rows', table: table.name, rows: rows.map((row) => row.r) });
      }
      await client.query(`CLOSE ${cursorName}`);
      if (table.primaryKey.length > 0) {
        const keys = table.primaryKey.map((column) => `${quote(column)}::text`).join(', ');
        const { rows } = await client.query<{ k: string[] }>(`SELECT ARRAY[${keys}] AS k FROM ${quote(table.name)}`);
        for (let i = 0; i < rows.length; i += 5_000) {
          await write({ type: 'keys', table: table.name, keys: rows.slice(i, i + 5_000).map((row) => row.k) });
        }
      }
    }
    await write({ type: 'end', rows: changedRows });
    await client.query('COMMIT');
  } finally {
    await client.end().catch(() => undefined);
    gzip.end();
    await new Promise<void>((resolve, reject) => out.on('close', () => resolve()).on('error', reject));
  }
  await fs.rename(temporary, file);
  await fs.writeFile(stateFile, JSON.stringify({ lastStart: started.toISOString(), lastFile: path.basename(file) }, null, 2));
  const size = (await fs.stat(file)).size;
  console.log(`Changes backup: ${file} (${changedRows} rows, ${Math.round(size / 1024)} KB)`);
}

// Run when called as a script (restore-backup.ts imports tablesOf from here).
if (process.argv[1] && /backup-changes\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error('Changes backup FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
