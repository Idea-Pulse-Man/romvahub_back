import { createApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { startAutoMakeWatcher } from './local/auto-make-watcher.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    `RemoteOps API listening on http://localhost:${env.PORT} (docs at /docs)`,
  );
  // Resumes for applications filed elsewhere (the scraper posts to the
  // deployed API, which cannot drive Chrome). Off unless CHATGPT_AUTO_MAKE=true.
  startAutoMakeWatcher();
});

/**
 * Stop accepting connections, let in-flight requests finish, then close the
 * database pool. Without this an orchestrator's SIGTERM kills requests midway.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');

  const timeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, 10_000);
  timeout.unref();

  server.close(async (error) => {
    if (error) logger.error({ err: error }, 'Error while closing the HTTP server');
    await prisma.$disconnect();
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Run by the desktop app: it holds this process's stdin open for as long as it
// is running. When the app quits — or crashes — the pipe closes, and the server
// shuts down cleanly rather than being left running with nothing in front of it.
// (Windows has no SIGTERM to send a child, so this is the graceful path there.)
if (process.env.ROMVA_SPACE_DESKTOP === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => void shutdown('desktop app closed'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
