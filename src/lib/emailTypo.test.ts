import { describe, expect, it } from 'vitest';
import { editDistance, suggestEmail } from './emailTypo';

describe('suggestEmail', () => {
  it('fixes common typos in popular domains', () => {
    expect(suggestEmail('ravi@gmial.com')).toBe('ravi@gmail.com');
    expect(suggestEmail('ravi@gmail.co')).toBe('ravi@gmail.com');
    expect(suggestEmail('ravi@gmail.con')).toBe('ravi@gmail.com');
    expect(suggestEmail('ravi@gmal.co')).toBe('ravi@gmail.com');
    expect(suggestEmail('ravi@gamil.com')).toBe('ravi@gmail.com');
    expect(suggestEmail('ravi@yaho.com')).toBe('ravi@yahoo.com');
    expect(suggestEmail('ravi@hotmial.com')).toBe('ravi@hotmail.com');
    expect(suggestEmail('ravi@outlok.com')).toBe('ravi@outlook.com');
    expect(suggestEmail('ravi@rediffmial.com')).toBe('ravi@rediffmail.com');
    expect(suggestEmail(' Ravi.K@GMAIL.CM ')).toBe('Ravi.K@gmail.com');
  });

  it('leaves correct and other real domains alone', () => {
    for (const email of [
      'ravi@gmail.com', 'ravi@yahoo.co.in', 'ravi@yahoo.in', 'ravi@mail.com', 'ravi@email.com',
      'ravi@ymail.com', 'ravi@gmx.com', 'ravi@aol.com', 'ravi@me.com', 'ravi@live.in',
      'ravi@mycompany.in', 'ravi@college.edu.in',
    ]) {
      expect(suggestEmail(email)).toBeNull();
    }
  });

  it('ignores unfinished addresses', () => {
    expect(suggestEmail('ravi')).toBeNull();
    expect(suggestEmail('ravi@')).toBeNull();
    expect(suggestEmail('ravi@gmail')).toBeNull();
    expect(suggestEmail('@gmail.co')).toBeNull();
  });

  it('counts a swap of two letters as one edit', () => {
    expect(editDistance('gmial.com', 'gmail.com')).toBe(1);
    expect(editDistance('gmail.com', 'gmail.com')).toBe(0);
  });
});
