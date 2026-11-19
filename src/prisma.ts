import { PrismaPg } from '@prisma/adapter-pg';
import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './env.js';

/**
 * Prisma 7 connects through a driver adapter rather than an engine-owned pool,
 * so the connection string lives here rather than in `schema.prisma`.
 */
/**
 * Supabase's transaction pooler (port 6543) lends a server connection only for
 * the length of each transaction and takes hundreds of clients, so a few
 * connections per serverless instance cost nothing there; the session pooler
 * (5432) gives every client a seat of 15 in all, so one each is the most.
 */
const viaTransactionPooler = (() => {
  try {
    return new URL(env.DATABASE_URL).port === '6543';
  } catch {
    return false;
  }
})();

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // On Vercel each concurrent request can land in its own function instance,
  // and every instance opens its own pool — ten connections apiece exhausts
  // Postgres under a modest spike. One per instance, with a pooler
  // (PgBouncer/Neon/Supabase) doing the fan-in, is the shape that survives.
  // Locally, a few: Supabase's session pooler allows 15 clients in all, shared
  // with every Vercel instance and any other local API — ten here alone ran it
  // out ("max clients reached in session mode"). DATABASE_POOL_MAX overrides.
  max: Number(process.env.DATABASE_POOL_MAX) || (process.env.VERCEL ? (viaTransactionPooler ? 3 : 1) : 3),
  // A connection the pooler or the network dropped is noticed and replaced,
  // rather than handed to the next query ("Connection terminated unexpectedly")
  // — which a long-running local API, waiting minutes on ChatGPT, runs into.
  keepAlive: true,
  // Unused connections are closed here first, after a few seconds, so none is
  // handed out after the pooler has already closed it ("Server has closed the
  // connection") — the local API polls every 15s and sat on idle ones.
  idleTimeoutMillis: 5_000,
});

// On Vercel a function instance is paused between requests, and a paused
// instance cannot run the idle timer above: its connections stayed open,
// counted by Supabase's pooler, until the pooler's 200 client slots were all
// held by paused instances ("max client connections reached, limit: 200") and
// every request failed for minutes, sign-in included. attachDatabasePool keeps
// the instance awake until its idle connections are closed, so none is left
// open while it sleeps.
if (process.env.VERCEL) attachDatabasePool(pool);

// A connection dropped while idle (the pooler restarting) is an 'error' on the
// pool; unhandled, it would crash the instance.
pool.on('error', () => undefined);

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({
  adapter,
  // Waiting for a connection: Prisma's default of 2s failed whole requests
  // whenever a few arrived together on an instance with one connection.
  transactionOptions: { maxWait: 15_000, timeout: 20_000 },
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Named to avoid colliding with the generated `Prisma` namespace, which is a
// different thing entirely.
export type PrismaClientInstance = typeof prisma;

/** The transaction-scoped client handed to a `$transaction` callback. */
export type PrismaTx = Parameters<Parameters<PrismaClientInstance['$transaction']>[0]>[0];
