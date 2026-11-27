import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { answerTask, failTask, heartbeat, nextTask, reportStatus } from './engine.js';

/**
 * The make engine's links for a computer's browser (the Romva Apply extension):
 *
 *   GET  /api/maker/next?worker=…              the next task (null: none now)
 *   POST /api/maker/tasks/:id/answer           { worker, answer }
 *   POST /api/maker/tasks/:id/failed           { worker, reason, unavailable }
 *   POST /api/maker/tasks/:id/heartbeat        { worker }  (a long answer: keep the application held)
 *   POST /api/maker/status                     { worker, sites, note }
 *
 * What a computer makes, and whether it runs, is its Start window's choice
 * (/api/auto-make/computers).
 */

export const makerRouter: Router = Router();
makerRouter.use(requireAuth);

const Worker = z.string().min(1).max(200);
const Params = z.object({ id: z.string().uuid() });

/**
 * Answered at once: the browser asks again every 30 seconds while idle (an
 * alarm), right after each answer, and at once when Run is clicked on the
 * website — so the database is not asked over and over while nothing happens
 * (Supabase counts every byte sent out).
 */
makerRouter.get('/next', validate({ query: z.object({ worker: Worker }) }), async (req, res) => {
  const actor = currentActor(req);
  const { worker } = (req as ValidatedRequest<unknown, unknown, { worker: string }>).valid.query;
  res.json({ task: await nextTask(actor, worker) });
});

const AnswerSchema = z.object({ worker: Worker, answer: z.string().min(1).max(500_000) });
makerRouter.post('/tasks/:id/answer', validate({ params: Params, body: AnswerSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, z.infer<typeof Params>>).valid.params;
  const { worker, answer } = (req as ValidatedRequest<z.infer<typeof AnswerSchema>>).valid.body;
  await answerTask(currentActor(req), worker, id, answer);
  res.json({ ok: true });
});

const FailedSchema = z.object({ worker: Worker, reason: z.string().min(1).max(4000), unavailable: z.boolean().default(false) });
makerRouter.post('/tasks/:id/failed', validate({ params: Params, body: FailedSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, z.infer<typeof Params>>).valid.params;
  const body = (req as ValidatedRequest<z.infer<typeof FailedSchema>>).valid.body;
  await failTask(currentActor(req), body.worker, id, body);
  res.json({ ok: true });
});

makerRouter.post('/tasks/:id/heartbeat', validate({ params: Params, body: z.object({ worker: Worker }) }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, z.infer<typeof Params>>).valid.params;
  const { worker } = (req as ValidatedRequest<{ worker: string }>).valid.body;
  await heartbeat(worker, id);
  res.json({ ok: true });
});

const StatusSchema = z.object({
  worker: Worker,
  sites: z.record(z.string(), z.enum(['in', 'out', 'unknown'])).optional(),
  note: z.string().max(2000).nullable().optional(),
});
makerRouter.post('/status', validate({ body: StatusSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<z.infer<typeof StatusSchema>>).valid.body;
  await reportStatus(body.worker, body);
  res.json({ ok: true });
});
