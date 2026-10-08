import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { isAllowedExternalUrl, LINKS } from '../../shared/links';
import { aboutPanelOptions, buildAppMenuTemplate, COPYRIGHT, menuLabels, type AppMenuOptions } from './app-menu';

function options(overrides: Partial<AppMenuOptions> = {}): AppMenuOptions & { openLink: ReturnType<typeof vi.fn>; showAbout: ReturnType<typeof vi.fn> } {
  return {
    platform: 'darwin',
    isDev: false,
    appName: 'Proxy Farm',
    labels: menuLabels('en'),
    openLink: vi.fn(),
    showAbout: vi.fn(),
    ...overrides,
  } as AppMenuOptions & { openLink: ReturnType<typeof vi.fn>; showAbout: ReturnType<typeof vi.fn> };
}

const roles = (items: MenuItemConstructorOptions[]) => items.map((i) => i.role ?? i.label);
const help = (items: MenuItemConstructorOptions[]) => items.find((i) => i.role === 'help')!.submenu as MenuItemConstructorOptions[];
const view = (items: MenuItemConstructorOptions[]) => items.find((i) => i.label === 'View')!.submenu as MenuItemConstructorOptions[];
const click = (item: MenuItemConstructorOptions) => (item.click as unknown as () => void)();

describe('application menu template', () => {
  it('macOS: standard app menu first (About, Quit), then File, Edit, View, Window, Help', () => {
    const t = buildAppMenuTemplate(options());
    expect(roles(t)).toEqual(['appMenu', 'fileMenu', 'editMenu', 'View', 'windowMenu', 'help']);
    expect(t[0].label).toBe('Proxy Farm');
    // About lives in the app menu on macOS, not in Help.
    expect(help(t).some((i) => i.label?.startsWith('About'))).toBe(false);
  });

  it('Windows: no app menu, and About Proxy Farm at the end of Help', () => {
    const o = options({ platform: 'win32' });
    const t = buildAppMenuTemplate(o);
    expect(roles(t)).toEqual(['fileMenu', 'editMenu', 'View', 'windowMenu', 'help']);
    const about = help(t).at(-1)!;
    expect(about.label).toBe('About Proxy Farm');
    click(about);
    expect(o.showAbout).toHaveBeenCalledTimes(1);
  });

  it('keeps the Edit menu role so copy/paste/select-all shortcuts work in text fields', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(buildAppMenuTemplate(options({ platform })).some((i) => i.role === 'editMenu')).toBe(true);
    }
  });

  it('offers Reload and DevTools only in development', () => {
    expect(roles(view(buildAppMenuTemplate(options({ isDev: true }))))).toEqual(
      expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'togglefullscreen']),
    );
    const packaged = roles(view(buildAppMenuTemplate(options({ isDev: false }))));
    expect(packaged).not.toContain('reload');
    expect(packaged).not.toContain('toggleDevTools');
    expect(packaged).toContain('togglefullscreen');
  });

  it('Help links open the project pages, every one on the external-link allowlist', () => {
    const o = options();
    const items = help(buildAppMenuTemplate(o)).filter((i) => i.type !== 'separator');
    expect(items.map((i) => i.label)).toEqual([
      'Get Help',
      'Report a Bug',
      'Report a Security Issue',
      'Privacy Policy',
      'Disclaimer',
      'Third-Party Licenses',
      'Source Code',
      'Release Notes',
    ]);
    for (const item of items) click(item);
    const opened = o.openLink.mock.calls.map((c) => c[0]);
    expect(opened).toEqual([
      LINKS.discussions,
      LINKS.newIssue,
      LINKS.securityAdvisory,
      LINKS.privacy,
      LINKS.disclaimer,
      LINKS.thirdPartyNotices,
      LINKS.source,
      LINKS.releases,
    ]);
    for (const url of opened) expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it('is translated', () => {
    const t = buildAppMenuTemplate(options({ platform: 'win32', labels: menuLabels('vi') }));
    expect(t.find((i) => i.role === 'help')!.label).toBe('Trợ giúp');
    expect(help(t).at(-1)!.label).toBe('Giới thiệu Proxy Farm');
  });
});

describe('about panel', () => {
  it('names the app, its version, the contributors and the project website', () => {
    expect(aboutPanelOptions('Proxy Farm', '0.1.0')).toEqual({
      applicationName: 'Proxy Farm',
      applicationVersion: '0.1.0',
      copyright: '© 2026 Proxy Farm contributors',
      website: LINKS.source,
      credits: LINKS.source,
    });
    expect(COPYRIGHT).not.toMatch(/@/);
  });
});
