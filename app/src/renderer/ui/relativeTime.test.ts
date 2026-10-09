import { describe, expect, it } from 'vitest';
import { relativeTime } from './relativeTime';

describe('relativeTime', () => {
  const now = 1_000_000_000;
  it('says now under a minute, then minutes, hours, days', () => {
    expect(relativeTime(now - 20_000, now, 'en')).toBe('now');
    expect(relativeTime(now - 3 * 60_000, now, 'en')).toBe('3 minutes ago');
    expect(relativeTime(now - 2 * 3_600_000, now, 'en')).toBe('2 hours ago');
    expect(relativeTime(now - 3 * 86_400_000, now, 'en')).toBe('3 days ago');
  });

  it('speaks Vietnamese', () => {
    expect(relativeTime(now - 3 * 60_000, now, 'vi')).toBe('3 phút trước');
  });
});
