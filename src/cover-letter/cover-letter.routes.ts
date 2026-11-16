import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';
import { currentActor, targetUserId } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { contentDisposition } from '../http/content-disposition.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import {
  GenerateCoverLetterSchema,
  RenderCoverLetterSchema,
  type GenerateCoverLetterInput,
  type RenderCoverLetterInput,
} from './cover-letter.schemas.js';
import * as coverLetterService from './cover-letter.service.js';

export const coverLetterRouter: Router = Router();

coverLetterRouter.use(requireAuth);

/**
 * The Resume's limits, for the same reasons: every press of the write button
 * costs real money at an AI platform, and every render starts a browser. A
 * letter is one more generation per application, not a burst of them.
 */
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many cover letters generated. Please wait a minute and try again.',
    },
  },
});

const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many cover letters rendered. Please wait a minute and try again.',
    },
  },
});

/**
 * Writes the cover letter's content and answers with it as JSON.
 *
 * Deliberately not a file, and deliberately not part of the Resume's answer.
 * The letter is written *from* the finished Resume — which travels in the body,
 * because on the application form it has not been saved yet, and on the JSON
 * route it was never generated here at all — and both of its file formats then
 * come from this one answer.
 */
coverLetterRouter.post(
  '/generate',
  generateLimiter,
  validate({ body: GenerateCoverLetterSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<GenerateCoverLetterInput>).valid.body;
    // Whose prompts: the candidate's own, or the one an admin named.
    const { document, provider, model } = await coverLetterService.generateCoverLetter(
      input,
      targetUserId(currentActor(req), input.userId),
    );

    // Which platform wrote it, for support questions — the same two headers the
    // Resume answers with.
    res.setHeader('X-Resume-Provider', provider);
    res.setHeader('X-Resume-Model', model);
    res.json({ document });
  },
);

/**
 * Renders a generated letter into the template, as PDF or as Word.
 *
 * The letter comes from the client, the name and contact line from the session.
 * That split is the point: what is tailored per application travels with the
 * request, and the facts about the person do not — a client cannot sign
 * someone else's name to a letter.
 *
 * `userId` is the one exception, and it names an account rather than asserting
 * anything: an administrator filing an application for a candidate previews the
 * letter from *that* candidate's profile. `targetUserId` is what makes it an
 * exception only for them.
 */
coverLetterRouter.post(
  '/render',
  renderLimiter,
  validate({ body: RenderCoverLetterSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<RenderCoverLetterInput>).valid.body;
    const { file, contentType, fileName } = await coverLetterService.renderCoverLetter(
      targetUserId(currentActor(req), input.userId),
      input,
    );

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', file.byteLength);
    // `inline`, because this one is shown in the preview panel rather than
    // saved — but named properly all the same: the browser's own PDF viewer
    // offers a download button, and it uses this name.
    res.setHeader('Content-Disposition', contentDisposition('inline', fileName));
    res.send(file);
  },
);
