// `prisma migrate deploy`, tried again when the database is only busy.
//
// The build runs migrations through Supabase's session pooler (DIRECT_URL,
// port 5432), which seats 15 clients in all — shared with every live serverless
// instance still on it. A deploy that happened to land while the seats were
// full failed outright ("max clients reached in session mode"), though there
// was nothing to migrate. Seats free up within seconds to minutes, so: wait and
// try again, for about two minutes, before failing the build.

import { spawnSync } from 'node:child_process';

const ATTEMPTS = 8;
const WAIT_MS = 15_000;
const BUSY = /EMAXCONNSESSION|max clients reached|timeout expired|Can't reach database|ECONNRESET|ETIMEDOUT/i;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const run = spawnSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    encoding: 'utf8',
  });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status === 0) process.exit(0);

  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (!BUSY.test(output) || attempt === ATTEMPTS) process.exit(run.status ?? 1);
  console.log(`Database busy (attempt ${attempt} of ${ATTEMPTS}); trying again in ${WAIT_MS / 1000}s…`);
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}
