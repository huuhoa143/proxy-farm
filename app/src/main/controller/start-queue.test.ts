import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStartQueue } from './start-queue';

describe('start queue (spec §6.4/§6.7 staggered starts)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never runs more than maxConcurrent at once and spaces starts out', async () => {
    const q = createStartQueue({ random: () => 0.5 });
    let live = 0;
    let maxLive = 0;
    const startedAt: number[] = [];
    for (let i = 0; i < 10; i++) {
      q.enqueue(`k${i}`, async () => {
        live++;
        maxLive = Math.max(maxLive, live);
        startedAt.push(Date.now());
        await new Promise((r) => setTimeout(r, 20_000));
        live--;
      });
    }
    await vi.advanceTimersByTimeAsync(200_000);
    expect(startedAt).toHaveLength(10);
    expect(maxLive).toBe(3);
    expect(q.peak).toBe(3);
    for (let i = 1; i < startedAt.length; i++) {
      expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(2000);
    }
    // random() fixed at 0.5 => gap = 2000 + 0.5*(5000-2000) = 3500 exactly
    expect(startedAt[1] - startedAt[0]).toBe(3500);
  });

  it('dedups a key already queued (replaces its task) and supports cancel', async () => {
    const q = createStartQueue({ maxConcurrent: 1, random: () => 0 });
    const ran: string[] = [];
    const t = (label: string) => async () => {
      ran.push(label);
      await new Promise((r) => setTimeout(r, 1000));
    };
    q.enqueue('a', t('a'));
    q.enqueue('b', t('b'));
    q.enqueue('b', t('b2')); // replaces the pending 'b' task
    q.enqueue('c', t('c'));
    q.cancel('c');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ran).toEqual(['a', 'b2']);
  });

  it('isQueued is false once a task has started, true while still waiting', () => {
    const q = createStartQueue({ maxConcurrent: 1 });
    q.enqueue('a', async () => new Promise(() => {})); // starts immediately (nothing else running)
    q.enqueue('b', async () => new Promise(() => {})); // stays queued: 'a' holds the only slot
    expect(q.isQueued('a')).toBe(false);
    expect(q.isQueued('b')).toBe(true);
    q.cancel('b');
    expect(q.isQueued('b')).toBe(false);
  });

  it('clear() drops every still-pending task', async () => {
    const q = createStartQueue({ maxConcurrent: 1, random: () => 0 });
    const ran: string[] = [];
    q.enqueue('a', async () => {
      ran.push('a');
      await new Promise((r) => setTimeout(r, 1000));
    });
    q.enqueue('b', async () => {
      ran.push('b');
    });
    q.clear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ran).toEqual(['a']);
  });
});
