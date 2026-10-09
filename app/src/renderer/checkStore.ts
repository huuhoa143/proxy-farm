import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import type { PortRow, ProxyFarmApi } from '../shared/contracts';
import { stateSince, type CheckRecord } from './portFilter';
import { runQueue, type QueueRun } from './runQueue';

/** Check all: probes in flight at once. Each is one request through the port's own
 * tunnel, so a few in parallel keep a long list quick without a burst on the engines. */
export const CHECK_CONCURRENCY = 4;

export interface CheckSummary {
  alive: number;
  dead: number;
  skipped: number;
  deadKeys: string[];
}

export interface CheckState {
  /** Latest result per port key; `currentCheck` decides whether one still applies. */
  checks: Readonly<Record<string, CheckRecord>>;
  /** Set while a run is in progress. */
  progress: { done: number; total: number } | null;
  summary: CheckSummary | null;
}

/**
 * Check results and the running Check all, held for the whole app session (spec §4.1):
 * leaving the Ports screen and coming back keeps both. Memory only, never persisted.
 */
export interface CheckStore {
  getState(): CheckState;
  subscribe(listener: () => void): () => void;
  /**
   * Checks `rows` in the given order: `testPort(key, false)` on each online port,
   * CHECK_CONCURRENCY at a time; the others, and those Stop drops, count as skipped.
   * Each port is re-read (from the latest `prune`) when its turn comes and again after
   * the probe: one that went offline, vanished or reconnected meanwhile counts as skipped.
   * Ignored while a run is in progress. Resolves when the run ends.
   */
  run(api: Pick<ProxyFarmApi, 'testPort'>, rows: readonly PortRow[]): Promise<void>;
  /** Drops the queued checks; in-flight ones finish and are recorded. */
  stop(): void;
  dismissSummary(): void;
  /** Forgets results whose port is gone or whose state `since` changed (reconnect, Change IP, stop). */
  prune(ports: readonly PortRow[]): void;
}

export function createCheckStore(): CheckStore {
  let state: CheckState = { checks: {}, progress: null, summary: null };
  let current: QueueRun | null = null;
  /** The ports as last passed to `prune`; null until then (the run's own rows stand in). */
  let latest: Map<string, PortRow> | null = null;
  const listeners = new Set<() => void>();

  function set(patch: Partial<CheckState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async run(api, rows) {
      if (current) return;
      const online = rows.filter((r) => r.state.kind === 'online');
      const outcome = new Map<string, boolean>();
      set({ summary: null, progress: { done: 0, total: online.length } });
      const bump = () => set({ progress: state.progress && { ...state.progress, done: state.progress.done + 1 } });
      const run = runQueue(online, CHECK_CONCURRENCY, async (row) => {
        const now = (): PortRow | undefined => (latest ? latest.get(row.key) : row);
        const before = now();
        if (before?.state.kind !== 'online') {
          bump();
          return;
        }
        const since = before.state.since;
        let result: { ok: boolean; latencyMs?: number };
        try {
          result = await api.testPort(row.key, false);
        } catch {
          result = { ok: false };
        }
        const after = now();
        if (after === undefined || stateSince(after.state) !== since) {
          // Reconnected, moved or removed mid-probe: the result describes no current connection.
          bump();
          return;
        }
        outcome.set(row.key, result.ok);
        const check: CheckRecord = { ok: result.ok, at: Date.now(), since };
        if (result.ok && result.latencyMs !== undefined) check.latencyMs = result.latencyMs;
        set({ checks: { ...state.checks, [row.key]: check } });
        bump();
      });
      current = run;
      await run.done;
      current = null;
      const deadKeys = online.filter((r) => outcome.get(r.key) === false).map((r) => r.key);
      set({
        progress: null,
        summary: { alive: outcome.size - deadKeys.length, dead: deadKeys.length, skipped: rows.length - outcome.size, deadKeys },
      });
    },
    stop() {
      current?.cancel();
    },
    dismissSummary() {
      if (state.summary) set({ summary: null });
    },
    prune(ports) {
      const byKey = new Map(ports.map((p) => [p.key, p]));
      latest = byKey;
      const kept = Object.entries(state.checks).filter(([key, check]) => {
        const row = byKey.get(key);
        return row !== undefined && stateSince(row.state) === check.since;
      });
      if (kept.length !== Object.keys(state.checks).length) set({ checks: Object.fromEntries(kept) });
    },
  };
}

const CheckStoreContext = createContext<CheckStore | null>(null);

/** Provided once by `App`, above the screens, so results outlive a tab switch. */
export const CheckStoreProvider = CheckStoreContext.Provider;

/** The app's check store; a screen rendered on its own (tests) gets a private one. */
export function useCheckStore(): [CheckStore, CheckState] {
  const provided = useContext(CheckStoreContext);
  const [own] = useState(() => provided ?? createCheckStore());
  const store = provided ?? own;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return [store, state];
}
