/**
 * Whether a new application is at a company too large to bother with — more
 * than 500 employees (SKIP_COMPANY_SIZE_OVER) — so it is filed as "Skip" and
 * no Resume or cover letter is made for it.
 *
 * The size comes from the application's notes, where the HiringCafe scraper
 * writes it as a line of its own: `Size: 1001-5000`. Sizes are ranges as often
 * as numbers, so a range counts by its lower bound: "501-1000" is over 500,
 * "201-500" is not. "500+" and "> 500" mean more than 500.
 */

const DEFAULT_LIMIT = 500;

function limit(): number {
  const configured = Number(process.env.SKIP_COMPANY_SIZE_OVER);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIMIT;
}

/** The `Size:` line of the notes, or `null` when there is none. */
export function companySizeFromNotes(notes: string | null | undefined): string | null {
  const match = /^\s*(?:company\s+)?size\s*:\s*(.+)$/im.exec(notes ?? '');
  return match?.[1]?.trim() || null;
}

/**
 * The smallest headcount a size can mean, and whether it is open-ended
 * ("10,000+", "> 500"). `null` when the text holds no number.
 */
export function parseCompanySize(size: string): { min: number; openEnded: boolean } | null {
  const text = size.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const number = /(\d+(?:\.\d+)?)\s*(k|m)?/.exec(text);
  if (!number) return null;
  const scale = number[2] === 'k' ? 1_000 : number[2] === 'm' ? 1_000_000 : 1;
  const min = Math.round(Number(number[1]) * scale);
  const openEnded = /\+|>|\bover\b|more than|\bplus\b/.test(text) && !/\d\s*[-–]\s*\d/.test(text);
  return { min, openEnded };
}

/** More than the limit (500 by default)? Unknown sizes are never skipped. */
export function isLargeCompany(size: string | null | undefined): boolean {
  if (!size) return false;
  const parsed = parseCompanySize(size);
  if (!parsed) return false;
  const over = limit();
  return parsed.min > over || (parsed.openEnded && parsed.min >= over);
}
