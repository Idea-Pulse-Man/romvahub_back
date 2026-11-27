/**
 * The Resume Builder's file and folder names, shared by the maker
 * (`local/make-steps.ts`) and the Resume folder (`resume-store.ts`).
 */

const UNSAFE = /[\\/:*?"<>|#%]+/g;

/** "Latent AI", "AI Engineer" → "Latent_Ai_Ai_Engineer" — the Resume Builder's folder names. */
export function applicationFolderName(company: string, role: string): string {
  return (
    `${company} ${role}`
      .replace(UNSAFE, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('_')
      .replace(/[. ]+$/, '') || 'Application'
  );
}

/** "Jonathan", "Bai", "Latent AI" → "Jonathan_Bai_Latent_AI" — the Resume Builder's file stems. */
export function fileStem(...parts: string[]): string {
  return parts
    .join(' ')
    .replace(UNSAFE, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join('_')
    .replace(/[._]+$/, '');
}
