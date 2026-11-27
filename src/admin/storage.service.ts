import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { Actor } from '../auth/actor.js';
import { fromDbStatus } from '../domain/status.js';
import { formatDateOnly } from '../domain/dates.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { dropCopiesQuietly, dropKept, folderUsage, readKept, writeKept, type DocFormat } from '../resume/store/folder.js';
import { rangeWhere, type RangeInput } from '../resume/store/range.js';

/**
 * The Storage page (Super Admin): how full the database is, and "Backup and
 * remove" — the job description, Resume, cover letter and application chat
 * of the applications in a date range and statuses are saved to a .zip on the
 * Super Admin's computer, then (only when they confirm) removed from the
 * database. Company, role, status, number, dates and the job link stay, so the
 * lists and counts are unchanged. "Restore" puts them back from that .zip.
 */

const BACKUP_FORMAT = 1;
const BATCH = 200;

export async function storageSummary() {
  const [size] = await prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`;
  const tables = await prisma.$queryRaw<{ name: string; bytes: bigint }[]>`
    SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = current_schema()
    ORDER BY bytes DESC
    LIMIT 10`;
  const limitMb = Number(process.env.DATABASE_SIZE_LIMIT_MB) || 500;
  const [applications, inBackup, backups] = await Promise.all([
    prisma.bid.count(),
    prisma.bid.count({ where: { backedUpAt: { not: null } } }),
    prisma.contentBackup.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, filter: true, bidIds: true, size: true, createdAt: true, removedAt: true, restoredAt: true },
    }),
  ]);
  return {
    database: {
      bytes: Number(size?.bytes ?? 0),
      limitBytes: limitMb * 1024 * 1024,
      tables: tables.map((table) => ({ name: table.name, bytes: Number(table.bytes) })),
    },
    applications,
    inBackup,
    resumeFolder: await folderUsage(),
    backups: backups.map(({ bidIds, ...backup }) => ({ ...backup, applications: bidIds.length })),
  };
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const has = (value: unknown) => (value === null || value === undefined || value === '' ? 'no' : 'yes');

interface BackupFile {
  format: string;
  name: string;
  /** Where it is in the .zip. */
  path: string;
  /** `stored`: an old Resume file from the database; `kept`: from the Resume folder's kept\ folder. */
  from: 'stored' | 'kept';
}

interface BackupApplication {
  id: string;
  number: number;
  profileId: string | null;
  profile: string;
  company: string;
  role: string;
  status: string;
  bidDate: string;
  jobUrl: string | null;
  jobDescription: string | null;
  resumeAnswer: unknown;
  resumeBuild: unknown;
  resumeDocument: unknown;
  coverLetterDocument: unknown;
  applicationChat: unknown;
  files: BackupFile[];
}

const safe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_');

/**
 * Makes the backup .zip of the applications in `range` (those not already in
 * a backup), and records it. Nothing is removed here.
 */
export async function makeBackup(actor: Actor, range: RangeInput): Promise<{ id: string; count: number; zip: Buffer; fileName: string }> {
  // Stamped before anything is read: an application changed after this is not removed (see removeBackedUp).
  const startedAt = new Date();
  const ids = (
    await prisma.bid.findMany({
      where: { AND: [rangeWhere(range), { backedUpAt: null }] },
      select: { id: true },
      orderBy: [{ bidDate: 'asc' }, { number: 'asc' }],
    })
  ).map((row) => row.id);
  if (ids.length === 0) throw new BadRequestError('No applications match these dates and statuses (or they are already in a backup).');

  const zip = new JSZip();
  const applications: BackupApplication[] = [];
  const csv = [['No', 'Profile', 'Company', 'Role', 'Status', 'Date', 'Job link', 'Job description', 'Resume', 'Cover letter', 'Application chat', 'Id']];

  for (let i = 0; i < ids.length; i += BATCH) {
    const rows = await prisma.bid.findMany({
      where: { id: { in: ids.slice(i, i + BATCH) } },
      orderBy: [{ bidDate: 'asc' }, { number: 'asc' }],
      select: {
        id: true,
        number: true,
        profileId: true,
        company: true,
        role: true,
        status: true,
        bidDate: true,
        jobUrl: true,
        jobDescription: true,
        resumeAnswer: true,
        resumeBuild: true,
        resumeDocument: true,
        coverLetterDocument: true,
        applicationChat: true,
        resumeKept: true,
        profile: { select: { firstName: true, lastName: true } },
        resumeFiles: { select: { format: true, name: true, data: true } },
      },
    });
    for (const row of rows) {
      const files: BackupFile[] = [];
      for (const file of row.resumeFiles) {
        const path = `files/${row.id}/${safe(file.name)}`;
        zip.file(path, Buffer.from(file.data));
        files.push({ format: file.format, name: file.name, path, from: 'stored' });
      }
      if (row.resumeKept) {
        for (const format of ['pdf', 'docx'] as const) {
          const kept = await readKept(row.id, format).catch(() => null);
          if (!kept) continue;
          const path = `files/${row.id}/kept/${safe(kept.name)}`;
          zip.file(path, kept.data);
          files.push({ format, name: kept.name, path, from: 'kept' });
        }
      }
      const profile = [row.profile?.firstName, row.profile?.lastName].filter(Boolean).join(' ');
      const hasResume = row.resumeAnswer !== null || row.resumeDocument !== null || files.length > 0;
      applications.push({
        id: row.id,
        number: row.number,
        profileId: row.profileId,
        profile,
        company: row.company,
        role: row.role,
        status: fromDbStatus(row.status),
        bidDate: formatDateOnly(row.bidDate),
        jobUrl: row.jobUrl,
        jobDescription: row.jobDescription,
        resumeAnswer: row.resumeAnswer,
        resumeBuild: row.resumeBuild,
        resumeDocument: row.resumeDocument,
        coverLetterDocument: row.coverLetterDocument,
        applicationChat: row.applicationChat,
        files,
      });
      csv.push([
        String(row.number),
        profile,
        row.company,
        row.role,
        fromDbStatus(row.status),
        formatDateOnly(row.bidDate),
        row.jobUrl ?? '',
        has(row.jobDescription),
        hasResume ? 'yes' : 'no',
        has(row.coverLetterDocument),
        has(row.applicationChat),
        row.id,
      ]);
    }
  }

  const record = await prisma.contentBackup.create({
    data: { createdById: actor.id, filter: range as unknown as PrismaTypes.InputJsonValue, bidIds: ids, size: 0, createdAt: startedAt },
    select: { id: true, createdAt: true },
  });
  zip.file(
    'applications.json',
    JSON.stringify({ format: BACKUP_FORMAT, backupId: record.id, createdAt: record.createdAt.toISOString(), filter: range, applications }),
  );
  // A BOM, so Excel reads the names as UTF-8.
  zip.file('applications.csv', `﻿${csv.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`);
  zip.file(
    'README.txt',
    [
      'romva.space backup',
      '',
      `Made ${record.createdAt.toISOString()} for applications dated ${range.from} to ${range.to},`,
      `statuses: ${range.statuses.join(', ')}${range.profileId ? `, one Profile` : ''}.`,
      '',
      'applications.csv   one line per application (opens in Excel)',
      'applications.json  everything that was removed: job description, Resume, cover letter, application chat',
      'files\\             old Resume files (Word and PDF) that had no JSON',
      '',
      'To put them back: Storage page → Restore from backup → choose this .zip.',
    ].join('\r\n'),
  );
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await prisma.contentBackup.update({ where: { id: record.id }, data: { size: bytes.byteLength } });

  const stamp = record.createdAt.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  logger.info({ backup: record.id, applications: ids.length, bytes: bytes.byteLength, by: actor.id }, 'Storage: backup made');
  return { id: record.id, count: ids.length, zip: bytes, fileName: `romva-backup_${range.from}_to_${range.to}_${stamp}.zip` };
}

const databaseBytes = async () =>
  Number((await prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`)[0]?.bytes ?? 0);

/**
 * Removes what a backup saved, from the applications in it — only those not
 * changed since it was made (a newer Resume or letter is not in the file, so
 * it is never removed). Then the tables are compacted, so the size drops.
 */
export async function removeBackedUp(actor: Actor, backupId: string) {
  const backup = await prisma.contentBackup.findUnique({ where: { id: backupId } });
  if (!backup) throw new NotFoundError('No such backup.');
  if (backup.removedAt) throw new BadRequestError('This backup was already removed from the database.');

  const before = await databaseBytes();
  const removedAt = new Date();
  let removed = 0;
  let changed = 0;
  for (let i = 0; i < backup.bidIds.length; i += 500) {
    const batch = backup.bidIds.slice(i, i + 500);
    const unchanged = (
      await prisma.bid.findMany({
        where: { id: { in: batch }, updatedAt: { lte: backup.createdAt }, backedUpAt: null },
        select: { id: true },
      })
    ).map((row) => row.id);
    changed += batch.length - unchanged.length;
    if (unchanged.length === 0) continue;
    await prisma.$transaction(
      [
        prisma.bidResumeFile.deleteMany({ where: { bidId: { in: unchanged } } }),
        prisma.autoMakeClaim.deleteMany({ where: { bidId: { in: unchanged } } }),
        prisma.bid.updateMany({
          where: { id: { in: unchanged } },
          data: {
            jobDescription: null,
            resumeAnswer: PrismaTypes.DbNull,
            resumeBuild: PrismaTypes.DbNull,
            resumeDocument: PrismaTypes.DbNull,
            coverLetterDocument: PrismaTypes.DbNull,
            applicationChat: PrismaTypes.DbNull,
            resumeKept: false,
            backedUpAt: removedAt,
            resumeCheckStatus: null,
            resumeCheckReasons: [],
            resumeCheckedAt: null,
            resumeTextHash: null,
            resumeCheckAcceptedHash: null,
          },
        }),
      ],
      { timeout: 60_000, maxWait: 10_000 },
    );
    await dropCopiesQuietly(unchanged);
    await Promise.all(unchanged.map((id) => dropKept(id).catch(() => undefined)));
    removed += unchanged.length;
  }
  await prisma.contentBackup.update({ where: { id: backupId }, data: { removedAt } });

  // Deleted rows only free their space for reuse; VACUUM FULL gives it back, so the size drops now.
  let compacted = true;
  for (const table of ['bids', 'bid_resume_files']) {
    try {
      await prisma.$executeRawUnsafe(`VACUUM FULL "${table}"`);
    } catch (error) {
      compacted = false;
      logger.warn({ err: error, table }, 'Storage: VACUUM FULL failed');
    }
  }
  const after = await databaseBytes();
  logger.info({ backup: backupId, removed, changed, before, after, by: actor.id }, 'Storage: backup removed from the database');
  return { removed, changedSinceBackup: changed, compacted, databaseBytesBefore: before, databaseBytesAfter: after };
}

/**
 * Puts back what a backup .zip holds, into the applications that are still in
 * a backup (anything else is left alone). `dryRun`: only counts.
 */
export async function restoreBackup(actor: Actor, bytes: Buffer, { dryRun }: { dryRun: boolean }) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new BadRequestError('That is not a backup .zip file.');
  }
  const entry = zip.file('applications.json');
  if (!entry) throw new BadRequestError('This .zip has no applications.json: it is not a romva.space backup.');
  let content: { format?: number; backupId?: string; applications?: BackupApplication[] };
  try {
    content = JSON.parse(await entry.async('string'));
  } catch {
    throw new BadRequestError('The backup\'s applications.json could not be read.');
  }
  if (content.format !== BACKUP_FORMAT || !Array.isArray(content.applications)) {
    throw new BadRequestError('This backup was made by another version and cannot be read here.');
  }

  const list = content.applications;
  const ids = list.map((app) => app.id).filter((id) => typeof id === 'string');
  const waiting = new Set(
    (await prisma.bid.findMany({ where: { id: { in: ids }, backedUpAt: { not: null } }, select: { id: true } })).map((row) => row.id),
  );
  const result = { inFile: list.length, restorable: waiting.size, restored: 0 };
  if (dryRun) return result;

  const json = (value: unknown) => (value === null || value === undefined ? PrismaTypes.DbNull : (value as PrismaTypes.InputJsonValue));
  for (const app of list) {
    if (!waiting.has(app.id)) continue;
    let kept = false;
    const stored: { format: string; name: string; data: Buffer }[] = [];
    for (const file of app.files ?? []) {
      const data = await zip.file(file.path)?.async('nodebuffer');
      if (!data) continue;
      if (file.from === 'kept') {
        await writeKept(app.id, file.format as DocFormat, { name: file.name, data });
        kept = true;
      } else {
        stored.push({ format: file.format, name: file.name, data });
      }
    }
    await prisma.$transaction([
      ...stored.map((file) =>
        prisma.bidResumeFile.upsert({
          where: { bidId_format: { bidId: app.id, format: file.format } },
          create: {
            bidId: app.id,
            format: file.format,
            name: file.name,
            contentType: file.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: file.data.byteLength,
            sha256: createHash('sha256').update(file.data).digest('hex'),
            data: new Uint8Array(file.data),
          },
          update: {},
        }),
      ),
      prisma.bid.update({
        where: { id: app.id },
        data: {
          jobDescription: app.jobDescription ?? null,
          resumeAnswer: json(app.resumeAnswer),
          resumeBuild: json(app.resumeBuild),
          resumeDocument: json(app.resumeDocument),
          coverLetterDocument: json(app.coverLetterDocument),
          applicationChat: json(app.applicationChat),
          resumeKept: kept,
          backedUpAt: null,
        },
      }),
    ]);
    result.restored += 1;
  }
  if (content.backupId) {
    await prisma.contentBackup.updateMany({ where: { id: content.backupId }, data: { restoredAt: new Date() } });
  }
  logger.info({ ...result, backup: content.backupId, by: actor.id }, 'Storage: backup restored');
  return result;
}
