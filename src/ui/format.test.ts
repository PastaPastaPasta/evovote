import { describe, expect, it } from 'vitest';
import { afterFirstSentence, dateText, excerpt, firstSentence, shortId } from './format';

describe('shortId', () => {
  it('should keep six characters each side by default', () => {
    expect(shortId('EFyPZPsEDLHtN1R38CgzeAGfWr23DrgthPpTgbCW8zAt')).toBe('EFyPZP…CW8zAt');
    expect(shortId('short')).toBe('short');
  });
});

describe('dateText', () => {
  const now = new Date(2026, 9, 20, 12, 0).getTime();
  it('should leave out the year for this year, and the time when asked', () => {
    const ms = new Date(2026, 9, 19, 16, 5).getTime();
    expect(dateText(ms, { now })).not.toMatch(/2026/);
    expect(dateText(ms, { now })).toMatch(/19/);
    expect(dateText(ms, { time: false, now })).not.toMatch(/:/);
  });
  it('should show the year for another year', () => {
    expect(dateText(new Date(2025, 0, 2).getTime(), { now })).toMatch(/2025/);
  });
});

describe('excerpt', () => {
  it('should cut at a word boundary', () => {
    expect(excerpt('We keep threads on topic and remove off-topic posts', 30)).toBe('We keep threads on topic and…');
    expect(excerpt('short text', 30)).toBe('short text');
  });
  it('should cut a single long word mid-word', () => {
    expect(excerpt('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`);
  });
});

describe('firstSentence', () => {
  it('should title free text by its first sentence or line', () => {
    expect(firstSentence('EvoVote v2 QA (alice): team A. We remove spam posts.')).toBe('EvoVote v2 QA (alice): team A');
    expect(firstSentence('Keep it civil\nMore text')).toBe('Keep it civil');
    expect(firstSentence('No full stop at all')).toBe('No full stop at all');
  });
});

describe('afterFirstSentence', () => {
  it('should give the rest of the text after the title sentence', () => {
    expect(afterFirstSentence('Team A. We remove spam.')).toBe('We remove spam.');
    expect(afterFirstSentence('Only one line')).toBe('');
  });
});
