import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './env.js';

/**
 * Prisma 7 connects through a driver adapter rather than an engine-owned pool,
 * so the connection string lives here rather than in `schema.prisma`.
 */
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  // On Vercel each concurrent request can land in its own function instance,
  // and every instance opens its own pool — ten connections apiece exhausts
  // Postgres under a modest spike. One per instance, with a pooler
  // (PgBouncer/Neon/Supabase) doing the fan-in, is the shape that survives.
  // Locally, a few: Supabase's session pooler allows 15 clients in all, shared
  // with every Vercel instance and any other local API — ten here alone ran it
  // out ("max clients reached in session mode"). DATABASE_POOL_MAX overrides.
  max: process.env.VERCEL ? 1 : Number(process.env.DATABASE_POOL_MAX) || 3,
  // A connection the pooler or the network dropped is noticed and replaced,
  // rather than handed to the next query ("Connection terminated unexpectedly")
  // — which a long-running local API, waiting minutes on ChatGPT, runs into.
  keepAlive: true,
});

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Named to avoid colliding with the generated `Prisma` namespace, which is a
// different thing entirely.
export type PrismaClientInstance = typeof prisma;

/** The transaction-scoped client handed to a `$transaction` callback. */
export type PrismaTx = Parameters<Parameters<PrismaClientInstance['$transaction']>[0]>[0];
