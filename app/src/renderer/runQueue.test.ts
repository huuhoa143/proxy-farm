import { describe, expect, it } from 'vitest';
import { runQueue } from './runQueue';

/** A promise the test resolves by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runQueue', () => {
  it('runs at most `concurrency` items at once, in order', async () => {
    const gates = Array.from({ length: 6 }, deferred);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const run = runQueue([0, 1, 2, 3, 4, 5], 4, async (i) => {
      started.push(i);
      running += 1;
      peak = Math.max(peak, running);
      await gates[i].promise;
      running -= 1;
    });
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    for (const g of gates) g.resolve();
    await run.done;
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(4);
  });

  it('cancel stops queued items, lets running ones finish', async () => {
    const gates = Array.from({ length: 10 }, deferred);
    const finished: number[] = [];
    const run = runQueue([...Array(10).keys()], 4, async (i) => {
      await gates[i].promise;
      finished.push(i);
    });
    await tick();
    run.cancel();
    for (const g of gates) g.resolve();
    await run.done;
    expect(finished.sort()).toEqual([0, 1, 2, 3]);
  });

  it('a throwing worker does not stall the queue', async () => {
    const seen: number[] = [];
    const run = runQueue([1, 2, 3], 1, async (i) => {
      seen.push(i);
      if (i === 1) throw new Error('boom');
    });
    await expect(run.done).resolves.toBeUndefined();
    expect(seen).toEqual([1, 2, 3]);
  });

  it('settles at once for no items', async () => {
    await expect(runQueue([], 4, async () => {}).done).resolves.toBeUndefined();
  });
});
