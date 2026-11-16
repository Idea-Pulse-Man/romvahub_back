/**
 * A `Content-Disposition` header that survives a real filename.
 *
 * Resumes are named after a person, a company and a job title, so the name
 * carries spaces and — the moment somebody called Zoë or Müller uses this —
 * characters outside ASCII. A bare `filename="…"` cannot express those: the
 * header is Latin-1 by the letter of RFC 7230, and browsers handed a raw UTF-8
 * byte in one produce mojibake rather than an error.
 *
 * RFC 6266 §4.3 is the answer: send both. `filename*` carries the real name
 * percent-encoded as UTF-8, and every current browser prefers it; the quoted
 * `filename` beside it is an ASCII-folded fallback for anything that does not.
 */

/** Strips a name back to what a quoted `filename` can safely hold. */
function asciiFallback(fileName: string): string {
  return (
    fileName
      // Decompose, then drop the combining marks: `Zoë` becomes `Zoe` rather
      // than `Zo?`, which is a name someone can still recognise.
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      // A quote or a backslash would end the quoted string early; anything
      // outside printable ASCII — control characters included — would either
      // split the header or arrive as mojibake. Spaces are kept: the quotes
      // are what make them legal, and stripping them would run the words of a
      // job title together.
      .replace(/["\\]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .trim() || 'resume'
  );
}

export function contentDisposition(
  type: 'attachment' | 'inline',
  fileName: string,
): string {
  // `encodeURIComponent` leaves `!'()*` alone, which RFC 5987 does not allow in
  // the encoded form, so those are escaped after it.
  const encoded = encodeURIComponent(fileName).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${type}; filename="${asciiFallback(fileName)}"; filename*=UTF-8''${encoded}`;
}
