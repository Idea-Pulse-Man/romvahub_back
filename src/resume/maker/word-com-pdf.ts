/**
 * Export a merged .docx to PDF through Microsoft Word COM — the same path
 * Resume Maker's `WordComPdfExporter` uses (Open → ExportAsFixedFormat type 17).
 *
 * Only available on Windows hosts with Word installed. Returns `null` when Word
 * is missing or the export fails so callers can fall back to approximate HTML
 * print.
 *
 * Word is kept running between exports. Starting it is what costs: launching
 * PowerShell and Word for every file took 3–30 s a PDF, while a warm Word
 * exports one in ~0.2 s. So one long-lived PowerShell process holds a hidden
 * Word instance and takes jobs over stdin, one line each:
 *
 *   in:  <docx path>|<pdf path>       ('|' cannot occur in a Windows path)
 *   out: OK  |  ERR <message>
 *
 * Jobs run one at a time (Word is single-threaded). A job that times out or a
 * worker that dies is replaced on the next job, and an idle worker quits Word
 * after a few minutes so it is not left holding memory.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../../logger.js';

const START_TIMEOUT_MS = 60_000;
const EXPORT_TIMEOUT_MS = 90_000;
const IDLE_SHUTDOWN_MS = 5 * 60_000;
/** After Word fails to start, how long to stop trying and go straight to the fallback. */
const UNAVAILABLE_RETRY_MS = 5 * 60_000;

const WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
# Word's own process id, so Node can end it if this script is killed.
# Only an automation-launched Word: never a copy the user opened themselves.
$wordPid = @(Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" | Where-Object { $before -notcontains $_.ProcessId -and $_.CommandLine -like '*/Automation*' } | ForEach-Object { $_.ProcessId }) | Select-Object -First 1
[Console]::Out.WriteLine("READY $wordPid")
[Console]::Out.Flush()
try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line.Split('|')
    $doc = $null
    try {
      # ConfirmConversions = false, ReadOnly = true
      $doc = $word.Documents.Open($parts[0], $false, $true)
      # 17 = wdExportFormatPDF
      $doc.ExportAsFixedFormat($parts[1], 17)
      [Console]::Out.WriteLine('OK')
    } catch {
      [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\\s+', ' '))
    } finally {
      if ($doc -ne $null) { try { $doc.Close([ref]0) } catch {} }
    }
    [Console]::Out.Flush()
  }
} finally {
  try { $word.Quit([ref]0) } catch {}
}
`.trim();

class WordWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
  private exited = false;
  /** Word's process, which outlives a killed PowerShell unless ended too. */
  private wordPid: number | null = null;
  readonly ready: Promise<void>;

  constructor() {
    this.child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true },
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line || !this.pending) continue;
        const { resolve } = this.pending;
        this.pending = null;
        resolve(line);
      }
    });
    // PowerShell writes progress records and the like here; nothing to act on.
    this.child.stderr.resume();
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error(`Word worker exited (code ${code ?? 'null'})`)));

    this.ready = this.nextLine(START_TIMEOUT_MS).then((line) => {
      const match = /^READY\s*(\d*)$/.exec(line);
      if (!match) throw new Error(`Word worker did not start: ${line}`);
      this.wordPid = match[1] ? Number(match[1]) : null;
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  async exportPdf(docxPath: string, pdfPath: string): Promise<void> {
    await this.ready;
    const reply = this.nextLine(EXPORT_TIMEOUT_MS);
    this.child.stdin.write(`${docxPath}|${pdfPath}\n`);
    const line = await reply;
    if (line !== 'OK') throw new Error(line.replace(/^ERR\s*/, '') || 'Word export failed');
  }

  stop(): void {
    if (this.exited) return;
    // Closing stdin ends the loop, which quits Word cleanly; the kill is the
    // backstop for a Word that will not let go.
    this.child.stdin.end();
    setTimeout(() => {
      if (!this.exited) this.kill();
    }, 10_000).unref();
  }

  /** Ends the worker at once — and Word with it, since killing PowerShell does not. */
  kill(): void {
    if (!this.exited) this.child.kill();
    if (this.wordPid) {
      try {
        process.kill(this.wordPid);
      } catch {
        // Already gone.
      }
      this.wordPid = null;
    }
  }

  private nextLine(timeoutMs: number): Promise<string> {
    if (this.exited) return Promise.reject(new Error('Word worker is not running'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill();
        reject(new Error(`Word did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = {
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private fail(error: Error): void {
    this.exited = true;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
}

let worker: WordWorker | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let unavailableUntil = 0;
/** Serialises exports: Word handles one document at a time. */
let queue: Promise<unknown> = Promise.resolve();

function currentWorker(): WordWorker {
  if (!worker?.alive) worker = new WordWorker();
  return worker;
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    worker?.stop();
    worker = null;
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref();
}

process.once('exit', () => worker?.kill());

/**
 * Convert DOCX bytes to PDF via Word COM. Returns `null` when Word is
 * unavailable or export fails (caller should use the approximate path).
 */
export async function docxToPdfViaWordCom(docx: Buffer): Promise<Buffer | null> {
  if (process.platform !== 'win32' || Date.now() < unavailableUntil) {
    return null;
  }

  const job = queue.then(() => exportOne(docx));
  queue = job.catch(() => undefined);
  return job;
}

async function exportOne(docx: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-ops-word-pdf-'));
  const docxPath = path.join(dir, 'resume.docx');
  const pdfPath = path.join(dir, 'resume.pdf');

  try {
    await writeFile(docxPath, docx);
    const active = currentWorker();

    try {
      await active.ready;
    } catch (error) {
      active.kill();
      worker = null;
      unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS;
      logger.warn({ err: error }, 'Word COM unavailable; using approximate HTML print for PDFs');
      return null;
    }

    try {
      await active.exportPdf(docxPath, pdfPath);
    } catch (error) {
      logger.warn({ err: error }, 'Word COM PDF export failed; falling back to approximate HTML print');
      return null;
    } finally {
      scheduleIdleShutdown();
    }

    return await readFile(pdfPath);
  } catch (error) {
    logger.warn({ err: error }, 'Word COM PDF export unavailable; falling back to approximate HTML print');
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
