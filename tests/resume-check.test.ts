import { describe, expect, it } from 'vitest';
import { cleanIgnore, mentions, resumeProblems } from '../src/resume/resume-check.js';

const letter = (company: string, text: string) => ({
  company,
  greeting: 'Dear Hiring Manager,',
  paragraphs: [`${text} ${'I bring years of hands-on delivery experience across teams and systems. '.repeat(8)}`],
  closing: 'Sincerely,',
});

describe('Resume check: the company named in the letter', () => {
  it('finds short and "&" names', () => {
    expect(mentions('I am excited to join C1 as an architect.', 'C1')).toBe(true);
    expect(mentions('I am excited to join C10 as an architect.', 'C1')).toBe(false);
    expect(mentions('Working at RS&H would let me grow.', 'RS&H')).toBe(true);
    expect(mentions('K&L Gates has a strong marketing team.', 'K&L Gates')).toBe(true);
    expect(mentions('Nothing here.', 'K&L Gates')).toBe(false);
  });

  it('does not flag a letter that names a short company', () => {
    const reasons = resumeProblems('word '.repeat(200), {
      company: 'C1',
      person: null,
      files: [],
      letter: letter('C1', 'I am glad to apply to C1.'),
    });
    expect(reasons).toEqual([]);
  });
});

describe('Resume check: the ignore list', () => {
  const text = `${'word '.repeat(200)}\nSenior Engineer [Remote]\nGrew revenue by X%`;
  const base = { company: 'Zeta', person: null, files: [], letter: letter('Zeta', 'Hello there.') };

  it('drops placeholders and reasons with an ignored phrase', () => {
    const all = resumeProblems(text, base).join('\n');
    expect(all).toContain('[Remote]');
    expect(all).toContain('never names Zeta');

    const some = resumeProblems(text, { ...base, ignore: ['[remote]', 'never names'] }).join('\n');
    expect(some).not.toContain('[Remote]');
    expect(some).toContain('X%');
    expect(some).not.toContain('never names');
  });

  it('cleans the list', () => {
    expect(cleanIgnore([' C1 ', 'c1', '', 3, 'never names'])).toEqual(['C1', 'never names']);
  });
});
