/**
 * The application menu (macOS menu bar / Windows window menu) and the About panel.
 * Pure builders, so the template can be tested without Electron: main-app passes the
 * result to `Menu.buildFromTemplate` and `app.setAboutPanelOptions`.
 *
 * Before this existed the app used Electron's default menu; the standard roles below
 * keep what that menu gave (Cmd+Q / Exit, Close Window, the Edit menu so copy/paste
 * and select-all work in text fields, zoom, full screen), with reload and DevTools
 * only in development. The Help menu replaces Electron's "Learn More" links with
 * this project's support pages.
 */
import type { AboutPanelOptionsOptions, MenuItemConstructorOptions } from 'electron';
import en from '../../renderer/i18n/en.json';
import vi from '../../renderer/i18n/vi.json';
import { LINKS } from '../../shared/links';
import type { MainLanguage } from './main-strings';

export type MenuLabels = typeof en.menu;

export function menuLabels(lang: MainLanguage): MenuLabels {
  return (lang === 'vi' ? vi : en).menu;
}

export const COPYRIGHT = '© 2026 Proxy Farm contributors';

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  /** Unpackaged (`electron-forge start`): adds Reload / Force Reload / DevTools. */
  isDev: boolean;
  appName: string;
  labels: MenuLabels;
  /** Opens a URL in the browser (main-app routes this through the link allowlist). */
  openLink(url: string): void;
  /** Shows the About panel (Windows/Linux; macOS uses the app menu's `about` role). */
  showAbout(): void;
}

/** The Help menu items, in order; also what the tests check against `LINKS`. */
export function helpMenuItems(o: AppMenuOptions): MenuItemConstructorOptions[] {
  const link = (label: string, url: string): MenuItemConstructorOptions => ({ label, click: () => o.openLink(url) });
  const l = o.labels;
  const items: MenuItemConstructorOptions[] = [
    link(l.getHelp, LINKS.discussions),
    link(l.reportBug, LINKS.newIssue),
    link(l.reportSecurity, LINKS.securityAdvisory),
    { type: 'separator' },
    link(l.privacy, LINKS.privacy),
    link(l.disclaimer, LINKS.disclaimer),
    link(l.thirdParty, LINKS.thirdPartyNotices),
    { type: 'separator' },
    link(l.source, LINKS.source),
    link(l.releaseNotes, LINKS.releases),
  ];
  if (o.platform !== 'darwin') items.push({ type: 'separator' }, { label: l.about.replace('{{name}}', o.appName), click: () => o.showAbout() });
  return items;
}

export function buildAppMenuTemplate(o: AppMenuOptions): MenuItemConstructorOptions[] {
  const l = o.labels;
  const mac = o.platform === 'darwin';
  const view: MenuItemConstructorOptions[] = [
    ...(o.isDev
      ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
      : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  return [
    // macOS app menu: About (uses setAboutPanelOptions), Services, Hide, Quit (Cmd+Q).
    ...(mac ? ([{ role: 'appMenu', label: o.appName }] as MenuItemConstructorOptions[]) : []),
    // Close Window on macOS, Exit on Windows.
    { role: 'fileMenu', label: l.file },
    { role: 'editMenu', label: l.edit },
    { label: l.view, submenu: view },
    { role: 'windowMenu', label: l.window },
    { role: 'help', label: l.help, submenu: helpMenuItems(o) },
  ];
}

export function aboutPanelOptions(appName: string, version: string): AboutPanelOptionsOptions {
  return {
    applicationName: appName,
    applicationVersion: version,
    copyright: COPYRIGHT,
    // `website` is shown on Linux only; macOS and Windows show `credits`.
    website: LINKS.source,
    credits: LINKS.source,
  };
}
