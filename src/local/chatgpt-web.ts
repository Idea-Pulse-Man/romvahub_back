import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { GatewayTimeoutError, BadGatewayError, ServiceUnavailableError } from '../http/errors.js';
import { logger } from '../logger.js';

/**
 * Asks ChatGPT a question through chatgpt.com in a real Chrome window on this
 * computer, signed in with the person's own ChatGPT account — no API key.
 *
 * The browser is started as an ordinary Chrome (not a puppeteer-launched one,
 * which chatgpt.com and Google sign-in both refuse) with its own profile folder
 * and a DevTools port, and puppeteer connects to it. So:
 *
 * - the first time, a Chrome window opens on chatgpt.com: sign in there once;
 *   the profile folder keeps the session for every later run;
 * - the window stays open between runs (minimise it, do not close it — closing
 *   only means the next run opens it again);
 * - questions are asked one at a time, each in a new chat, because one window
 *   can only hold one conversation in flight.
 *
 * chatgpt.com is a web page, not an API: the selectors below are what its
 * markup uses today, and are the first thing to check if this stops working.
 *
 * Settings (environment, all optional):
 *   CHATGPT_BROWSER_PATH   Chrome/Edge executable (default: first one found)
 *   CHATGPT_PROFILE_DIR    profile folder (default: %LOCALAPPDATA%\romva-space\chatgpt-browser)
 *   CHATGPT_DEBUG_PORT     DevTools port (default 9333)
 *   CHATGPT_URL            chat page (default https://chatgpt.com/)
 *   CHATGPT_TEMPORARY_CHAT "false" to keep each chat in the ChatGPT history (default: temporary chats)
 *   CHATGPT_TIMEOUT_MS     how long one answer may take (default 8 minutes)
 *   CHATGPT_REQUIRE_SIGN_IN "false" to allow a signed-out chatgpt.com (default: refuse)
 *   CHATGPT_PROMPT_FILE    prompt file to use instead of AI Settings (see chatgpt-resume.ts)
 */

const SELECTORS = {
  // A ProseMirror editor when signed in, a plain textarea on some layouts.
  composer: '#prompt-textarea, textarea[name="prompt"], #mobile-composer-prompt, [contenteditable="true"][role="textbox"]',
  send: [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
  ].join(', '),
};

/**
 * In-page code is sent as source text rather than as functions: the backend
 * compiles without DOM types, and `tsx` (dev) wraps named inner functions in a
 * `__name` helper that does not exist in the page.
 */
const IN_PAGE = {
  /** Fills the composer: `insertText` (what typing does), else a value set / paste. */
  fill: (selector: string, text: string, how: 'insert' | 'set') => `(() => {
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return '';
    const text = ${JSON.stringify(text)};
    const isField = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    editor.focus();
    if (isField) { editor.select(); } else { document.execCommand('selectAll'); }
    document.execCommand('delete');
    if (${JSON.stringify(how)} === 'insert') {
      document.execCommand('insertText', false, text);
    } else if (isField) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value').set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
    return isField ? editor.value : editor.innerText;
  })()`,

  /** Whether the page offers "Log in" — signed out. */
  signedOut: `Array.from(document.querySelectorAll('button, a')).some((el) => /^log in$/i.test((el.innerText || '').trim()))`,

  /** How many code blocks the page holds, so the answer's can be told from older ones. */
  codeBlocks: `document.querySelectorAll('pre').length`,

  /**
   * The answer so far: the code blocks added since the message was sent, the
   * page text after the marker that ends the message (the answer, whatever
   * its markup), and whether a "Stop generating" button is showing.
   */
  answer: (codeBlocksBefore: number, marker: string) => `(() => {
    const pres = Array.from(document.querySelectorAll('pre'), (p) => p.innerText || '').slice(${codeBlocksBefore});
    const body = document.body.innerText || '';
    const at = body.lastIndexOf(${JSON.stringify(marker)});
    const tail = at >= 0 ? body.slice(at + ${marker.length}) : '';
    const streaming = Array.from(document.querySelectorAll('button')).some((b) => {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
      return /\\bstop\\b|stop[-_ ]?(generating|streaming|response|button)/i.test(label);
    });
    return { pres, tail, streaming };
  })()`,
};

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

function config() {
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return {
    browserPath:
      process.env.CHATGPT_BROWSER_PATH?.trim() || BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)),
    profileDir:
      process.env.CHATGPT_PROFILE_DIR?.trim() || path.join(localAppData, 'romva-space', 'chatgpt-browser'),
    port: Number(process.env.CHATGPT_DEBUG_PORT) || 9333,
    url: process.env.CHATGPT_URL?.trim() || 'https://chatgpt.com/',
    temporary: process.env.CHATGPT_TEMPORARY_CHAT?.trim().toLowerCase() !== 'false',
    timeoutMs: Number(process.env.CHATGPT_TIMEOUT_MS) || 8 * 60_000,
    requireSignIn: process.env.CHATGPT_REQUIRE_SIGN_IN?.trim().toLowerCase() !== 'false',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggerUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Tells Chrome its last run ended normally. Ending the API ends the Chrome it
 * started, which Chrome takes for a crash and offers to restore the old tabs.
 */
function markExitedCleanly(profileDir: string): void {
  const file = path.join(profileDir, 'Default', 'Preferences');
  try {
    if (!existsSync(file)) return;
    const prefs = JSON.parse(readFileSync(file, 'utf8')) as { profile?: Record<string, unknown> };
    prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true };
    writeFileSync(file, JSON.stringify(prefs));
  } catch (error) {
    logger.warn({ err: error }, 'Could not mark the ChatGPT browser profile as closed cleanly');
  }
}

let connection: Promise<Browser> | null = null;

/** Connects to the ChatGPT Chrome window, starting it when it is not running. */
async function connect(): Promise<Browser> {
  const settings = config();
  const puppeteer = await import('puppeteer-core');

  if (!(await debuggerUp(settings.port))) {
    if (!settings.browserPath) {
      throw new ServiceUnavailableError(
        'No Chrome or Edge found on this computer. Install Chrome, or set CHATGPT_BROWSER_PATH.',
      );
    }
    mkdirSync(settings.profileDir, { recursive: true });
    markExitedCleanly(settings.profileDir);
    const child = spawn(
      settings.browserPath,
      [
        `--remote-debugging-port=${settings.port}`,
        `--user-data-dir=${settings.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        // No "Restore pages? Chrome didn't shut down correctly" bubble: the
        // window is often ended with the API rather than closed by hand.
        '--hide-crash-restore-bubble',
        settings.url,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', (error) => logger.error({ err: error }, 'Could not start the ChatGPT browser'));
    child.unref();

    const deadline = Date.now() + 20_000;
    while (!(await debuggerUp(settings.port))) {
      if (Date.now() > deadline) {
        throw new ServiceUnavailableError(
          `The ChatGPT browser did not start. If a Chrome window is already using the profile folder ${settings.profileDir}, close it and try again.`,
        );
      }
      await sleep(500);
    }
  }

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${settings.port}`,
    defaultViewport: null,
    protocolTimeout: settings.timeoutMs + 60_000,
  });
  browser.on('disconnected', () => {
    connection = null;
  });
  return browser;
}

async function browser(): Promise<Browser> {
  if (connection) {
    const current = await connection.catch(() => null);
    if (current?.connected) return current;
  }
  connection = connect();
  connection.catch(() => {
    connection = null;
  });
  return connection;
}

/** Puts the whole message into ChatGPT's composer, checked by length. */
async function fillComposer(page: Page, message: string): Promise<void> {
  const length = (text: string) => text.replace(/\s+/g, '').length;
  const expected = length(message);

  // insertText first — what typing does, fast for any length — then setting
  // the value (a textarea) or a paste event (ProseMirror). Checked by length,
  // because a composer that ignored the text looks the same as one that took it.
  for (const how of ['insert', 'set'] as const) {
    const got = String(await page.evaluate(IN_PAGE.fill(SELECTORS.composer, message, how)));
    if (length(got) >= expected * 0.95) return;
    await sleep(300);
  }
  throw new BadGatewayError('Could not type the prompt into ChatGPT. The chatgpt.com page may have changed.');
}

/** Clicks the enabled Send button, waiting a moment for it; Enter when there is none. */
async function send(page: Page): Promise<void> {
  const click = `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.send)}))
      .find((b) => b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!button) return false;
    button.click();
    return true;
  })()`;
  for (let tries = 0; tries < 30; tries += 1) {
    if (await page.evaluate(click)) return;
    await sleep(500);
  }
  await page.keyboard.press('Enter');
}

interface AnswerSoFar {
  pres: string[];
  tail: string;
  streaming: boolean;
}

/** The JSON-looking part of an answer: the last new code block holding an object, else the text after the marker. */
function answerText(answer: AnswerSoFar): string {
  for (const block of [...answer.pres].reverse()) {
    try {
      parseJsonAnswer(block);
      return block;
    } catch {
      // Not this one.
    }
  }
  return answer.tail.trim();
}

/**
 * One message in its own new tab, closed when the chat is over — so finished
 * chats do not pile up, and a new chat never starts on a page that still shows
 * the last one (whose code block is another application's Resume).
 *
 * The tab is left open when ChatGPT needs the person (signed out, a "verify you
 * are human" check): that is where they act on it. And the last tab in the
 * window is never closed, which would quit Chrome.
 */
async function ask(message: string): Promise<string> {
  const page = await (await browser()).newPage();
  let keepOpen = false;
  try {
    return await askIn(page, message);
  } catch (error) {
    keepOpen = error instanceof ServiceUnavailableError;
    throw error;
  } finally {
    if (!keepOpen) await closeChat(page);
  }
}

async function closeChat(page: Page): Promise<void> {
  try {
    if (page.isClosed()) return;
    const others = (await (await browser()).pages()).filter((other) => other !== page);
    if (others.length > 0) await page.close();
    else await page.goto(config().url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    logger.warn({ err: error }, 'Could not close the finished ChatGPT tab');
  }
}

async function askIn(page: Page, message: string): Promise<string> {
  const settings = config();
  await page.bringToFront();

  const url = new URL(settings.url);
  if (settings.temporary) url.searchParams.set('temporary-chat', 'true');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });

  try {
    await page.waitForSelector(SELECTORS.composer, { visible: true, timeout: 30_000 });
  } catch {
    throw new ServiceUnavailableError(
      'ChatGPT did not load. Check the Chrome window that opened (sign in, or pass the "verify you are human" check), then click Make again.',
    );
  }
  if (settings.requireSignIn && (await page.evaluate(IN_PAGE.signedOut))) {
    throw new ServiceUnavailableError(
      'ChatGPT is not signed in. Sign in on chatgpt.com in the Chrome window that opened, then click Make again.',
    );
  }

  // A fresh, empty chat before anything is counted or sent. ChatGPT is a
  // single-page app: right after the navigation the previous chat's messages
  // (and its code block — the last application's Resume) can still be on the
  // page, and counting them as "before" hides the new answer, or reading them
  // would hand back the wrong application's Resume.
  if (!(await freshChat(page))) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(SELECTORS.composer, { visible: true, timeout: 30_000 }).catch(() => undefined);
    if (!(await freshChat(page))) {
      throw new ServiceUnavailableError('ChatGPT did not open a new, empty chat. Check the Chrome window, then try again.');
    }
  }

  // The message ends with a line of its own, so the answer can be found in
  // the page as "whatever comes after it", whatever ChatGPT's markup is.
  const marker = `Request ${randomUUID()}`;
  const codeBlocksBefore = Number(await page.evaluate(IN_PAGE.codeBlocks)) || 0;
  await fillComposer(page, [message, '', marker].join('\n'));
  await send(page);

  // Done when the answer has started (a stop button was seen, or a code block
  // arrived), nothing is streaming, and the text has not changed for a few
  // seconds — the stop button can blink out between thinking and writing.
  const deadline = Date.now() + settings.timeoutMs;
  let started = false;
  let last = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    const answer = (await page.evaluate(IN_PAGE.answer(codeBlocksBefore, marker))) as AnswerSoFar;
    started ||= answer.streaming || answer.pres.length > 0;
    const key = JSON.stringify([answer.pres, answer.tail]);
    if (!started || answer.streaming) {
      stableSince = 0;
      last = key;
      continue;
    }
    if (key !== last || !stableSince) {
      last = key;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= 3000) {
      const text = answerText(answer);
      if (text) return text;
    }
  }
  throw new GatewayTimeoutError(
    `ChatGPT had not finished answering after ${Math.round(settings.timeoutMs / 60_000)} minutes.`,
  );
}

/** Waits (up to 20s) for the page to be a new chat: no conversation path, no code blocks, no messages. */
async function freshChat(page: Page): Promise<boolean> {
  const empty = `(() => !location.pathname.startsWith('/c/')
    && document.querySelectorAll('pre').length === 0
    && !/(You said:|ChatGPT said:)/.test(document.body.innerText || ''))()`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(empty)) return true;
    await sleep(500);
  }
  return false;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Whether a Make could start now, judged from the tabs already open — nothing
 * is reloaded, so a sign-in in progress (on chatgpt.com or auth.openai.com) is
 * never interrupted. With no ChatGPT tab at all, one is opened once.
 */
export async function chatGptReady(): Promise<boolean> {
  try {
    const pages = await (await browser()).pages();
    const chat = pages.find((page) => /chatgpt\.com|chat\.openai\.com/.test(page.url()));
    if (!chat) {
      // Mid sign-in on another domain: wait. Otherwise open chatgpt.com.
      if (pages.some((page) => /openai\.com|google\.com|apple\.com|live\.com/.test(page.url()))) return false;
      const page = pages[0] ?? (await (await browser()).newPage());
      await page.goto(config().url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      return false;
    }
    const composer = Boolean(await chat.evaluate(`!!document.querySelector(${JSON.stringify(SELECTORS.composer)})`));
    if (!composer) return false;
    return !config().requireSignIn || !(await chat.evaluate(IN_PAGE.signedOut));
  } catch {
    return false;
  }
}

/**
 * The ChatGPT tab or window was closed while a message was in it: say so, as
 * "ChatGPT unavailable" rather than a failure of this application, so the
 * automatic Make waits and tries again (in a reopened window) instead of
 * giving up on the row. Anything else is passed on unchanged.
 */
function windowClosed(error: unknown): never {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/TargetCloseError|Target closed|Session closed|detached|Connection closed|Protocol error.*closed/i.test(text)) {
    throw new ServiceUnavailableError(
      'The ChatGPT window was closed while it was writing. It reopens by itself; click Make again (automatic Makes retry on their own).',
    );
  }
  throw error;
}

/**
 * Sends one message to ChatGPT in a new chat and returns its answer. Calls are
 * queued: a second Make waits for the first answer rather than typing over it.
 */
export function askChatGpt(message: string): Promise<string> {
  const run = queue.then(() => ask(message).catch(windowClosed));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The JSON object in a chat answer: the whole answer, a fenced block, or the
 * span from the first `{` to the last `}`. Trailing commas and smart quotes —
 * the two things a chat answer gets wrong most — are repaired once.
 */
/** The balanced `{…}` spans at the top level of a text, braces inside strings ignored. */
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

export function parseJsonAnswer(answer: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(answer)?.[1];
  const candidates = [answer, fenced];
  // Every complete top-level object, last first: when the text read off the
  // page also holds the prompt (and its INPUT JSON), the answer is the last.
  candidates.push(...topLevelObjects(answer).reverse());
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(answer.slice(start, end + 1));

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    for (const text of [candidate, repair(candidate)]) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // Next.
      }
    }
  }
  throw new BadGatewayError(
    `ChatGPT's answer was not valid JSON. It began: "${answer.slice(0, 160).replace(/\s+/g, ' ')}…"`,
  );
}

function repair(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
}
