/**
 * When two job links are the same posting.
 *
 * The Jobright / HiringCafe scraper extension asks "is this posting already an
 * application?" by link, and a link picks up noise on its way there: tracking
 * parameters, a `#fragment`, a trailing slash, different capitalisation. This
 * reduces a link to what identifies the posting. It is the same rule as the
 * extension's own `normalizeJobUrl` (and the Google Sheet script's), so a link
 * counts as a duplicate in all three places or in none.
 */
export function jobUrlKey(url: string): string {
  const raw = url.trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  }
}
