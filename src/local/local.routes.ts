import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from '../http/errors.js';

/**
 * Things only the computer running the API can do for the person sitting at
 * it — today, opening the Resume folder in Windows Explorer.
 *
 * A web page cannot open a folder on disk, nor even learn where the folder it
 * was given lives (the browser hands it a name, never a path). The API, when it
 * runs on the same Windows machine as the browser (the local setup), can do
 * both: the folder sync writes an id into `.romva-space-sync.json`, and this
 * finds the folder holding that id and opens it.
 *
 * Everywhere else the request is refused rather than doing something
 * surprising: on a hosted deployment there is no Explorer, and a request from
 * another computer on the network would open a window on *this* machine.
 */
export const localRouter = Router();
localRouter.use(requireAuth);

/** The marker the Resume folder sync writes at the root of the folder it owns. */
const SYNC_MANIFEST = '.romva-space-sync.json';

const OpenFolderSchema = z
  .object({
    /** The id in the folder's `.romva-space-sync.json` — how the folder is found. */
    folderId: z.string().trim().min(8).max(100).optional(),
    /** Where the folder was last found; checked first, so a search is rare. */
    hint: z.string().trim().max(500).optional(),
    /** A full path typed by hand — the fallback when the search finds nothing. */
    root: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.folderId || body.root, { message: 'Send folderId or root.' });
type OpenFolderInput = z.infer<typeof OpenFolderSchema>;

function isLoopback(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.');
}

/**
 * Whether the browser that sent this is on this machine. The socket alone is
 * not enough — the dev server's proxy connects from localhost on everyone's
 * behalf — so the page's own origin has to be local too.
 */
function fromThisComputer(req: Request): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const page = req.get('origin') ?? req.get('referer');
  if (!page) return true;
  try {
    return isLoopback(new URL(page).hostname);
  } catch {
    return false;
  }
}

/** The id in a folder's sync manifest, or `null` when it has none. */
async function manifestId(folder: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.win32.join(folder, SYNC_MANIFEST), 'utf8'));
    return typeof parsed?.folderId === 'string' ? parsed.folderId : '';
  } catch {
    return null;
  }
}

/** Folders never worth looking inside for a Resume folder. */
const SKIP = new Set(
  [
    'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin',
    'system volume information', 'recovery', 'perflogs', 'appdata', 'node_modules',
    '.git', '.cache', '.vscode', '.npm', '.yarn', 'msocache', 'intel', 'amd', 'nvidia',
  ],
);
const SEARCH_DEPTH = 4;
const SEARCH_BUDGET_MS = 8_000;

/**
 * Finds the folder whose manifest carries `folderId`: the user's own folders
 * first (Desktop, Documents, Downloads, OneDrive), then every drive, breadth
 * first, a few levels deep, skipping system folders. Bounded in time, so a
 * folder buried very deep is reported as not found rather than hanging.
 */
async function findFolder(folderId: string): Promise<string | null> {
  const home = os.homedir();
  const starts = ['Desktop', 'Documents', 'Downloads', 'OneDrive'].map((name) => path.win32.join(home, name));
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    starts.push(`${letter}:\\`);
  }

  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const seen = new Set<string>();
  let level: string[] = [];
  for (const start of starts) {
    try {
      if ((await stat(start)).isDirectory()) level.push(start);
    } catch {
      // No such drive or folder.
    }
  }

  for (let depth = 0; depth <= SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (Date.now() > deadline) return null;
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // No permission, or gone.
      }
      if (entries.some((entry) => entry.isFile() && entry.name === SYNC_MANIFEST)) {
        if ((await manifestId(dir)) === folderId) return dir;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name.toLowerCase())) {
          next.push(path.win32.join(dir, entry.name));
        }
      }
    }
    level = next;
  }
  return null;
}

/** Where each folder id was last found, so only the first open searches. */
const foundFolders = new Map<string, string>();

localRouter.post('/open-folder', validate({ body: OpenFolderSchema }), async (req, res) => {
  const { folderId, hint, root } = (req as ValidatedRequest<OpenFolderInput>).valid.body;

  if (process.platform !== 'win32') {
    throw new ServiceUnavailableError('Opening folders only works when romva.space runs on your own Windows PC.');
  }
  if (!fromThisComputer(req)) {
    throw new ForbiddenError(
      'Folders can only be opened from the computer romva.space runs on — open the app at http://localhost:5173.',
    );
  }

  let target: string | null = null;
  if (folderId) {
    for (const candidate of [hint, foundFolders.get(folderId)]) {
      if (candidate && path.win32.isAbsolute(candidate) && (await manifestId(candidate)) === folderId) {
        target = path.win32.resolve(candidate);
        break;
      }
    }
    target ??= await findFolder(folderId);
    if (!target && !root) {
      throw new NotFoundError(
        'Could not find the Resume folder on this computer. Enter its full path to open it.',
      );
    }
  }

  if (!target && root) {
    if (!path.win32.isAbsolute(root)) {
      throw new BadRequestError('Enter the full folder path, like D:\\Resumes.');
    }
    const id = await manifestId(root);
    // The folder the sync owns is the one with its marker in it — and, when
    // the browser told us which folder it is, that folder's id.
    if (id === null || (folderId && id && id !== folderId)) {
      throw new NotFoundError(
        `${path.win32.resolve(root)} is not your Resume save folder. Check the path, or run Sync first.`,
      );
    }
    target = path.win32.resolve(root);
  }

  if (folderId) foundFolders.set(folderId, target!);

  // No shell, so the path is passed as one argument whatever it contains.
  // Explorer exits 1 even when it opened the window, so its exit is ignored.
  const child = spawn('explorer.exe', [target!], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();

  res.json({ opened: target });
});
