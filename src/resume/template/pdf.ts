import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { logger } from '../../logger.js';

/**
 * Prints the template's HTML to PDF with headless Chromium.
 *
 * A browser is a heavy dependency for a serverless function, and it is here for
 * one reason: the template is defined as HTML and CSS in the resume-builder
 * desktop app, which prints it through Electron. Reproducing that layout in a
 * PDF drawing library would mean re-deriving every margin, line height and page
 * break by hand and hoping the result matched. Printing the same stylesheet
 * through the same engine means it matches by construction.
 *
 * `preferCSSPageSize` is what hands control of the page size and margins to the
 * `@page` rule in the stylesheet rather than to Puppeteer's own defaults —
 * without it the template's 0.5" Narrow margins are silently replaced.
 */

const LOCAL_BROWSER_CANDIDATES = [
  // Windows — Chrome then Edge (Edge ships with Windows 10/11).
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

/**
 * Where to find Chromium.
 *
 * `PUPPETEER_EXECUTABLE_PATH` wins, which is how a development machine points at
 * the Chrome it already has rather than unpacking another copy. Next we probe
 * common local install paths (Windows Edge/Chrome especially), because
 * `@sparticuz/chromium` is a Linux serverless binary and fails on Windows with
 * `spawn …\\Temp\\chromium ENOENT`. Only when nothing local is found do we fall
 * through to `@sparticuz/chromium`.
 */
function resolveBrowserPath(): string | undefined {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  return LOCAL_BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
}

async function launch(): Promise<Browser> {
  const puppeteer = await import('puppeteer-core');
  const executablePath = resolveBrowserPath();

  if (executablePath) {
    return puppeteer.launch({
      executablePath,
      headless: true,
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
  }

  const chromium = (await import('@sparticuz/chromium')).default;

  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    headless: true,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  });
}

/**
 * One browser, kept between PDFs. Launching Chromium is most of the cost of a
 * PDF — seconds on a cold serverless instance — and a folder sync asks for
 * dozens in a row. Each PDF gets its own page; the browser closes after a
 * minute without one, and is relaunched if it died (a frozen and thawed
 * serverless instance can leave it disconnected).
 */
const PROTOCOL_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 60_000;

let browser: Promise<Browser> | null = null;
let openPages = 0;
let idleTimer: NodeJS.Timeout | null = null;

function discardBrowser(stale: Promise<Browser>): void {
  if (browser === stale) browser = null;
  stale.then(b => b.close()).catch(() => undefined);
}

function sharedBrowser(): Promise<Browser> {
  if (!browser) {
    const launching = launch();
    browser = launching;
    launching.then(
      b => b.once('disconnected', () => {
        if (browser === launching) browser = null;
      }),
      () => {
        if (browser === launching) browser = null;
      },
    );
  }
  return browser;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (openPages > 0 || !browser) return;
  const idle = browser;
  idleTimer = setTimeout(() => discardBrowser(idle), IDLE_CLOSE_MS);
  idleTimer.unref();
}

/** Runs `use` on a fresh page of the shared browser, closing the page after. */
export async function withPage<T>(use: (page: Page) => Promise<T>): Promise<T> {
  if (idleTimer) clearTimeout(idleTimer);
  openPages += 1;
  try {
    let page: Page;
    const current = sharedBrowser();
    try {
      page = await (await current).newPage();
    } catch {
      // A browser that cannot open a page is gone; start a new one once.
      discardBrowser(current);
      page = await (await sharedBrowser()).newPage();
    }
    try {
      return await use(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    openPages -= 1;
    scheduleIdleClose();
  }
}

process.once('exit', () => {
  browser?.then(b => b.process()?.kill()).catch(() => undefined);
});

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const started = Date.now();

  return withPage(async page => {
    // The fonts are data URIs in the document itself and every other asset is
    // inline, so nothing is fetched — `load` fires as soon as the document is
    // parsed, and there is no network for `networkidle` to wait on.
    await page.setContent(html, { waitUntil: 'load' });
    // Belt and braces: `font-display: block` means text is invisible until the
    // face is ready, and a PDF printed a millisecond early would be blank.
    await page.evaluate('document.fonts.ready');

    const pdf = await page.pdf({
      printBackground: true,
      // The @page rule in the template owns the paper size and the margins.
      preferCSSPageSize: true,
      // A tagged PDF carries the document's structure — the heading levels, the
      // lists, the reading order — beside the glyphs, which is the difference
      // between a Resume an applicant tracking system can take apart and a page
      // of text at coordinates. Chromium's current default, stated here because
      // it is a requirement of the template rather than a default to inherit.
      tagged: true,
    });

    logger.debug({ ms: Date.now() - started, bytes: pdf.byteLength }, 'Resume printed to PDF');
    return Buffer.from(pdf);
  });
}
