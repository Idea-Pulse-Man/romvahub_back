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
  max: process.env.VERCEL ? 1 : 10,
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
