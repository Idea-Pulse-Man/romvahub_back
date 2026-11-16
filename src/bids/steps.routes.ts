import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { currentActor } from '../auth/actor.js';
import { contentDisposition } from '../http/content-disposition.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { isNaiveDateTime, parseNaiveDateTime } from '../domain/dates.js';
import { INTERVIEW_STEP_TYPES } from '../domain/types.js';
import { prisma } from '../prisma.js';
import { assertBidAccess, getBid } from './bids.service.js';

/**
 * An application's interview steps — `/api/bids/:id/steps` — and the files
 * attached to them. Mounted under the bids router, which has already required
 * a signed-in user; every route checks the bid is the caller's (a 404
 * otherwise, as for the bid itself).
 *
 * Every change answers with the whole updated bid, steps included, so the
 * drawer and the board redraw from one response.
 */
export const stepsRouter = Router({ mergeParams: true });

/** What a step file may weigh. They are kept in the database, so kept small. */
const MAX_STEP_FILE_BYTES = 10 * 1024 * 1024;

const scheduledAt = z
  .string()
  .trim()
  .refine((value) => value === '' || isNaiveDateTime(value), 'Use YYYY-MM-DDTHH:mm:ss.')
  .nullish();

const StepFieldsSchema = z.object({
  type: z.enum(INTERVIEW_STEP_TYPES),
  companyName: z.string().trim().max(200).optional(),
  scheduledAt,
  timezone: z.string().trim().max(64).nullish(),
  durationMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  details: z.string().max(20_000).optional(),
});
const CreateStepSchema = StepFieldsSchema;
const UpdateStepSchema = StepFieldsSchema.partial();
type CreateStepInput = z.infer<typeof CreateStepSchema>;
type UpdateStepInput = z.infer<typeof UpdateStepSchema>;

const StepParamsSchema = z.object({ id: z.uuid(), stepId: z.uuid() });
const FileParamsSchema = StepParamsSchema.extend({ fileId: z.uuid() });
type StepParams = z.infer<typeof StepParamsSchema>;
type FileParams = z.infer<typeof FileParamsSchema>;

function stepData(input: UpdateStepInput) {
  return {
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
    ...(input.scheduledAt !== undefined
      ? { scheduledAt: input.scheduledAt ? parseNaiveDateTime(input.scheduledAt) : null }
      : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone || null } : {}),
    ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes ?? null } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

/** A step that belongs to this bid, or a 404. */
async function stepOf(bidId: string, stepId: string) {
  const step = await prisma.interviewStep.findFirst({ where: { id: stepId, bidId }, select: { id: true } });
  if (!step) throw new NotFoundError('No such interview step.');
  return step;
}

/**
 * A change to a step is a change to its application: bumping `updatedAt` is
 * what moves `GET /api/bids/version`, so other open pages refresh.
 */
async function touchBid(bidId: string) {
  await prisma.bid.update({ where: { id: bidId }, data: { updatedAt: new Date() } });
}

stepsRouter.post('/', validate({ body: CreateStepSchema }), async (req, res) => {
  const actor = currentActor(req);
  const bidId = String(req.params.id);
  await assertBidAccess(actor, bidId);
  const input = (req as ValidatedRequest<CreateStepInput>).valid.body;

  const last = await prisma.interviewStep.aggregate({ where: { bidId }, _max: { position: true } });
  await prisma.interviewStep.create({
    data: { bidId, position: (last._max.position ?? -1) + 1, ...stepData(input), type: input.type },
  });
  await touchBid(bidId);
  res.status(201).json(await getBid(actor, bidId));
});

stepsRouter.patch(
  '/:stepId',
  validate({ params: StepParamsSchema, body: UpdateStepSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { id, stepId } = (req as ValidatedRequest<UpdateStepInput, StepParams>).valid.params;
    await assertBidAccess(actor, id);
    await stepOf(id, stepId);
    const input = (req as ValidatedRequest<UpdateStepInput>).valid.body;
    await prisma.interviewStep.update({ where: { id: stepId }, data: stepData(input) });
    await touchBid(id);
    res.json(await getBid(actor, id));
  },
);

stepsRouter.delete('/:stepId', validate({ params: StepParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { id, stepId } = (req as ValidatedRequest<unknown, StepParams>).valid.params;
  await assertBidAccess(actor, id);
  await stepOf(id, stepId);
  await prisma.interviewStep.delete({ where: { id: stepId } });
  await touchBid(id);
  res.json(await getBid(actor, id));
});

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_STEP_FILE_BYTES, files: 1 },
});

stepsRouter.post(
  '/:stepId/files',
  validate({ params: StepParamsSchema }),
  fileUpload.single('file'),
  async (req, res) => {
    const actor = currentActor(req);
    const { id, stepId } = (req as ValidatedRequest<unknown, StepParams>).valid.params;
    await assertBidAccess(actor, id);
    await stepOf(id, stepId);
    const file = req.file;
    if (!file?.buffer?.length) throw new BadRequestError('No file was uploaded. Send one as the `file` field.');

    await prisma.interviewStepFile.create({
      data: {
        stepId,
        // multer reads the name as latin1; browsers send UTF-8.
        name: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255),
        contentType: file.mimetype || 'application/octet-stream',
        size: file.size,
        data: new Uint8Array(file.buffer),
      },
    });
    await touchBid(id);
    res.status(201).json(await getBid(actor, id));
  },
);

stepsRouter.get('/:stepId/files/:fileId', validate({ params: FileParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { id, stepId, fileId } = (req as ValidatedRequest<unknown, FileParams>).valid.params;
  await assertBidAccess(actor, id);
  const file = await prisma.interviewStepFile.findFirst({ where: { id: fileId, stepId, step: { bidId: id } } });
  if (!file) throw new NotFoundError('No such file.');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', file.size);
  res.setHeader('Content-Disposition', contentDisposition('attachment', file.name));
  res.send(Buffer.from(file.data));
});

stepsRouter.delete('/:stepId/files/:fileId', validate({ params: FileParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { id, stepId, fileId } = (req as ValidatedRequest<unknown, FileParams>).valid.params;
  await assertBidAccess(actor, id);
  const { count } = await prisma.interviewStepFile.deleteMany({ where: { id: fileId, stepId, step: { bidId: id } } });
  if (count === 0) throw new NotFoundError('No such file.');
  await touchBid(id);
  res.json(await getBid(actor, id));
});
