import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs vitest against the main-process build', () => {
    expect(1 + 1).toBe(2);
  });
});
