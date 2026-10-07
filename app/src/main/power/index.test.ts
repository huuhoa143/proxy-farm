import { describe, expect, it, vi } from 'vitest';
import { installPowerHooks, type PowerManagerDeps, type PowerMonitorLike, type PowerSaveBlockerLike } from './index';

function fakePowerMonitor(): PowerMonitorLike & { emit(event: 'suspend' | 'resume'): void } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event) {
      for (const l of listeners.get(event) ?? []) l();
    },
  };
}

function fakeBlocker(): PowerSaveBlockerLike & { startCalls: number; stopCalls: number } {
  let nextId = 1;
  const started = new Set<number>();
  return {
    startCalls: 0,
    stopCalls: 0,
    start(_type) {
      this.startCalls++;
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      this.stopCalls++;
      return started.delete(id);
    },
    isStarted(id) {
      return started.has(id);
    },
  };
}

function makeDeps(overrides: Partial<PowerManagerDeps> = {}) {
  const powerMonitor = fakePowerMonitor();
  const powerSaveBlocker = fakeBlocker();
  const stopAllPorts = vi.fn(async () => undefined);
  const enqueueStart = vi.fn();
  let keepAwake = true;
  let enabledPorts: string[] = [];
  const deps: PowerManagerDeps = {
    powerMonitor,
    powerSaveBlocker,
    isKeepAwakeEnabled: () => keepAwake,
    hasEnabledPorts: () => enabledPorts.length > 0,
    listEnabledPortKeys: () => enabledPorts,
    stopAllPorts,
    enqueueStart,
    ...overrides,
  };
  return {
    deps,
    powerMonitor,
    powerSaveBlocker,
    stopAllPorts,
    enqueueStart,
    setKeepAwake: (v: boolean) => (keepAwake = v),
    setEnabledPorts: (v: string[]) => (enabledPorts = v),
  };
}

describe('power hooks (spec §6.7)', () => {
  it('starts the keep-awake blocker when enabled and a port is on', () => {
    const { deps, powerSaveBlocker, setEnabledPorts } = makeDeps();
    setEnabledPorts(['a']);
    const pm = installPowerHooks(deps);
    pm.refreshKeepAwake();
    expect(powerSaveBlocker.startCalls).toBe(1);
    pm.dispose();
  });

  it('does not start the blocker when keepAwake is off', () => {
    const { deps, powerSaveBlocker, setEnabledPorts, setKeepAwake } = makeDeps();
    setKeepAwake(false);
    setEnabledPorts(['a']);
    const pm = installPowerHooks(deps);
    pm.refreshKeepAwake();
    expect(powerSaveBlocker.startCalls).toBe(0);
    pm.dispose();
  });

  it('does not start the blocker when no port is enabled', () => {
    const { deps, powerSaveBlocker } = makeDeps();
    const pm = installPowerHooks(deps);
    pm.refreshKeepAwake();
    expect(powerSaveBlocker.startCalls).toBe(0);
    pm.dispose();
  });

  it('stops the blocker once it is no longer needed, and is idempotent', () => {
    const { deps, powerSaveBlocker, setEnabledPorts } = makeDeps();
    setEnabledPorts(['a']);
    const pm = installPowerHooks(deps);
    pm.refreshKeepAwake();
    expect(powerSaveBlocker.startCalls).toBe(1);
    pm.refreshKeepAwake(); // already started: must not start a second blocker
    expect(powerSaveBlocker.startCalls).toBe(1);
    setEnabledPorts([]);
    pm.refreshKeepAwake();
    expect(powerSaveBlocker.stopCalls).toBe(1);
    pm.refreshKeepAwake(); // already stopped: no-op
    expect(powerSaveBlocker.stopCalls).toBe(1);
    pm.dispose();
  });

  it('suspend stops all ports', () => {
    const { deps, powerMonitor, stopAllPorts } = makeDeps();
    const pm = installPowerHooks(deps);
    powerMonitor.emit('suspend');
    expect(stopAllPorts).toHaveBeenCalledTimes(1);
    pm.dispose();
  });

  it('resume hands every previously-enabled port to the staggered start queue', () => {
    const { deps, powerMonitor, enqueueStart, setEnabledPorts } = makeDeps();
    setEnabledPorts(['a', 'b', 'c']);
    const pm = installPowerHooks(deps);
    powerMonitor.emit('resume');
    expect(enqueueStart.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    pm.dispose();
  });

  it('resume also refreshes the keep-awake blocker', () => {
    const { deps, powerSaveBlocker, powerMonitor, setEnabledPorts } = makeDeps();
    const pm = installPowerHooks(deps);
    setEnabledPorts(['a']);
    powerMonitor.emit('resume');
    expect(powerSaveBlocker.startCalls).toBe(1);
    pm.dispose();
  });

  it('dispose removes the suspend/resume listeners and stops any active blocker', () => {
    const { deps, powerMonitor, stopAllPorts, powerSaveBlocker, setEnabledPorts } = makeDeps();
    setEnabledPorts(['a']);
    const pm = installPowerHooks(deps);
    pm.refreshKeepAwake();
    expect(powerSaveBlocker.startCalls).toBe(1);
    pm.dispose();
    expect(powerSaveBlocker.stopCalls).toBe(1);
    powerMonitor.emit('suspend');
    expect(stopAllPorts).not.toHaveBeenCalled();
  });
});
