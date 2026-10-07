/**
 * Tray icon factory (spec §4.3 "Tray icon with the online count and quick
 * actions"). Kept dependency-free of the real `electron` module so it can be
 * unit-tested with a fake Tray/Menu: the caller (main process bootstrap)
 * injects the real `Tray`/`Menu` constructors and an icon.
 *
 * Labels are sourced from the same renderer i18n JSON (`tray.*` keys in
 * en.json / vi.json) so tray copy never drifts from the in-app strings,
 * without pulling react-i18next into the main process.
 */
import en from '../renderer/i18n/en.json';
import vi from '../renderer/i18n/vi.json';

export type TrayLanguage = 'en' | 'vi';

const DICTS: Record<TrayLanguage, typeof en.tray> = { en: en.tray, vi: vi.tray };

export interface TrayLabels {
  show: string;
  stopAll: string;
  quit: string;
}

export function trayLabels(language: TrayLanguage = 'en'): TrayLabels {
  const dict = DICTS[language] ?? DICTS.en;
  return { show: dict.show, stopAll: dict.stopAll, quit: dict.quit };
}

function pluralForm(count: number): 'zero' | 'one' | 'other' {
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  return 'other';
}

/** "{count} ports online" (en) / "{count} cổng đang bật" (vi), pulled from tray.onlineCount_*. */
export function onlineCountLabel(language: TrayLanguage, count: number): string {
  const dict = DICTS[language] ?? DICTS.en;
  const key = `onlineCount_${pluralForm(count)}` as keyof typeof dict;
  const template = dict[key] ?? dict.onlineCount_other;
  return template.replace('{{count}}', String(count));
}

// ───────────────────────── tray factory ─────────────────────────

/** Minimal shape we need from an Electron `Tray` instance. */
export interface TrayLike {
  setToolTip?(text: string): void;
  setContextMenu(menu: unknown): void;
  destroy?(): void;
}

export interface MenuItemSpec {
  label?: string;
  type?: 'separator';
  enabled?: boolean;
  click?: () => void;
}

/** Minimal shape we need from the Electron `Menu` namespace. */
export interface MenuLike {
  buildFromTemplate(template: MenuItemSpec[]): unknown;
}

export interface CreateTrayOptions {
  /** The real `electron.Tray` constructor, or a fake for tests. */
  Tray: new (icon: unknown) => TrayLike;
  /** The real `electron.Menu`, or a fake for tests. */
  Menu: MenuLike;
  /** Icon passed straight through to `new Tray(icon)` (a path or a NativeImage). */
  icon: unknown;
  initialOnlineCount: number;
  labels: TrayLabels;
  /** e.g. `(count) => onlineCountLabel('en', count)`. Kept injectable so tests don't need the JSON dicts. */
  formatOnlineCount: (count: number) => string;
  onShow: () => void;
  onStopAll: () => void;
  onQuit: () => void;
}

export interface TrayHandle {
  /** The underlying Tray instance, exposed for callers that need it (e.g. to re-set the icon). */
  tray: TrayLike;
  setOnlineCount(count: number): void;
  destroy(): void;
}

function buildTemplate(opts: CreateTrayOptions, onlineLabel: string): MenuItemSpec[] {
  return [
    { label: onlineLabel, enabled: false },
    { type: 'separator' },
    { label: opts.labels.show, click: opts.onShow },
    { label: opts.labels.stopAll, click: opts.onStopAll },
    { type: 'separator' },
    { label: opts.labels.quit, click: opts.onQuit },
  ];
}

/**
 * Build a tray icon showing the current online-port count as its tooltip
 * and as the first (disabled, informational) menu item, plus three actions:
 * show the window, stop all ports, and quit.
 */
export function createTray(opts: CreateTrayOptions): TrayHandle {
  const tray = new opts.Tray(opts.icon);

  function render(count: number): void {
    const label = opts.formatOnlineCount(count);
    tray.setToolTip?.(label);
    tray.setContextMenu(opts.Menu.buildFromTemplate(buildTemplate(opts, label)));
  }

  render(opts.initialOnlineCount);

  return {
    tray,
    setOnlineCount(count: number) {
      render(count);
    },
    destroy() {
      tray.destroy?.();
    },
  };
}
