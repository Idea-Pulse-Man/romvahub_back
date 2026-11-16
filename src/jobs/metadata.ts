/**
 * The title and company a page hands over are rarely the role and the
 * employer, plain. A `<title>` is "Senior Engineer at Acme | Greenhouse",
 * "Acme - Senior Engineer", "Acme hiring Senior Engineer in Austin, TX |
 * LinkedIn", or — for a JavaScript shell — just "Recruitment"; `og:site_name`
 * is the board as often as it is the employer. Structured sources (JSON-LD, a
 * board's API) are better but still put the company in the title now and
 * then, and one of them — ADP — never names the employer at all, so the
 * description has to.
 *
 * Everything here is a guess that the user can overwrite in the form. The
 * goal is only that the guess be right more often than the raw string.
 */

export interface MetadataInput {
  /**
   * Title candidates, best first. The first one that yields a plausible role
   * wins; the rest are consulted only for a company the winner lacked.
   */
  titles: (string | undefined)[];
  /**
   * True when `titles[0]` names the posting itself — JSON-LD `title` or a
   * board API's own field — rather than being a page title. A structured title
   * is kept whole apart from a trailing company; a page title is taken apart.
   */
  structured: boolean;
  /** The employer as a structured source named it, when one did. */
  company?: string;
  /** `og:site_name`: the employer on a company-run page, the board elsewhere. */
  siteName?: string;
  /** The posting as Markdown, read for the employer's name when nothing else has it. */
  markdown: string;
  /** The posting's URL. On a hosted board its path names the employer's account. */
  url?: string;
}

export interface RefinedMetadata {
  title?: string;
  company?: string;
}

/**
 * Names a page title carries that are never the employer: the boards, and the
 * words a careers site calls itself. Lower-cased; matched whole.
 */
const BOARD_NAMES = new Set(
  [
    'greenhouse',
    'lever',
    'ashby',
    'ashbyhq',
    'workday',
    'myworkdayjobs',
    'linkedin',
    'indeed',
    'indeed.com',
    'adp',
    'adp workforcenow',
    'workforcenow',
    'workforce now',
    'workable',
    'smartrecruiters',
    'jobvite',
    'icims',
    'bamboohr',
    'recruitee',
    'teamtailor',
    'personio',
    'rippling',
    'wellfound',
    'glassdoor',
    'ziprecruiter',
    'monster',
    'dice',
    'taleo',
    'successfactors',
    'sap successfactors',
    'ultipro',
    'ukg',
    'paylocity',
    'paycom',
    'dayforce',
    'dayforce hcm',
    'dayforcehcm',
    'ceridian',
    'jazzhr',
    'breezy hr',
    'breezy',
    'applytojob',
    'welcome to the jungle',
    'y combinator',
    'work at a startup',
    'builtin',
    'built in',
    'jobs',
    'job',
    'careers',
    'career',
    'career center',
    'careers page',
    'careers site',
    'job board',
    'job details',
    'job detail',
    'job description',
    'job openings',
    'job opening',
    'open positions',
    'open roles',
    'recruitment',
    'talent community',
    'apply',
    'home',
  ].map((name) => name.toLowerCase()),
);

/** A title made only of these is the shell's, not the posting's. */
const GENERIC_TITLE =
  /^(?:recruitment|careers?(?:\s+(?:page|site|portal))?|jobs?|job\s+(?:details?|description|opening|application|posting|search)|career\s+cent(?:er|re)|apply(?:\s+now)?|loading|home|open\s+(?:positions?|roles?)|opportunit(?:y|ies)|position|untitled)$/i;

/** Words that appear in a role and almost never in a company name. */
const ROLE_WORDS =
  /\b(?:engineer|engineering|developer|programmer|architect|designer|manager|management|director|lead|head|chief|officer|vp|vice president|president|analyst|scientist|researcher|specialist|consultant|coordinator|administrator|assistant|associate|representative|recruiter|accountant|controller|technician|operator|nurse|physician|therapist|teacher|instructor|intern|internship|apprentice|fellow|senior|junior|staff|principal|sme|expert|strategist|writer|editor|producer|marketer|sales|account executive|customer success|support|advisor|adviser|counsel|attorney|paralegal|partner|founder|cto|ceo|cfo|coo|cmo|full[- ]?stack|front[- ]?end|back[- ]?end|devops|sre|qa|ux|ui|pm)\b/i;

/** "Austin, TX", "Austin, TX 78701", "Remote", "Remote - US". */
const LOCATION_LIKE = /^(?:remote(?:\b.*)?|[\p{L} .'-]+,\s*[\p{L} .'-]+(?:\s+\d{4,6})?)$/iu;

const LEGAL_SUFFIX = /[,\s]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|gmbh|ag|sa|bv|pty|llp|lp)\.?$/i;

/** "Austin, TX" is a place; "Coalition, Inc." has the same shape and is not. */
function isLocationLike(value: string): boolean {
  return LOCATION_LIKE.test(value) && !LEGAL_SUFFIX.test(value);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The words a board puts after its own name in `og:site_name` and page
 * titles: "Rippling Recruiting", "Greenhouse Job Board", "Lever Careers".
 * Peeled off before the name is looked up, so each board need not be listed
 * in every phrasing it uses.
 */
const SITE_WORDS =
  /\s+(?:recruiting|recruitment|careers?|jobs?|job\s+board|job\s+boards?|ats|hiring|talent|hr|job\s+portal|careers?\s+(?:page|site|portal))$/i;

function isBoardName(value: string): boolean {
  const name = value.toLowerCase().replace(/[.!]+$/, '').replace(/^powered\s+by\s+/, '').trim();
  if (BOARD_NAMES.has(name)) return true;
  const head = name.replace(SITE_WORDS, '').trim();
  return head !== name && BOARD_NAMES.has(head);
}

function isGeneric(value: string): boolean {
  return GENERIC_TITLE.test(value.trim()) || isBoardName(value);
}

/** "Acme Corp" and "acme" compare equal; "ACME, Inc." too. */
function sameName(a: string, b: string): boolean {
  const norm = (value: string) =>
    value.toLowerCase().replace(LEGAL_SUFFIX, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && (x === y || x === norm(b.replace(LEGAL_SUFFIX, '')) || y === norm(a.replace(LEGAL_SUFFIX, '')));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "Acme Corp Inc." → ["Acme Corp Inc.", "Acme Corp", "Acme"]. */
function nameForms(company: string): string[] {
  const forms = [company.trim()];
  for (;;) {
    const shorter = forms[forms.length - 1]!.replace(LEGAL_SUFFIX, '').trim();
    if (shorter === forms[forms.length - 1] || shorter.length < 2) break;
    forms.push(shorter);
  }
  return forms;
}

/**
 * "Senior Engineer at Acme", "Senior Engineer - Acme", "Senior Engineer |
 * Acme", "Senior Engineer (Acme)", "Acme - Senior Engineer", "Acme: Senior
 * Engineer" all become "Senior Engineer" once Acme is known to be the company.
 */
export function stripCompanyFromTitle(title: string, company: string | undefined): string {
  if (!company) return title;
  const names = nameForms(company).filter((name) => name.length > 1);
  let result = title;
  for (const name of names) {
    const escaped = escapeRegExp(name.trim());
    const next = result
      .replace(new RegExp(`\\s*(?:[-–—|:,·]|\\bat\\b|@|\\bwith\\b|\\bfor\\b)\\s*${escaped}\\s*$`, 'i'), '')
      .replace(new RegExp(`\\s*\\(\\s*${escaped}\\s*\\)\\s*$`, 'i'), '')
      .replace(new RegExp(`^${escaped}\\s*(?:[-–—|:·]|\\bhiring\\b|\\bis hiring\\b)\\s*`, 'i'), '');
    if (next.trim() && next !== result) result = next.trim();
  }
  return result;
}

interface ParsedTitle {
  role?: string;
  company?: string;
  /**
   * True when the company is only a guess about where a separator fell —
   * "Role - Company" — rather than something the title says outright ("Role
   * at Company"). The whole title stays the role in that case, because a
   * company named anywhere else outranks the guess; `refineMetadata` takes
   * the name out of the title once it has settled on one.
   */
  weakCompany?: boolean;
}

/** The separators a title is split on, kept so a split title can be put back together. */
const KEEP_SEPARATOR = /(\s*(?:\||·|—|–)\s*)/;
const KEEP_DASH = /(\s+-\s+)/;

/**
 * The title with its location parts taken out and its separators left as they
 * were: "Product Designer | Remote | Stripe" → "Product Designer | Stripe".
 */
function withoutLocations(title: string, pattern: RegExp): string {
  const pieces = title.split(pattern);
  let result = '';
  for (let index = 0; index < pieces.length; index += 2) {
    const part = pieces[index]!.trim();
    if (!part || isLocationLike(part)) continue;
    result += result ? `${pieces[index - 1] ?? ' - '}${part}` : part;
  }
  return result || title;
}

/**
 * Takes a page title apart. The rules are the shapes the common boards use;
 * a title that fits none of them is returned whole, which is the right answer
 * for "Controls SME - Design".
 */
export function parsePageTitle(raw: string, siteName?: string): ParsedTitle {
  let title = clean(raw) ?? '';
  if (!title) return {};

  title = title.replace(/^job application for\s+/i, '').replace(/^apply (?:for|to)\s+/i, '');

  // Peel the board and the site's own name off either end, however many times.
  const isNoise = (part: string) =>
    isBoardName(part) || (!!siteName && sameName(part, siteName) && isBoardName(siteName));
  const edge = /\s*(?:\||·|—|–|-|::|»)\s*/;
  for (;;) {
    const parts = title.split(edge).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) break;
    const last = parts[parts.length - 1]!;
    const first = parts[0]!;
    if (isNoise(last)) {
      title = title.slice(0, title.length - last.length).replace(/\s*(?:\||·|—|–|-|::|»)\s*$/, '').trim();
      continue;
    }
    if (isNoise(first)) {
      title = title.slice(first.length).replace(/^\s*(?:\||·|—|–|-|::|»)\s*/, '').trim();
      continue;
    }
    break;
  }
  if (!title || isGeneric(title)) return {};

  // "Rendered Inc Careers", "Jobs at Acme": the site, not a posting. The
  // company is still worth having.
  const careersPage =
    /^(.+?)\s+(?:careers?|jobs|job openings|career opportunities|talent community)$/i.exec(title) ??
    /^(?:careers?|jobs|work|working)\s+(?:at|with|@)\s+(.+)$/i.exec(title);
  if (careersPage && !ROLE_WORDS.test(careersPage[1]!)) return { company: clean(careersPage[1]) };

  // LinkedIn: "Acme hiring Senior Engineer in Austin, TX".
  const hiring = /^(.+?)\s+(?:is\s+)?hiring\s+(?:an?\s+)?(.+?)(?:\s+in\s+[\p{L} .,'-]+)?$/iu.exec(title);
  if (hiring) return { company: clean(hiring[1]), role: clean(hiring[2]) };

  // "Senior Engineer at Acme", "Senior Engineer @ Acme" — the last "at" wins,
  // so "Engineer at scale at Acme" keeps its first one.
  const at = /^(.+)\s+(?:at|@)\s+([^|·—–-]+?)(?:\s*[|·—–-].*)?$/i.exec(title);
  if (at && clean(at[1]) && clean(at[2]) && !isLocationLike(at[2]!.trim())) {
    const rest = title.slice(at[0].indexOf(at[2]!) + at[2]!.length);
    const role = pickRole([at[1]!, ...rest.split(edge)]);
    return { role, company: clean(at[2]) };
  }

  // Two or three parts either side of a separator: one is the role, another
  // may be the company, and a third is often the location.
  const parts = title.split(/\s*(?:\||·|—|–)\s*/).map((part) => part.trim()).filter(Boolean);
  const dashParts = parts.length === 1 ? title.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean) : parts;
  if (dashParts.length >= 2 && dashParts.length <= 3) {
    const nonLocation = dashParts.filter((part) => !isLocationLike(part));
    if (nonLocation.length === 1) return { role: nonLocation[0] };
    if (nonLocation.length === 2) {
      const [a, b] = nonLocation as [string, string];
      const aRole = ROLE_WORDS.test(a);
      const bRole = ROLE_WORDS.test(b);
      // A hyphen is ordinary inside a role name — "Controls SME - Design" —
      // so on a hyphen alone the company side has to look like a name in its
      // own right, or come first the way Lever writes it ("Acme - Role").
      const hyphenOnly = parts.length === 1;
      // Whichever side is picked, the pick is a guess about the separator
      // rather than anything the title says, so the whole title stays the
      // role and the guess is marked weak: on "Software Engineer -
      // Auth0/AuthZ (Java)" the employer is New Relic, named in the document
      // title, and the hyphen only separates a role from its team.
      const whole = withoutLocations(title, hyphenOnly ? KEEP_DASH : KEEP_SEPARATOR);
      if (aRole && !bRole && (!hyphenOnly || looksLikeCompany(b))) {
        return { role: whole, company: b, weakCompany: true };
      }
      if (bRole && !aRole) return { role: whole, company: a, weakCompany: true };
      // "Senior Engineer | Acme" is the far more common order when neither
      // side gives itself away, but only a `|`-style separator is safe to
      // split on: a hyphen inside a role name is ordinary.
      if (parts.length === 2) return { role: whole, company: b, weakCompany: true };
    }
    if (parts.length === 1) return { role: title };
  }

  return { role: title };
}

/**
 * More than one word, a legal suffix, or an ampersand: "Applied Digital",
 * "Acme Inc", "AT&T". A bracket or a slash rules it out: "Auth0/AuthZ (Java)"
 * is how a title qualifies a role, not how a company writes its name.
 */
function looksLikeCompany(value: string): boolean {
  if (/[()[\]/]/.test(value)) return false;
  return /\s/.test(value.trim()) || LEGAL_SUFFIX.test(value) || /[&.]/.test(value);
}

function pickRole(candidates: string[]): string | undefined {
  const cleaned = candidates.map(clean).filter((part): part is string => !!part && !isGeneric(part));
  return cleaned.find((part) => ROLE_WORDS.test(part)) ?? cleaned[0];
}

const NOT_A_COMPANY =
  /^(?:the|this|our|us|you|your|me|a|an|it|its|role|position|job|team|company|opportunity|us\b.*|the\s+(?:role|team|company|position|job|opportunity|work|program|programme|department|group|firm|practice|project|client|organisation|organization))$/i;

/**
 * A capitalised run of one to five words, the way company names are written:
 * "Applied Digital", "Temporal Technologies", "AT&T", "3M", "eBay", "K2 Space".
 */
const NAME_RUN = "(?:[A-Z0-9][\\p{L}\\p{N}&'’.+-]*|e[A-Z]\\p{L}+)(?:[ \\t]+(?:[A-Z0-9&][\\p{L}\\p{N}&'’.+-]*|of|and|&|the|de|for))*";

/**
 * Where a posting names its employer when nothing else does:
 * "About Applied Digital", "**About Applied Digital:**", "At Applied Digital,
 * we…", "Applied Digital is hiring…", "Join Applied Digital as…".
 */
export function companyFromMarkdown(markdown: string): string | undefined {
  const head = markdown.slice(0, 6_000);
  // No `i` flag: the name has to be capitalised, or "About the role" and
  // "Join our team" would qualify. The lead-in words are spelled out instead.
  const line = '[^\\S\\n]*';
  const patterns = [
    new RegExp(`^[^\\p{L}\\n]*(?:About|ABOUT)[ \\t]+(${NAME_RUN})${line}[^\\p{L}\\n]*$`, 'mu'),
    new RegExp(`^[^\\p{L}\\n]*(?:Why|Life at|Working at|Who [Ww]e [Aa]re at|Welcome to)[ \\t]+(${NAME_RUN})${line}[^\\p{L}\\n]*$`, 'mu'),
    new RegExp(`(?:^|[.!?][ \\t]+|\\n[^\\p{L}\\n]*)[Aa]t[ \\t]+(${NAME_RUN}),[ \\t]+(?:we|our|you)\\b`, 'mu'),
    new RegExp(`(?:^|\\n)[^\\p{L}\\n]*(${NAME_RUN})[ \\t]+is[ \\t]+(?:hiring|looking for|seeking|searching for|growing)`, 'mu'),
    // "CentralReach is a leading provider of…" opening a paragraph. Only at a
    // paragraph start, where a posting introduces its employer, and not when
    // what follows is what a requirement says of a skill ("Terraform is a plus").
    new RegExp(
      `(?:^|\\n\\n)[^\\p{L}\\n]*(${NAME_RUN})[ \\t]+(?:is|was|has been)[ \\t]+(?:a|an|the|one of)\\b` +
        `(?![ \\t]+(?:plus|bonus|must|requirement|advantage|nice|strong|big|huge|key|core|major|definite|language|framework|library|tool|platform|skill)s?\\b)`,
      'u',
    ),
    new RegExp(`(?:^|[.!?][ \\t]+|\\n[^\\p{L}\\n]*)[Jj]oin[ \\t]+(${NAME_RUN})[ \\t]+(?:as|and|to|in|on)\\b`, 'mu'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(head);
    const name = clean(match?.[1]?.replace(/[*_:,.]+$/, ''));
    if (!name) continue;
    if (NOT_A_COMPANY.test(name) || isGeneric(name)) continue;
    if (name.split(/\s+/).length > 5 || name.length > 60) continue;
    return name;
  }
  return undefined;
}

/**
 * Hosted boards put the employer's account in the URL:
 * `job-boards.greenhouse.io/centralreach/jobs/…`, `jobs.lever.co/acme/…`,
 * `acme.wd1.myworkdayjobs.com/…`. Returns that segment, lower-case, or nothing.
 */
export function boardSlug(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];

  // Dayforce puts the locale first: `jobs.dayforcehcm.com/en-US/aline/candidateportal/jobs/1197`.
  if (/^jobs\.dayforcehcm\.com$/.test(host)) {
    const slug = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(first ?? '') ? segments[1] : first;
    return slug && !/^(?:jobs?|careers?|candidateportal)$/i.test(slug) ? slug : undefined;
  }

  const pathBoards = [
    /^(?:job-boards|boards)(?:\.[a-z-]+)?\.greenhouse\.io$/,
    /^jobs\.lever\.co$/,
    /^jobs\.ashbyhq\.com$/,
    /^apply\.workable\.com$/,
    /^jobs\.smartrecruiters\.com$/,
    /^jobs\.jobvite\.com$/,
    /^(?:www\.)?comeet\.com$/,
    /^jobs\.gem\.com$/,
    /^ats\.rippling\.com$/,
  ];
  if (pathBoards.some((pattern) => pattern.test(host))) {
    return first && !/^(?:jobs?|careers?|embed|o|apply|company)$/i.test(first) ? first : undefined;
  }

  const subdomainBoards = [
    /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/,
    /^([a-z0-9-]+)\.bamboohr\.com$/,
    /^([a-z0-9-]+)\.recruitee\.com$/,
    /^([a-z0-9-]+)\.teamtailor\.com$/,
    /^([a-z0-9-]+)\.applytojob\.com$/,
    /^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/,
    /^careers-([a-z0-9-]+)\.icims\.com$/,
    /^([a-z0-9-]+)\.breezy\.hr$/,
    /^([a-z0-9-]+)\.pinpointhq\.com$/,
    /^([a-z0-9-]+)\.homerun\.co$/,
  ];
  for (const pattern of subdomainBoards) {
    const slug = pattern.exec(host)?.[1];
    if (slug && !/^(?:www|jobs|careers|apply)$/.test(slug)) return slug;
  }
  return undefined;
}

/**
 * The slug is the employer's name with its casing and spaces gone —
 * `centralreach`, `applied-digital`. The page has the real spelling somewhere,
 * so the slug is looked up in the text case-insensitively, with and without its
 * hyphens, and the text's own spelling is returned. Failing that, a slug the
 * board already cased (SmartRecruiters' `CentralReach1`) is kept, minus its
 * numeric suffix, and a lower-case one is title-cased: wrong for CamelCase
 * names, but better than an empty field.
 */
export function companyFromSlug(rawSlug: string, haystack: string): string | undefined {
  const slug = rawSlug.replace(/\d+$/, '') || rawSlug;
  const words = slug.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return undefined;

  const forms = new Set<string>([slug, words.join(''), words.join(' ')]);
  for (const form of forms) {
    const escaped = escapeRegExp(form).replace(/ /g, '[ \\t]+');
    const match = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped})(?![\\p{L}\\p{N}])`, 'iu').exec(haystack);
    if (match?.[1]) {
      const found = match[1].replace(/\s+/g, ' ');
      // Prefer a spelling that is not all lower-case, which is a URL again.
      if (found !== found.toLowerCase()) return found;
    }
  }

  if (slug !== slug.toLowerCase()) return words.join(' ');
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

/** The first heading in a reader's Markdown is the page's `<h1>`, and on a job page that is the role. */
export function firstHeading(markdown: string): string | undefined {
  for (const match of markdown.matchAll(/^#{1,3}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = clean(match[1]?.replace(/[*_`]/g, ''));
    if (!heading || heading.length > 120 || isGeneric(heading)) continue;
    return heading;
  }
  return undefined;
}

export function refineMetadata(input: MetadataInput): RefinedMetadata {
  let company = clean(input.company);
  if (company && isBoardName(company)) company = undefined;

  // `og:site_name` is the employer on a company-run careers site and the
  // board's own name on a hosted one. A board we know by name is skipped
  // outright; on a URL that is a hosted board's (`ats.rippling.com/moov/…`)
  // a site name we do not know is still more likely the board's than the
  // employer's, so there it is the last resort rather than the first answer.
  const siteName = clean(input.siteName);
  const hostedBoard = !!input.url && boardSlug(input.url) !== undefined;
  const siteNameUsable = !!siteName && !isBoardName(siteName) && !isGeneric(siteName);
  if (!company && siteNameUsable && !hostedBoard) company = siteName;

  let title: string | undefined;
  const candidates = input.titles.map(clean).filter((value): value is string => !!value);

  if (input.structured && candidates[0]) {
    title = candidates[0];
    candidates.shift();
  }

  // A company guessed from where a separator fell is held back: another
  // candidate may name one outright ("… at New Relic"), and so may the
  // posting or the board's URL. It is used only when none of them does.
  let weakCompany: string | undefined;

  for (const candidate of candidates) {
    const parsed = parsePageTitle(candidate, siteName);
    if (!title && parsed.role && !isGeneric(parsed.role)) title = parsed.role;
    if (parsed.company && !isBoardName(parsed.company)) {
      if (parsed.weakCompany) weakCompany ??= parsed.company;
      else company ??= parsed.company;
    }
    if (title && company) break;
  }

  if (!title) title = firstHeading(input.markdown);
  if (!company) company = companyFromMarkdown(input.markdown);

  if (!company && input.url) {
    const slug = boardSlug(input.url);
    if (slug) company = companyFromSlug(slug, [...candidates, title ?? '', input.markdown].join('\n'));
  }
  if (!company) company = weakCompany;
  if (!company && siteNameUsable) company = siteName;

  if (title) {
    const stripped = stripCompanyFromTitle(title, company);
    if (stripped && !isGeneric(stripped)) title = stripped;
    if (isGeneric(title)) title = undefined;
  }

  return {
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
  };
}
