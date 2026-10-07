/**
 * Power (spec §6.7): keep-awake while any port is on, suspend -> stop all, resume ->
 * staggered restart. Electron's `powerMonitor`/`powerSaveBlocker` are injected so tests
 * use fakes (real main-process code passes `electron.powerMonitor`/`electron.powerSaveBlocker`).
 */

export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';

export interface PowerSaveBlockerLike {
  start(type: PowerSaveBlockerType): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  off?(event: 'suspend' | 'resume', listener: () => void): unknown;
}

export interface PowerManagerDeps {
  powerMonitor: PowerMonitorLike;
  powerSaveBlocker: PowerSaveBlockerLike;
  /** True while settings.keepAwake is on (checked whenever the blocker would start). */
  isKeepAwakeEnabled(): boolean;
  /** True when at least one port is enabled right now. */
  hasEnabledPorts(): boolean;
  /** The port keys to restart on resume, staggered (spec §6.4/§6.7). */
  listEnabledPortKeys(): string[];
  /** Stop every running port (called on suspend, and internally before restart). */
  stopAllPorts(): Promise<void>;
  /**
   * Hand a port's restart to the staggered start queue (spec §6.4: <= 3 concurrent,
   * 2-5s apart) — e.g. `(key) => startQueue.enqueue(key, () => portManager.startPort(key))`.
   * Power deliberately does not re-implement staggering; it only decides *that* a
   * restart is due (on resume) and *which* ports (the ones enabled before suspend).
   */
  enqueueStart(key: string): void;
}

export interface PowerManager {
  /** Call whenever a port is enabled/disabled, or keepAwake is toggled, to
   * start/stop the blocker as appropriate. */
  refreshKeepAwake(): void;
  dispose(): void;
}

/**
 * Wires `powerMonitor` suspend/resume to the controller and keeps a
 * `prevent-app-suspension` blocker active exactly while it should be (any port on,
 * and the setting is enabled).
 */
export function installPowerHooks(deps: PowerManagerDeps): PowerManager {
  let blockerId: number | undefined;

  function refreshKeepAwake(): void {
    const shouldBlock = deps.isKeepAwakeEnabled() && deps.hasEnabledPorts();
    const isBlocking = blockerId !== undefined && deps.powerSaveBlocker.isStarted(blockerId);
    if (shouldBlock && !isBlocking) {
      blockerId = deps.powerSaveBlocker.start('prevent-app-suspension');
    } else if (!shouldBlock && isBlocking) {
      deps.powerSaveBlocker.stop(blockerId!);
      blockerId = undefined;
    }
  }

  async function onSuspend(): Promise<void> {
    await deps.stopAllPorts();
  }

  function onResume(): void {
    for (const key of deps.listEnabledPortKeys()) {
      deps.enqueueStart(key);
    }
    refreshKeepAwake();
  }

  const suspendListener = () => void onSuspend();
  const resumeListener = () => onResume();
  deps.powerMonitor.on('suspend', suspendListener);
  deps.powerMonitor.on('resume', resumeListener);

  return {
    refreshKeepAwake,
    dispose() {
      deps.powerMonitor.off?.('suspend', suspendListener);
      deps.powerMonitor.off?.('resume', resumeListener);
      if (blockerId !== undefined) {
        deps.powerSaveBlocker.stop(blockerId);
        blockerId = undefined;
      }
    },
  };
}
