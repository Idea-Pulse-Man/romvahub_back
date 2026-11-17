import type { Actor } from '../auth/actor.js';
import { prisma } from '../prisma.js';
import { assertProfileAccess } from './profile-prompts.service.js';

/**
 * Each application Profile's "Avoid" lists, read by the scraper extension
 * before it saves a job for that Profile:
 *
 *   - roles     — a job whose title contains one of these is not saved
 *                 ("Manager", "Intern", "QA");
 *   - companies — a job at a company whose name contains one of these is not
 *                 saved ("Amazon", "Meta").
 *
 * Matching is whole words and ignores case, so "Intern" skips "Software
 * Engineer Intern" but not "Internal Tools Engineer". The extension does the
 * matching; the server only stores the lists.
 *
 * Readable and editable by an admin and by every User the Profile is shared
 * with — the same people who edit its prompts.
 */

/** Most entries kept per list, and the longest entry. */
export const MAX_AVOID_ENTRIES = 300;
export const MAX_AVOID_ENTRY_LENGTH = 100;

export interface ProfileAvoidLists {
  avoidRoles: string[];
  avoidCompanies: string[];
}

/** Trimmed, single-spaced, without empties or repeats (any case), in the order given. */
export function cleanAvoidList(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of entries) {
    const text = entry.replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  return kept;
}

export async function getAvoidLists(actor: Actor, profileId: string): Promise<ProfileAvoidLists> {
  await assertProfileAccess(actor, profileId);
  return prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: { avoidRoles: true, avoidCompanies: true },
  });
}

/** Replaces either list; a list left out is untouched. */
export async function updateAvoidLists(
  actor: Actor,
  profileId: string,
  input: { avoidRoles?: string[]; avoidCompanies?: string[] },
): Promise<ProfileAvoidLists> {
  await assertProfileAccess(actor, profileId);
  return prisma.profile.update({
    where: { id: profileId },
    data: {
      ...(input.avoidRoles !== undefined ? { avoidRoles: cleanAvoidList(input.avoidRoles) } : {}),
      ...(input.avoidCompanies !== undefined ? { avoidCompanies: cleanAvoidList(input.avoidCompanies) } : {}),
    },
    select: { avoidRoles: true, avoidCompanies: true },
  });
}
