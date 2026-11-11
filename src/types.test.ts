import { describe, expect, it } from 'vitest';
import { isValidPatti, isValidPattiCombo, pattiDigit } from '@/types';

describe('patti helpers', () => {
  it.each([
    ['123', true],
    ['000', true],
    ['120', true],
    ['321', false],
    ['12', false],
    ['12a', false],
    ['', false],
  ])('validates patti %s as %s', (patti, expected) => {
    expect(isValidPatti(patti)).toBe(expected);
  });

  it.each([
    ['123', 6],
    ['000', 0],
    ['789', 4],
  ])('calculates the digit for patti %s', (patti, expected) => {
    expect(pattiDigit(patti)).toBe(expected);
  });

  it.each([
    ['123-6', true],
    ['000-0', true],
    ['123-5', false],
    ['120-3', true],
    ['123-06', false],
    ['abc-6', false],
  ])('validates patti combo %s as %s', (combo, expected) => {
    expect(isValidPattiCombo(combo)).toBe(expected);
  });
});
