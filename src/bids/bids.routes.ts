import { Router } from 'express';
import multer from 'multer';
import { currentActor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { contentDisposition } from '../http/content-disposition.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import * as bidsService from './bids.service.js';
import { stepsRouter } from './steps.routes.js';
import { autoMakeNewApplication } from '../local/chatgpt-resume.js';
import { companySizeFromNotes, isLargeCompany } from './company-size.js';
import * as resumeService from '../resume/resume.service.js';
import * as coverLetterService from '../cover-letter/cover-letter.service.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '../storage/s3.client.js';
import { ResumePayloadSchema } from '../resume/resume.schemas.js';
import { CoverLetterPayloadSchema } from '../cover-letter/cover-letter.schemas.js';
import type { ResumeFileFormat } from '../domain/types.js';
import { checkBidQuietly } from '../resume/resume-check.js';
import {
  BidIdParamsSchema,
  BidResumeQuerySchema,
  BulkDeleteSchema,
  BulkStatusSchema,
  CreateBidSchema,
  ListBidsQuerySchema,
  PipelineQuerySchema,
  BidsVersionQuerySchema,
  ProofCheckSchema,
  UpdateBidSchema,
  type BidIdParams,
  type BidResumeQuery,
  type BulkDeleteInput,
  type BulkStatusInput,
  type CreateBidInput,
  type ListBidsQuery,
  type PipelineQuery,
  type BidsVersionQuery,
  type ProofCheckInput,
  type UpdateBidInput,
} from './bids.schemas.js';

export const bidsRouter: Router = Router();

bidsRouter.use(requireAuth);

/** An application's interview steps and their files. See `steps.routes.ts`. */
bidsRouter.use('/:id/steps', stepsRouter);

/**
 * The list — whole, or one page of it.
 *
 * A request that names a `page` or a `pageSize` is answered with a `BidPage`;
 * one that names neither gets the array it always did. Two shapes on one route
 * rather than a second route, because the filters are identical and the only
 * question is whether the caller wants all of the answer at once. The Dashboard,
 * the Calendar and the Commitments page still do; the Applications table and
 * the Pipeline board no longer.
 */
bidsRouter.get('/', validate({ query: ListBidsQuerySchema }), async (req, res) => {
  const query = (req as ValidatedRequest<unknown, unknown, ListBidsQuery>).valid.query;
  const actor = currentActor(req);
  const paged = query.page !== undefined || query.pageSize !== undefined;
  res.json(paged ? await bidsService.listBidsPage(actor, query) : await bidsService.listBids(actor, query));
});

/**
 * The Pipeline board's opening state: every stage's count and first page.
 *
 * Declared before `/:id` so "pipeline" is never parsed as a bid id. Not
 * admin-gated even though only an admin is offered the board: a plain account
 * asking gets its own applications, which is a valid answer rather than a leak.
 */
bidsRouter.get('/pipeline', validate({ query: PipelineQuerySchema }), async (req, res) => {
  const query = (req as ValidatedRequest<unknown, unknown, PipelineQuery>).valid.query;
  res.json(await bidsService.pipelineBoard(currentActor(req), query));
});

/** See `bidsVersion`: what pages poll to notice changes made elsewhere. */
bidsRouter.get('/version', validate({ query: BidsVersionQuerySchema }), async (req, res) => {
  const query = (req as ValidatedRequest<unknown, unknown, BidsVersionQuery>).valid.query;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: await bidsService.bidsVersion(currentActor(req), query) });
});

bidsRouter.post('/', validate({ body: CreateBidSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<CreateBidInput>).valid.body;
  const actor = currentActor(req);
  // A new Draft at a company of more than 5,000 employees (the scraper's
  // "Size:" line in the notes) is filed as Skip — and so never made.
  if (body.status === 'Draft' && isLargeCompany(companySizeFromNotes(body.notes))) {
    body.status = 'Skip';
  }
  const bid = await bidsService.createBid(actor, body);
  // A new application gets its Resume and cover letter made in the
  // background (CHATGPT_AUTO_MAKE=true) — from the form or the scraper alike.
  autoMakeNewApplication(actor, bid);
  res.status(201).json(bid);
});

/**
 * Downloads the Resume stored against one application, as PDF or as Word.
 *
 * The document is stored, so this costs nothing at the AI platform — the same
 * application downloads as either format, as often as wanted, and always the
 * Resume that was actually generated for it rather than a fresh one that would
 * say something different.
 *
 * A bid with no stored Resume is a 404 on the Resume, not on the bid: it exists,
 * it simply predates generation or was saved without one.
 */
bidsRouter.get(
  '/:id/resume',
  validate({ params: BidIdParamsSchema, query: BidResumeQuerySchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
    const { format } = (req as ValidatedRequest<unknown, unknown, BidResumeQuery>).valid.query;
    const actor = currentActor(req);

    // A file synced up from the Resume Builder's folder is the Resume that
    // was actually sent, so it is served as it is — no template, no render.
    const synced = await bidsService.getResumeFile(actor, id, format);
    if (synced) {
      res.setHeader('Content-Type', synced.contentType);
      res.setHeader('Content-Length', synced.data.byteLength);
      res.setHeader('Content-Disposition', contentDisposition('attachment', synced.name));
      res.send(synced.data);
      return;
    }

    // The bid is fetched for its owner, not just for the document. A Resume's
    // name, contact line, employers and degrees come from a profile, and the
    // profile it must come from is the candidate's — an admin downloading
    // someone else's application would otherwise get a document with their own
    // name on it.
    const bid = await bidsService.getBid(actor, id);
    const stored = await bidsService.getBidResume(actor, id);
    if (stored === null) {
      throw new NotFoundError(
        bid.resumeFiles
          ? `No ${format === 'pdf' ? 'PDF' : 'Word'} file was synced for this application.`
          : 'No Resume has been synced or generated for this application.',
      );
    }

    // Stored as JSON, so it is parsed rather than trusted: a column written by
    // an older shape of this feature should fail loudly here, not halfway
    // through laying out a page.
    const parsed = ResumePayloadSchema.safeParse(stored);
    if (!parsed.success) {
      throw new NotFoundError(
        "This application's Resume was saved in an older format and cannot be rebuilt. " +
          'Open the application and generate it again.',
      );
    }

    const { file, contentType, fileName } = await resumeService.renderResume(
      bid.candidate?.userId ?? actor.id,
      {
        document: parsed.data,
        format,
        ...(bid.candidate?.profileId ? { profileId: bid.candidate.profileId } : {}),
      },
    );

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', file.byteLength);
    // The candidate's name — the same name the browser download carries.
    // `filename*` is what lets a name with a space or an accent survive;
    // `filename` is the fallback for anything that does not read RFC 5987.
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.send(file);
  },
);

/**
 * The Resume's stored JSON — what the template renders, not a file.
 *
 * Separate from the PDF/Word download: the Applications screen needs to show
 * the document as JSON and to re-render it, and carrying the whole payload on
 * every bid in the list would be paid by rows that never open it.
 */
bidsRouter.get(
  '/:id/resume/document',
  validate({ params: BidIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
    const actor = currentActor(req);

    // Access-checked the same way the file download is: the bid must be in
    // scope before its document is handed out.
    await bidsService.getBid(actor, id);
    const stored = await bidsService.getBidResume(actor, id);
    if (stored === null) {
      throw new NotFoundError('No Resume has been generated for this application.');
    }

    const parsed = ResumePayloadSchema.safeParse(stored);
    if (!parsed.success) {
      throw new NotFoundError(
        "This application's Resume was saved in an older format and cannot be rebuilt. " +
          'Open the application and generate it again.',
      );
    }

    res.json({ document: parsed.data });
  },
);

/**
 * Downloads the cover letter stored against one application, as PDF or Word.
 *
 * The Resume route's twin, on the same terms: the letter was stored when the
 * application was saved, so this costs nothing at the AI platform and always
 * returns the letter that was actually written for this application.
 *
 * A bid with no stored letter is a 404 on the letter, not on the bid — writing
 * one is an optional step, so most applications have none. `hasCoverLetter` on
 * the bid says which.
 */
/**
 * The stored cover letter as JSON — what the Applications table's Copy button
 * turns into plain text. The download route below has the files.
 */
bidsRouter.get('/:id/cover-letter/document', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  const stored = await bidsService.getBidCoverLetter(currentActor(req), id);
  if (stored === null) {
    throw new NotFoundError('No cover letter has been written for this application.');
  }
  const parsed = CoverLetterPayloadSchema.safeParse(stored);
  if (!parsed.success) {
    throw new NotFoundError("This application's cover letter was saved in an older format. Make it again.");
  }
  res.json({ document: parsed.data });
});

bidsRouter.get(
  '/:id/cover-letter',
  validate({ params: BidIdParamsSchema, query: BidResumeQuerySchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
    const { format } = (req as ValidatedRequest<unknown, unknown, BidResumeQuery>).valid.query;
    const actor = currentActor(req);

    // The bid is fetched for its owner, not just for the document: the name at
    // the top and the signature at the bottom come from a profile, and the
    // profile it must come from is the candidate's — an admin downloading
    // someone else's application would otherwise get a letter signed by them.
    const bid = await bidsService.getBid(actor, id);
    const stored = await bidsService.getBidCoverLetter(actor, id);
    if (stored === null) {
      throw new NotFoundError('No cover letter has been written for this application.');
    }

    // Stored as JSON, so it is parsed rather than trusted: a column written by
    // an older shape of this feature should fail loudly here, not halfway
    // through laying out a page.
    const parsed = CoverLetterPayloadSchema.safeParse(stored);
    if (!parsed.success) {
      throw new NotFoundError(
        "This application's cover letter was saved in an older format and cannot be rebuilt. " +
          'Open the application and generate it again.',
      );
    }

    const { file, contentType, fileName } = await coverLetterService.renderCoverLetter(
      bid.candidate?.userId ?? actor.id,
      { document: parsed.data, format },
      // The bid's date, so a letter downloaded months later still carries the
      // day the application was made rather than the day it was printed — and
      // its Profile's name and contact line.
      { date: bid.bidDate, profileId: bid.candidate?.profileId },
    );

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', file.byteLength);
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.send(file);
  },
);

/**
 * The conversation held while filling in this application's form.
 *
 * Its own request rather than a field on the bid: every screen loads the whole
 * bid list, and a transcript per row would be paid for by all of them and read
 * by almost none — the same trade the Resume makes. The list carries
 * `chatMessageCount`, and this carries the text, for the one application being
 * looked at.
 *
 * An application that had no conversation answers `[]` rather than 404: it is a
 * fact about the application, not a resource that is missing.
 */
bidsRouter.get('/:id/chat', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  res.json({ messages: await bidsService.getBidChat(currentActor(req), id) });
});

/**
 * Bulk application actions use the same profile access scope as single-row
 * actions. Admins can act across profiles; users can act only within profiles
 * shared with them.
 *
 * Declared before `/:id` so "bulk" is never parsed as a bid id.
 */
bidsRouter.post('/bulk/status', validate({ body: BulkStatusSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<BulkStatusInput>).valid.body;
  res.json(await bidsService.bulkUpdateStatus(currentActor(req), body));
});

bidsRouter.post('/bulk/delete', validate({ body: BulkDeleteSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<BulkDeleteInput>).valid.body;
  res.json(await bidsService.bulkDeleteBids(currentActor(req), body));
});

/**
 * The Resume files the folder sync sends up: the PDF and the Word document the
 * desktop Resume Builder wrote. Held in memory, as every upload here is; a
 * Resume heavier than this is not a Resume.
 */
const MAX_RESUME_FILE_BYTES = 15 * 1024 * 1024;
const resumeFilesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_FILE_BYTES, files: 2 },
});

const RESUME_FILE_CONTENT_TYPES: Record<ResumeFileFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Whether the bytes are what the field says they are. The browser's MIME type
 * is not consulted: it comes from the file's extension, and a Word file saved
 * as `.pdf` by hand would be served as a PDF that no viewer can open.
 */
function looksLike(format: ResumeFileFormat, data: Buffer): boolean {
  if (format === 'pdf') return data.subarray(0, 5).toString('latin1') === '%PDF-';
  // A .docx is a zip: a local file header, or an empty archive.
  const head = data.subarray(0, 4).toString('latin1');
  return head === 'PK\u0003\u0004' || head === 'PK\u0005\u0006';
}

/**
 * Stores the Resume files synced up from an application's folder: multipart
 * with a `pdf` and/or a `docx` field. Answers with the whole bid, its
 * `resumeFiles` naming and hashing what is now stored, which is what the next
 * sync compares against. POST rather than PUT because the browser's upload
 * helper is a POST, and a file of the same format is replaced in place either
 * way.
 */
bidsRouter.post(
  '/:id/resume-files',
  validate({ params: BidIdParamsSchema }),
  resumeFilesUpload.fields([
    { name: 'pdf', maxCount: 1 },
    { name: 'docx', maxCount: 1 },
  ]),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
    const fields = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;

    const files: bidsService.ResumeFileUpload[] = [];
    for (const format of ['pdf', 'docx'] as const) {
      const file = fields[format]?.[0];
      if (!file) continue;
      if (!file.buffer?.length) throw new BadRequestError(`The ${format} file is empty.`);
      if (!looksLike(format, file.buffer)) {
        throw new BadRequestError(`The \`${format}\` field does not hold a ${format === 'pdf' ? 'PDF' : 'Word'} file.`);
      }
      files.push({
        format,
        // multer reads the name as latin1; browsers send UTF-8.
        name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        contentType: RESUME_FILE_CONTENT_TYPES[format],
        data: file.buffer,
      });
    }
    if (files.length === 0) throw new BadRequestError('No Resume file was uploaded. Send `pdf` and/or `docx`.');

    const actor = currentActor(req);
    await bidsService.replaceResumeFiles(actor, id, files);
    await checkBidQuietly(id);
    res.json(await bidsService.getBid(actor, id));
  },
);

/**
 * Deletes the application's Resume (files and generated document) — the
 * Delete button in the Applications table, for one that came out wrong. The
 * automatic maker then makes it again. The bid comes back without it.
 */
bidsRouter.delete('/:id/resume', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  res.json(await bidsService.deleteResume(currentActor(req), id));
});

/** Deletes the application's cover letter; the automatic maker writes it again. The bid comes back without it. */
bidsRouter.delete('/:id/cover-letter', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  const actor = currentActor(req);
  await bidsService.deleteCoverLetter(actor, id);
  // The letter's reasons go with it; the Resume's stay.
  await checkBidQuietly(id);
  res.json(await bidsService.getBid(actor, id));
});

/** Removes every synced Resume file from an application. The bid comes back without them. */
bidsRouter.delete('/:id/resume-files', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  const actor = currentActor(req);
  await bidsService.removeResumeFiles(actor, id);
  await checkBidQuietly(id);
  res.json(await bidsService.getBid(actor, id));
});

/**
 * The screenshot is held in memory rather than spooled to disk, exactly as the
 * candidate photo is: capped at 5 MB and on its way straight to the bucket.
 */
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

/** The file the two proof routes take, refused before any service code runs when it is not one. */
function proofFileOf(req: { file?: Express.Multer.File }): Express.Multer.File {
  const file = req.file;
  if (!file) throw new BadRequestError('No screenshot was uploaded. Send one as the `proof` field.');
  if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.mimetype)) {
    throw new BadRequestError(
      `That file is a ${file.mimetype}. Screenshots must be one of: ${PHOTO_CONTENT_TYPES.join(', ')}.`,
    );
  }
  return file;
}

/**
 * The check the form runs the moment a screenshot is picked: is this picture
 * already on one of the profile's other applications? Nothing is stored. The
 * same multipart shape as the upload, plus `bidId` (editing) or `userId` (an
 * admin filing for a candidate) as fields beside the file.
 */
bidsRouter.post(
  '/proof/check',
  proofUpload.single('proof'),
  validate({ body: ProofCheckSchema }),
  async (req, res) => {
    const file = proofFileOf(req);
    const scope = (req as ValidatedRequest<ProofCheckInput>).valid.body;
    res.json(await bidsService.checkProof(currentActor(req), file.buffer, scope));
  },
);

/**
 * The proof that this application was really submitted: a screenshot of the
 * job site's "thank you for applying" page, uploaded by the candidate when the
 * application is filed and checked by an admin.
 *
 * Its own multipart route rather than a field on `POST /api/bids`, for the
 * reason the photo has one: the bid is JSON the form edits and re-saves, the
 * screenshot is a file picked once. Anyone who can write the bid can replace
 * its proof; only an admin can remove one, because the screenshot is what a
 * candidate is checked against.
 */
bidsRouter.post(
  '/:id/proof',
  validate({ params: BidIdParamsSchema }),
  proofUpload.single('proof'),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
    const file = proofFileOf(req);
    res.json(await bidsService.replaceProof(currentActor(req), id, file.buffer, file.mimetype));
  },
);

/**
 * The screenshots elsewhere that are the same picture as this application's,
 * for the details view. The upload answers with the same list at the time;
 * this is for looking again later.
 */
bidsRouter.get('/:id/proof/matches', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  res.json(await bidsService.proofMatches(currentActor(req), id));
});

bidsRouter.delete(
  '/:id/proof',
  validate({ params: BidIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
    res.json(await bidsService.removeProof(currentActor(req), id));
  },
);

bidsRouter.get('/:id', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  res.json(await bidsService.getBid(currentActor(req), id));
});

bidsRouter.patch(
  '/:id',
  validate({ params: BidIdParamsSchema, body: UpdateBidSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<UpdateBidInput, BidIdParams>;
    res.json(await bidsService.updateBid(currentActor(req), valid.params.id, valid.body));
  },
);

bidsRouter.delete('/:id', validate({ params: BidIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, BidIdParams>).valid.params;
  await bidsService.deleteBid(currentActor(req), id);
  res.status(204).end();
});
