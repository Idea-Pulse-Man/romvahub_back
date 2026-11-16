import { createApp } from '../dist/app.js';

/**
 * Vercel's entrypoint. An Express app is itself an `(req, res)` handler, so
 * exporting it is all the adapter needs.
 *
 * This module is evaluated once per cold start and the instance is reused for
 * every request it goes on to serve, so the app — and the Prisma pool behind it
 * — is built once rather than per request.
 *
 * It imports from `dist/` rather than `src/` because `vercel.json`'s build
 * command runs `tsc` before the function is bundled; that keeps the deployed
 * JavaScript identical to what `yarn build` produces locally.
 */
export default createApp();
