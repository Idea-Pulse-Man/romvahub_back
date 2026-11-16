/**
 * Resolves "where" and "what client" for a successful sign-in.
 *
 * Geo comes from a public HTTPS lookup (ipwho.is) with a short timeout so a
 * slow or blocked lookup never delays login. Private / loopback addresses are
 * labelled locally without a network call. User-Agent is parsed with light
 * heuristics — enough for admin review, not a full fingerprinting stack.
 */
import { logger } from '../logger.js';

export interface ClientGeo {
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  org: string | null;
  /** Human-readable place line, e.g. "Orlando, FL". */
  locationLabel: string | null;
}

export interface ClientDevice {
  browser: string | null;
  os: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
}

export interface LoginEnrichment extends ClientGeo, ClientDevice {
  ip: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
}

const MAX_USER_AGENT_LENGTH = 512;
const MAX_LANGUAGE_LENGTH = 128;
const GEO_TIMEOUT_MS = 1500;

export function isPrivateOrLocalIp(ip: string): boolean {
  const bare = stripIpZone(ip);
  if (bare === '127.0.0.1' || bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (bare.startsWith('10.')) return true;
  if (bare.startsWith('192.168.')) return true;
  if (bare.startsWith('169.254.')) return true;
  const m = /^172\.(\d+)\./.exec(bare);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 unique-local / link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(bare) || /^fe80:/i.test(bare)) return true;
  return false;
}

/** Strip IPv6 zone id (`%eth0`) and surrounding brackets. */
function stripIpZone(ip: string): string {
  let value = ip.trim();
  if (value.startsWith('[') && value.includes(']')) {
    value = value.slice(1, value.indexOf(']'));
  }
  const zone = value.indexOf('%');
  return zone >= 0 ? value.slice(0, zone) : value;
}

/** US + CA province/state names → postal abbreviations when `region_code` is absent. */
const REGION_ABBREVIATIONS: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  alberta: 'AB',
  'british columbia': 'BC',
  manitoba: 'MB',
  'new brunswick': 'NB',
  'newfoundland and labrador': 'NL',
  'northwest territories': 'NT',
  'nova scotia': 'NS',
  nunavut: 'NU',
  ontario: 'ON',
  'prince edward island': 'PE',
  quebec: 'QC',
  saskatchewan: 'SK',
  yukon: 'YT',
};

function regionAbbreviation(region: string | null, regionCode: string | null): string | null {
  const code = regionCode?.trim().toUpperCase();
  // Prefer short postal codes (FL, ON). Numeric ISO subdiv codes stay unused.
  if (code && /^[A-Z]{2}$/.test(code)) return code;
  if (!region) return null;
  return REGION_ABBREVIATIONS[region.trim().toLowerCase()] ?? null;
}

/**
 * Compact place line for list UIs:
 * - US / CA → "Orlando, FL"
 * - Elsewhere with city → "Berlin, Germany"
 * - Region-only → "Florida" / "Bavaria, Germany"
 */
export function buildLocationLabel(parts: {
  city: string | null;
  region: string | null;
  regionCode: string | null;
  country: string | null;
  countryCode: string | null;
}): string | null {
  const city = parts.city?.trim() || null;
  const region = parts.region?.trim() || null;
  const countryCode = parts.countryCode?.trim().toUpperCase() || null;
  const country = parts.country?.trim() || null;
  const abbrev = regionAbbreviation(region, parts.regionCode);
  const domestic = countryCode === 'US' || countryCode === 'CA';

  if (domestic) {
    if (city && abbrev) return `${city}, ${abbrev}`;
    if (city && region) return `${city}, ${region}`;
    if (abbrev) return abbrev;
    if (region) return region;
    if (city) return city;
    return countryCode;
  }

  if (city && country) return `${city}, ${country}`;
  if (city && countryCode) return `${city}, ${countryCode}`;
  if (city && region) return `${city}, ${region}`;
  if (region && country) return `${region}, ${country}`;
  return city || region || country || countryCode;
}

async function lookupGeo(ip: string): Promise<ClientGeo> {
  const empty: ClientGeo = {
    country: null,
    countryCode: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    org: null,
    locationLabel: null,
  };

  if (isPrivateOrLocalIp(ip)) {
    return {
      ...empty,
      locationLabel: 'Local / private network',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);

  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(stripIpZone(ip))}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return empty;

    const body = (await response.json()) as {
      success?: boolean;
      country?: string;
      country_code?: string;
      region?: string;
      region_code?: string;
      city?: string;
      latitude?: number;
      longitude?: number;
      timezone?: { id?: string } | string;
      connection?: { isp?: string; org?: string };
    };

    if (body.success === false) return empty;

    const country = body.country?.trim() || null;
    const countryCode = body.country_code?.trim() || null;
    const region = body.region?.trim() || null;
    const regionCode = body.region_code?.trim() || null;
    const city = body.city?.trim() || null;
    const timezone =
      typeof body.timezone === 'string'
        ? body.timezone.trim() || null
        : body.timezone?.id?.trim() || null;
    const isp = body.connection?.isp?.trim() || null;
    const org = body.connection?.org?.trim() || null;

    return {
      country,
      countryCode,
      region,
      city,
      latitude: typeof body.latitude === 'number' ? body.latitude : null,
      longitude: typeof body.longitude === 'number' ? body.longitude : null,
      timezone,
      isp,
      org,
      locationLabel: buildLocationLabel({ city, region, regionCode, country, countryCode }),
    };
  } catch (error) {
    logger.warn(
      { err: error, ip },
      'Login geo lookup failed; recording sign-in without location details',
    );
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

export function parseUserAgent(userAgent: string | null): ClientDevice {
  if (!userAgent) {
    return { browser: null, os: null, deviceType: 'unknown' };
  }

  const ua = userAgent;

  let deviceType: ClientDevice['deviceType'] = 'desktop';
  if (/bot|crawl|spider|slurp|facebookexternalhit/i.test(ua)) deviceType = 'bot';
  else if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    deviceType = 'tablet';
  } else if (/Mobile|iPhone|iPod|Android.*Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    deviceType = 'mobile';
  }

  let os: string | null = null;
  if (/Windows NT 10/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/i.test(ua)) os = 'Windows 7';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X ([\d_]+)/i.test(ua)) {
    const ver = /Mac OS X ([\d_]+)/i.exec(ua)?.[1];
    os = ver ? `macOS ${ver.replace(/_/g, '.')}` : 'macOS';
  } else if (/Android ([\d.]+)/i.test(ua)) {
    const ver = /Android ([\d.]+)/i.exec(ua)?.[1];
    os = ver ? `Android ${ver}` : 'Android';
  } else if (/iPhone OS ([\d_]+)/i.test(ua) || /CPU OS ([\d_]+)/i.test(ua)) {
    const ver = /(?:iPhone OS|CPU OS) ([\d_]+)/i.exec(ua)?.[1];
    os = ver ? `iOS ${ver.replace(/_/g, '.')}` : 'iOS';
  } else if (/CrOS/i.test(ua)) os = 'Chrome OS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser: string | null = null;
  if (/Edg\/([\d.]+)/i.test(ua)) {
    const ver = /Edg\/([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `Edge ${ver}` : 'Edge';
  } else if (/OPR\/([\d.]+)/i.test(ua) || /Opera\/([\d.]+)/i.test(ua)) {
    const ver = /(?:OPR|Opera)\/([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `Opera ${ver}` : 'Opera';
  } else if (/Firefox\/([\d.]+)/i.test(ua)) {
    const ver = /Firefox\/([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `Firefox ${ver}` : 'Firefox';
  } else if (/Chrome\/([\d.]+)/i.test(ua) && !/Chromium/i.test(ua)) {
    const ver = /Chrome\/([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `Chrome ${ver}` : 'Chrome';
  } else if (/CriOS\/([\d.]+)/i.test(ua)) {
    const ver = /CriOS\/([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `Chrome ${ver}` : 'Chrome';
  } else if (/Safari\/([\d.]+)/i.test(ua) && /Version\/([\d.]+)/i.test(ua)) {
    const ver = /Version\/([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `Safari ${ver}` : 'Safari';
  } else if (/MSIE ([\d.]+)/i.test(ua) || /Trident\/.*rv:([\d.]+)/i.test(ua)) {
    const ver = /(?:MSIE |rv:)([\d.]+)/i.exec(ua)?.[1];
    browser = ver ? `IE ${ver}` : 'IE';
  }

  return { browser, os, deviceType };
}

/**
 * Builds the enrichment payload written onto `LoginHistory`. Never throws —
 * login must succeed even when geo / parsing fails.
 */
export async function enrichLoginContext(input: {
  ip?: string | null;
  userAgent?: string | null;
  acceptLanguage?: string | null;
}): Promise<LoginEnrichment> {
  const ip = input.ip?.trim() || null;
  const rawUa = input.userAgent?.trim() || null;
  const userAgent = rawUa ? rawUa.slice(0, MAX_USER_AGENT_LENGTH) : null;
  const acceptLanguage = input.acceptLanguage?.trim().slice(0, MAX_LANGUAGE_LENGTH) || null;
  const device = parseUserAgent(userAgent);
  const geo = ip ? await lookupGeo(ip) : {
    country: null,
    countryCode: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    org: null,
    locationLabel: null,
  };

  return {
    ip,
    userAgent,
    acceptLanguage,
    ...device,
    ...geo,
  };
}
