import { describe, expect, it } from 'vitest';
import { companyKey, sameCompany, tidyCompanyName } from '../src/domain/company.js';

describe('companyKey', () => {
  it.each([
    ['Acme', 'Acme Inc.'],
    ['Acme', 'ACME, Inc'],
    ['Acme', 'The Acme Company'],
    ['Acme', 'Acme Corp.'],
    ['Acme', 'Acme, LLC'],
    ['Acme', 'Acme Ltd'],
    ["Domino's", 'Dominos'],
    ['Placer.ai', 'Placer ai'],
    ['Johnson & Johnson', 'Johnson and Johnson'],
    ['Nestlé', 'nestle'],
    ['Southern New Hampshire University', 'southern new hampshire university'],
  ])('treats "%s" and "%s" as one employer', (a, b) => {
    expect(sameCompany(a, b)).toBe(true);
  });

  it.each([
    ['Meta', 'Meta Platforms'],
    ['Meta', 'Metabase'],
    ['Acme', 'Acme Robotics'],
    ['Apple', 'Applied Materials'],
  ])('keeps "%s" and "%s" apart', (a, b) => {
    expect(sameCompany(a, b)).toBe(false);
  });

  it('never reduces a name to nothing', () => {
    expect(companyKey('Company')).toBe('company');
    expect(companyKey('Co')).toBe('co');
    expect(companyKey('The')).toBe('the');
    expect(companyKey('!!!')).toBe('!!!');
  });
});

describe('tidyCompanyName', () => {
  it.each([
    ['Acme, Inc.', 'Acme'],
    ['Acme Inc', 'Acme'],
    ['Acme Corp.', 'Acme'],
    ['Acme Holdings, LLC', 'Acme Holdings'],
    ['Hearst Corporation', 'Hearst'],
    ['The Walt Disney Company', 'The Walt Disney Company'],
    ['Inc.', 'Inc.'],
    ['  Vericast  ', 'Vericast'],
  ])('stores "%s" as "%s"', (input, expected) => {
    expect(tidyCompanyName(input)).toBe(expected);
  });
});
