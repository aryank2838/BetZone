import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGAL_PLACEHOLDER, legalPlaceholderError } from './legalGuard';

function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'legal-guard-'));
  writeFileSync(join(root, 'legal.tsx'), text);
  return root;
}

describe('legal placeholder build guard', () => {
  it('fails production builds while placeholder text remains', () => {
    const root = fixture(`Company: ${LEGAL_PLACEHOLDER}. Address: ${LEGAL_PLACEHOLDER}.`);
    expect(legalPlaceholderError('production', {}, root, ['legal.tsx'])).toMatch(/legal\.tsx \(2\).*ALLOW_PLACEHOLDER_LEGAL=1/);
  });

  it('allows an explicit staging opt-out and non-production modes', () => {
    const root = fixture(`Company: ${LEGAL_PLACEHOLDER}`);
    expect(legalPlaceholderError('production', { ALLOW_PLACEHOLDER_LEGAL: '1' }, root, ['legal.tsx'])).toBeNull();
    expect(legalPlaceholderError('production', { ALLOW_PLACEHOLDER_LEGAL: 'true' }, root, ['legal.tsx'])).not.toBeNull();
    expect(legalPlaceholderError('development', {}, root, ['legal.tsx'])).toBeNull();
  });

  it('passes once the legal text is real', () => {
    const root = fixture('Company: BetZone Gaming Pvt Ltd.');
    expect(legalPlaceholderError('production', {}, root, ['legal.tsx'])).toBeNull();
  });
});
