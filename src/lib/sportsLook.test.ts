import { describe, expect, it } from 'vitest';
import { teamColor, teamInitials } from './sportsLook';

describe('teamInitials', () => {
  it('uses two initials, or three letters for one-word names', () => {
    expect(teamInitials('Man City')).toBe('MC');
    expect(teamInitials('New Zealand')).toBe('NZ');
    expect(teamInitials('India')).toBe('IND');
    expect(teamInitials('Chelsea FC')).toBe('CHE');
  });
  it('skips words like Women', () => {
    expect(teamInitials('Sydney Sixers Women')).toBe('SS');
    expect(teamInitials('India Women')).toBe('IND');
  });
  it('never returns an empty badge', () => {
    expect(teamInitials('')).toBe('?');
  });
});

describe('teamColor', () => {
  it('is stable for the same team', () => {
    expect(teamColor('Man City')).toBe(teamColor('man city'));
    expect(teamColor('India')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
