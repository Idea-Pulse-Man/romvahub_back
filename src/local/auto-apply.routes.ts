import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import * as bidsService from '../bids/bids.service.js';
import { bidAccessScope } from '../bids/bids.service.js';
import { CoverLetterPayloadSchema } from '../cover-letter/cover-letter.schemas.js';
import { renderCoverLetter } from '../cover-letter/cover-letter.service.js';
import { NotFoundError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { prisma } from '../prisma.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import * as profileService from '../profile/profile.service.js';
import { currentJob } from './current-job.js';
import { fileStem } from './make-steps.js';

/**
 * Apply: the Chrome extension and the desktop agent open each application's
 * job page and fill the form in; the person checks it and clicks Submit
 * themselves. Nothing here submits, screenshots or changes a status.
 *
 *   GET /api/auto-make/apply/next?limit=3&skip=<ids>  → applications ready to apply to
 *   GET /api/auto-make/apply/:bidId                   → what to fill in: the applicant,
 *                                                        the Resume and cover letter files,
 *                                                        and the job post and Resume text
 *                                                        (for the agent's ChatGPT answers
 *                                                        to the form's own questions)
 *
 * Ready: a Draft with a job link, its Resume and its cover letter made.
 */

/** How far back "ready" looks: older Drafts are left to the person. */
const LOOKBACK_DAYS = 14;

const NextQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(3),
  // Comma-separated ids the worker has already opened.
  skip: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)) : [])),
});
const BidParamsSchema = z.object({ bidId: z.string().uuid() });

type NextQuery = z.infer<typeof NextQuerySchema>;
type BidParams = z.infer<typeof BidParamsSchema>;

/** A link worth typing into a form: not empty, and not just a site's front page ("https://www.linkedin.com/"). */
function realLink(url: string | null | undefined): string {
  try {
    const parsed = new URL(String(url ?? '').trim());
    return parsed.pathname.replace(/\/+$/, '') ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export const autoApplyRouter: Router = Router();
autoApplyRouter.use(requireAuth);

autoApplyRouter.get('/apply/next', validate({ query: NextQuerySchema }), async (req, res) => {
  const actor = currentActor(req);
  const { limit, skip } = (req as ValidatedRequest<unknown, unknown, NextQuery>).valid.query;
  const rows = await prisma.bid.findMany({
    where: {
      AND: [
        bidAccessScope(actor),
        {
          status: 'DRAFT',
          createdAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000) },
          jobUrl: { not: null },
          NOT: [
            { jobUrl: '' },
            { coverLetterDocument: { equals: PrismaTypes.AnyNull } },
            ...(skip.length ? [{ id: { in: skip } }] : []),
          ],
          resumeFiles: { some: {} },
        },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, number: true, company: true, role: true, jobUrl: true },
  });
  res.json({
    jobs: rows.map((row) => ({ bidId: row.id, number: row.number, company: row.company, role: row.role, jobUrl: row.jobUrl })),
  });
});

autoApplyRouter.get('/apply/:bidId', validate({ params: BidParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { bidId } = (req as ValidatedRequest<unknown, BidParams>).valid.params;
  const bid = await bidsService.getBid(actor, bidId);
  if (!bid.jobUrl) throw new NotFoundError('This application has no job link.');

  const ownerUserId = bid.candidate?.userId ?? actor.id;
  const profile = bid.candidate?.profileId
    ? await profileService.getProfileById(bid.candidate.profileId)
    : await profileService.getProfile(ownerUserId);

  const resumePdf = await bidsService.getResumeFile(actor, bid.id, 'pdf');
  const made = await prisma.bid.findUnique({ where: { id: bid.id }, select: { resumeDocument: true } });
  // The same current job, under the same title, as the Resume attached to the form.
  const current = currentJob(profile.workExperience, made?.resumeDocument);
  const letterRaw = await bidsService.getBidCoverLetter(actor, bid.id);
  const letter = CoverLetterPayloadSchema.safeParse(letterRaw);

  const firstName = (profile.hasPreferredName && profile.preferredFirstName) || profile.firstName;
  const lastName = (profile.hasPreferredName && profile.preferredLastName) || profile.lastName;
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const stem = fileStem(profile.firstName, profile.lastName) || 'Resume';

  let coverLetterPdf: { name: string; base64: string } | null = null;
  if (letter.success) {
    try {
      const rendered = await renderCoverLetter(
        ownerUserId,
        { document: letter.data, format: 'pdf' },
        { date: bid.bidDate, profileId: bid.candidate?.profileId },
      );
      coverLetterPdf = { name: `${stem}_Cover_Letter.pdf`, base64: rendered.file.toString('base64') };
    } catch {
      coverLetterPdf = null; // The text is still offered for a cover letter box.
    }
  }

  res.json({
    bidId: bid.id,
    company: bid.company,
    role: bid.role,
    jobUrl: bid.jobUrl,
    applicant: {
      firstName,
      lastName,
      fullName,
      email: profile.email,
      phone: profile.phone,
      linkedin: realLink(profile.linkedinUrl),
      github: realLink(profile.githubUrl),
      website: realLink(profile.portfolioUrl) || realLink(profile.otherUrl),
      location: profile.location || [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
      address: profile.addressLine,
      city: profile.city,
      state: profile.state,
      zipCode: profile.zipCode,
      country: profile.country,
      currentCompany: current.company,
      currentTitle: current.title,
      authorizedCountries: profile.authorizedCountries,
      openToRelocation: profile.openToRelocation,
      noticePeriod: profile.noticePeriod,
      gender: profile.gender,
      ethnicity: profile.ethnicity,
      veteranStatus: profile.veteranStatus,
      disabilityStatus: profile.disabilityStatus,
    },
    resume: resumePdf ? { name: `${stem}_Resume.pdf`, base64: resumePdf.data.toString('base64') } : null,
    coverLetter: coverLetterPdf,
    jobDescription: (bid.jobDescription ?? '').slice(0, 20_000),
    resumeText: made?.resumeDocument ? JSON.stringify(made.resumeDocument).slice(0, 20_000) : '',
    coverLetterText: letter.success
      ? [letter.data.greeting, ...letter.data.paragraphs, letter.data.closing, fullName].filter(Boolean).join('\n\n')
      : '',
  });
});
