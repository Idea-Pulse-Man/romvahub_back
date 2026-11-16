import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { env } from '../env.js';
import { currentActor, isAdmin, targetUserId } from '../auth/actor.js';
import { requireAdmin, requireAuth } from '../auth/require-auth.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { contentDisposition } from '../http/content-disposition.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import * as profilesService from '../admin/profiles.service.js';
import {
  GenerateResumeSchema,
  ListModelsSchema,
  RenderResumeSchema,
  type GenerateResumeInput,
  type ListModelsInput,
  type RenderResumeInput,
} from './resume.schemas.js';
import { ProcessMakerSchema, type ProcessMakerInput } from './maker/maker.schemas.js';
import * as makerService from './maker/maker.service.js';
import * as makerTemplates from './maker/templates.js';
import * as resumeService from './resume.service.js';

export const resumeRouter: Router = Router();

resumeRouter.use(requireAuth);

/**
 * Tighter than the job-parse limiter, because every press of this button costs
 * real money at an AI platform rather than someone else's bandwidth. Ten a
 * minute is more than a person filling in a form can use and far less than an
 * accident in a retry loop can spend.
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
      message: 'Too many Resumes generated. Please wait a minute and try again.',
    },
  },
});

/**
 * Rendering costs no money, but printing a PDF starts a browser, so this is
 * limited on CPU rather than on spend. Three files per Resume — a preview and
 * the two downloads — leaves the limit far above normal use.
 */
const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many Resumes rendered. Please wait a minute and try again.',
    },
  },
});

/** Listing a catalogue is cheap at every vendor — no tokens, no generation. */
const listModelsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many model lookups. Please wait a minute and try again.',
    },
  },
});

const templateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

/**
 * Writes the Resume's content and answers with it as JSON.
 *
 * Deliberately not a file. Generating and rendering are separate requests so
 * that the AI is paid for once and both file formats come from the one answer —
 * downloading a Word copy of a Resume already on screen costs nothing.
 */
resumeRouter.post(
  '/generate',
  generateLimiter,
  validate({ body: GenerateResumeSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<GenerateResumeInput>).valid.body;
    // Whose prompts: the candidate's own, or the one an admin named.
    const { document, provider, model } = await resumeService.generateResume(
      input,
      targetUserId(currentActor(req), input.userId),
    );

    // Which platform wrote it, for support questions and for the admin screen
    // that will later let this be chosen per deployment.
    res.setHeader('X-Resume-Provider', provider);
    res.setHeader('X-Resume-Model', model);
    res.json({ document });
  },
);

/**
 * Renders a generated payload into the Resume template, as PDF or as Word.
 *
 * The payload comes from the client, the profile from the session. That split
 * is the point: what is tailored per application travels with the request, and
 * the facts about the person do not — a client cannot assert someone else's
 * name onto a page.
 *
 * `userId` is the one exception, and it names an account rather than asserting
 * anything: an administrator filing an application for a candidate renders the
 * preview from *that* candidate's profile. `targetUserId` is what makes it an
 * exception only for them — anyone else naming another account is refused.
 */
resumeRouter.post(
  '/render',
  renderLimiter,
  validate({ body: RenderResumeSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<RenderResumeInput>).valid.body;
    const actor = currentActor(req);
    if (
      input.profileId &&
      !isAdmin(actor) &&
      !(await profilesService.isSharedWith(actor.id, input.profileId))
    ) {
      throw new NotFoundError('No such profile.');
    }
    const { file, contentType, fileName } = await resumeService.renderResume(
      targetUserId(actor, input.userId),
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

/**
 * Lists Maker DOCX templates available for mail-merge.
 */
resumeRouter.get('/maker/templates', async (_req, res) => {
  res.json({ templates: await makerTemplates.listTemplates() });
});

/**
 * Uploads a new Maker .docx template (admin). Replaces an existing file of the
 * same name.
 */
resumeRouter.post(
  '/maker/templates',
  requireAdmin,
  templateUpload.single('template'),
  async (req, res) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError('No template was uploaded. Send one as the `template` field.');
    }
    if (
      file.mimetype !==
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
      !file.originalname.toLowerCase().endsWith('.docx')
    ) {
      throw new BadRequestError('Templates must be .docx Word documents.');
    }

    const saved = await makerTemplates.saveUploadedTemplate(file.originalname, file.buffer);
    res.status(201).json(saved);
  },
);

/**
 * Deletes a Maker template (admin). The built-in `default.docx` cannot be removed.
 */
resumeRouter.delete('/maker/templates/:id', requireAdmin, async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
  if (!id) throw new BadRequestError('Template id is required.');
  await makerTemplates.deleteTemplate(id);
  res.status(204).send();
});

/**
 * Maker studio: paste flat JSON + pick a template → DOCX or approximate PDF.
 */
resumeRouter.post(
  '/maker/process',
  renderLimiter,
  validate({ body: ProcessMakerSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<ProcessMakerInput>).valid.body;
    const { file, contentType, fileName, meta, templateId } = await makerService.processMakerJson({
      json: input.json,
      format: input.format,
      templateId: input.templateId,
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', file.byteLength);
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.setHeader('X-Resume-Template', templateId);
    res.setHeader('X-Resume-Candidate', meta.candidateName);
    res.send(file);
  },
);

/**
 * Convert an edited Maker DOCX (from the in-browser Word editor) to PDF.
 * Same Word COM / HTML fallback path as `format: 'pdf'` on `/maker/process`.
 */
resumeRouter.post(
  '/maker/to-pdf',
  renderLimiter,
  templateUpload.single('document'),
  async (req, res) => {
    const file = req.file;
    if (!file?.buffer?.length) {
      throw new BadRequestError('No Word document was uploaded. Send one as the `document` field.');
    }
    if (
      file.mimetype !==
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
      !file.originalname.toLowerCase().endsWith('.docx')
    ) {
      throw new BadRequestError('Only .docx Word documents can be converted to PDF.');
    }

    const pdf = await makerService.convertDocxToPdf(file.buffer);
    const stem = file.originalname.replace(/\.docx$/i, '') || 'Resume';
    const fileName = `${stem}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.byteLength);
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.send(pdf);
  },
);

/**
 * Lists the models on a platform that the given key can use, for the admin
 * screen's model picker: choose a platform, paste a key, pick from what comes
 * back. The key in the body is used for the one call and discarded.
 *
 * Admin-only, which is what the comment here used to say it should be as soon
 * as there was a role to gate it on. The picker is on the AI Settings screen,
 * and the key it lists against is the deployment's.
 */
resumeRouter.post(
  '/models',
  requireAdmin,
  listModelsLimiter,
  validate({ body: ListModelsSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<ListModelsInput>).valid.body;
    res.json(await resumeService.listModels(input));
  },
);
