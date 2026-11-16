/**
 * When two company names mean the same employer.
 *
 * Postings, people and job boards write one company several ways — "Acme",
 * "Acme Inc.", "ACME, Inc", "The Acme Company" — and an exact match treats each
 * as a different employer, so a second application at the same place goes
 * unnoticed. `companyKey` reduces a name to what identifies it:
 *
 *   - case and accents ignored            ("Nestlé" = "nestle")
 *   - apostrophes dropped                 ("Domino's" = "Dominos")
 *   - "&" read as "and"                   ("Johnson & Johnson" = "Johnson and Johnson")
 *   - punctuation and spacing ignored     ("Placer.ai" = "Placer ai" = "placerai")
 *   - a leading "The" ignored
 *   - trailing legal forms ignored        ("Inc", "LLC", "Corp", "Ltd", "GmbH", …)
 *
 * It is deliberately *not* a fuzzy match: "Meta" and "Meta Platforms" stay
 * different, because the same looseness would call "Metabase" a duplicate.
 *
 * A deliberate copy lives in the frontend's `src/lib/company.ts`; the two must
 * give the same answer, so change them together.
 */

const LEGAL_FORMS = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'llc',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'bv',
  'pty',
  'llp',
  'lp',
]);

export function companyKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  if (words[0] === 'the' && words.length > 1) words.shift();
  // Only from the end, and never the whole name: "Company.com" or a firm
  // actually called "Co" must still have a key.
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1]!)) words.pop();

  return words.join('') || name.trim().toLowerCase();
}

/** Whether two names are the same employer by `companyKey`. */
export function sameCompany(a: string, b: string): boolean {
  return companyKey(a) === companyKey(b);
}

/**
 * The legal forms dropped from a stored name. "Company" and "Co" are kept:
 * they are part of how many names are written ("The Walt Disney Company").
 */
const TIDY_FORMS = new Set([...LEGAL_FORMS].filter((form) => form !== 'company' && form !== 'co'));

/**
 * A scraped company name as it should be stored: the trailing legal form
 * removed ("Acme, Inc." → "Acme"), everything else as the page wrote it.
 * Keeps the names in the list consistent with each other; matching does not
 * depend on it, since `companyKey` ignores the legal form anyway.
 */
export function tidyCompanyName(name: string): string {
  let tidy = name.replace(/\s+/g, ' ').trim();
  for (;;) {
    const match = /^(.*?)[,\s]+([A-Za-z]+)\.?$/.exec(tidy);
    if (!match || !TIDY_FORMS.has(match[2]!.toLowerCase()) || !match[1]!.trim()) return tidy;
    tidy = match[1]!.replace(/[,\s]+$/, '');
  }
}
