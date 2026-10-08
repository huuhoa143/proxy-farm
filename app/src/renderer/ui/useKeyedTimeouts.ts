import { useCallback, useEffect, useRef } from 'react';

/**
 * setTimeout keyed by a string: scheduling the same key again cancels the
 * pending one first, so a newer note is never cleared by an older timer.
 * Everything pending is cancelled on unmount.
 */
export function useKeyedTimeouts() {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const id of map.values()) clearTimeout(id);
      map.clear();
    };
  }, []);

  return useCallback((key: string, fn: () => void, ms: number) => {
    const map = timers.current;
    const previous = map.get(key);
    if (previous) clearTimeout(previous);
    map.set(
      key,
      setTimeout(() => {
        map.delete(key);
        fn();
      }, ms),
    );
  }, []);
}
