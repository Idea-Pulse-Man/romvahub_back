import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuration is validated once, at import time. A missing or malformed
 * variable stops the process here with a readable message rather than surfacing
 * as an undefined-shaped bug on the first request that needs it.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    TEST_DATABASE_URL: z.string().optional(),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(1),

    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    /**
     * The built website (`remote-ops-frontend/dist/public`) to serve from this
     * same server. Set by the desktop app, which runs one local server for both;
     * unset everywhere else, where Vite or Vercel serves the website.
     */
    FRONTEND_DIR: z.string().optional(),
    COOKIE_DOMAIN: z.string().optional(),
    /**
     * `lax` suits the deployment the frontend defaults to, where a rewrite puts
     * the API on the app's own origin. `none` is for serving them from
     * genuinely different origins, which the browser will not send a Lax cookie
     * across — see README §7 for what that costs.
     */
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    /**
     * Which AI platform writes the Resume. An admin screen will eventually pick
     * this per deployment and store the key with it; until then the choice and
     * the key both come from the environment, and the default is OpenAI.
     */
    AI_PROVIDER: z.enum(['openai', 'anthropic', 'gemini', 'deepseek']).default('openai'),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    /** Overrides the selected provider's default model. */
    AI_MODEL: z.string().optional(),
    /**
     * How long one generation may take before the API gives up on it.
     *
     * Must sit *below* the serverless function's own budget — `maxDuration` in
     * `vercel.json`, 120s — so that a slow platform produces a 504 naming the
     * problem rather than the runtime killing the whole invocation and
     * returning an opaque "Task timed out". The 10-second gap is for
     * everything either side of the AI call: the cold start, the database
     * round trips, and printing a PDF. See README section 6.4.
     */
    AI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(600_000)
      .default(110_000),

    /**
     * The reader service `POST /api/jobs/parse` falls back to when a plain
     * fetch of the job page yields no posting — a board that answers 403 to
     * anything that is not a signed-in browser, or a page that is an empty
     * shell until JavaScript runs. The page URL is appended to this prefix and
     * the response is read as Markdown (JSON with `data.content`, or the body
     * itself). Set it to an empty string to disable the fallback. See README
     * section 6.3.
     */
    JOB_READER_URL: z.string().default('https://r.jina.ai/'),
    /**
     * Sent as a bearer token to the reader. Jina answers anonymous calls from
     * a well-behaved network but blocks them from a busy one — a cloud
     * provider's, typically — so a deployment wants a key (free from
     * jina.ai). Optional: without it the fallback is tried unauthenticated.
     */
    JOB_READER_API_KEY: z.string().optional(),
    /**
     * Lets the job parser fetch a URL whose host resolves to a private
     * address. For development behind a VPN or a filtering resolver that
     * answers every name with a local proxy address — where the SSRF check
     * would otherwise refuse every job URL. Ignored, with a warning, when
     * `NODE_ENV=production`: the check is the whole defence there.
     */
    JOB_FETCH_ALLOW_PRIVATE_ADDRESSES: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    /**
     * S3-compatible object storage, for candidate photos.
     *
     * `AWS_ENDPOINT_URL_S3` is what makes this work against Tigris, R2, MinIO
     * or plain AWS from one set of variables — it is the only thing that
     * differs between them. All five are optional together: with none set,
     * photo upload answers 503 and nothing else is affected.
     */
    AWS_ENDPOINT_URL_S3: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().optional(),
    /**
     * The bucket photos are written to. Not one of the four credentials, but
     * the SDK has no default for it and a bucket name is not derivable from an
     * endpoint.
     */
    AWS_S3_BUCKET: z.string().optional(),
    /**
     * How long a signed photo URL stays valid. Long enough that a profile held
     * in the query cache does not start serving broken images, short enough
     * that a link copied out of the DOM is not a permanent one.
     */
    S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(604800).default(3600),

    /**
     * Encrypts the few secrets that live in the database — today only the AI
     * API key an admin saves from the app (see `src/crypto/secret-box.ts`).
     *
     * Optional. Left unset, the key is derived from `JWT_ACCESS_SECRET`, which
     * every deployment already has; the cost is that rotating that secret makes
     * a stored API key undecryptable, and the app falls back to the environment
     * variable for the provider. Set it explicitly to decouple the two:
     *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     */
    CONFIG_ENCRYPTION_KEY: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET — sharing one secret lets a ' +
          'refresh token be replayed as an access token.',
      });
    }

    // The browser rejects `SameSite=None` outright unless `Secure` is also set,
    // and `Secure` is only sent in production. Failing here beats shipping a
    // deployment where every login silently sets no cookie at all.
    if (value.COOKIE_SAMESITE === 'none' && value.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SAMESITE'],
        message:
          'COOKIE_SAMESITE=none requires NODE_ENV=production, because browsers drop a ' +
          'SameSite=None cookie that is not also Secure.',
      });
    }
  });

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}\n\nSee .env.example.`);
  }

  const value = parsed.data;

  // Tests run against their own database so a truncate between cases can never
  // touch development data.
  const databaseUrl =
    value.NODE_ENV === 'test' ? (value.TEST_DATABASE_URL ?? value.DATABASE_URL) : value.DATABASE_URL;

  // The key is not required at boot. A deployment with no AI configured should
  // still serve every other route; it is the Resume endpoint alone that fails,
  // with a message saying which variable is missing.
  const aiApiKey = {
    openai: value.OPENAI_API_KEY,
    anthropic: value.ANTHROPIC_API_KEY,
    gemini: value.GEMINI_API_KEY,
    deepseek: value.DEEPSEEK_API_KEY,
  }[value.AI_PROVIDER];

  const storageEnabled = Boolean(
    value.AWS_ENDPOINT_URL_S3 &&
      value.AWS_ACCESS_KEY_ID &&
      value.AWS_SECRET_ACCESS_KEY &&
      value.AWS_REGION &&
      value.AWS_S3_BUCKET,
  );

  return {
    ...value,
    DATABASE_URL: databaseUrl,
    /** The key for `AI_PROVIDER`, or undefined when that provider has none set. */
    aiApiKey,
    /** Whether object storage is configured well enough to accept a photo. */
    storageEnabled,
    /** `true` once the app is served over HTTPS, which gates the Secure cookie flag. */
    isProduction: value.NODE_ENV === 'production',
    corsOrigins: value.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

export const env = loadEnv();
export type Env = typeof env;
