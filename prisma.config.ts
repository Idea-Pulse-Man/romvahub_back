import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 reads the CLI's connection URL from here rather than from a `url`
 * field in `schema.prisma`. The runtime client gets its connection separately,
 * through the pg driver adapter in `src/prisma.ts`.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Migrations need a direct connection: a transaction-mode pooler
    // (PgBouncer, Supabase :6543, Neon's pooled host) cannot run the session-
    // level statements `migrate deploy` issues. Set DIRECT_URL wherever
    // DATABASE_URL points at a pooler; locally the two are the same.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});
