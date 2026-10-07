import { describe, expect, it, vi } from 'vitest';
import { createTray, trayLabels, onlineCountLabel, type MenuItemSpec, type MenuLike, type TrayLike } from './tray';

class FakeTray implements TrayLike {
  tooltip = '';
  contextMenu: unknown;
  destroyed = false;
  constructor(public icon: unknown) {}
  setToolTip(text: string) {
    this.tooltip = text;
  }
  setContextMenu(menu: unknown) {
    this.contextMenu = menu;
  }
  destroy() {
    this.destroyed = true;
  }
}

function fakeMenu(): MenuLike & { lastTemplate: MenuItemSpec[] } {
  return {
    lastTemplate: [],
    buildFromTemplate(template: MenuItemSpec[]) {
      this.lastTemplate = template;
      return { __fakeMenu: template };
    },
  };
}

describe('trayLabels / onlineCountLabel', () => {
  it('pulls English labels from the shared i18n tray.* keys', () => {
    expect(trayLabels('en')).toEqual({ show: 'Show Proxy Farm', stopAll: 'Stop all ports', quit: 'Quit Proxy Farm' });
  });

  it('pulls Vietnamese labels from the shared i18n tray.* keys', () => {
    expect(trayLabels('vi')).toEqual({ show: 'Hiện Proxy Farm', stopAll: 'Tắt tất cả cổng', quit: 'Thoát Proxy Farm' });
  });

  it('formats the online count with the right plural form', () => {
    expect(onlineCountLabel('en', 0)).toBe('No ports online');
    expect(onlineCountLabel('en', 1)).toBe('1 port online');
    expect(onlineCountLabel('en', 5)).toBe('5 ports online');
    expect(onlineCountLabel('vi', 5)).toBe('5 cổng đang bật');
  });
});

describe('createTray', () => {
  function setup(initialOnlineCount = 3) {
    const Menu = fakeMenu();
    const onShow = vi.fn();
    const onStopAll = vi.fn();
    const onQuit = vi.fn();
    const handle = createTray({
      Tray: FakeTray,
      Menu,
      icon: 'icon.png',
      initialOnlineCount,
      labels: trayLabels('en'),
      formatOnlineCount: (count) => onlineCountLabel('en', count),
      onShow,
      onStopAll,
      onQuit,
    });
    return { Menu, onShow, onStopAll, onQuit, handle };
  }

  it('lists the expected items for N online: count, show, stop all, quit', () => {
    const { Menu } = setup(3);
    const labels = Menu.lastTemplate.map((item) => item.label);
    expect(labels).toEqual(['3 ports online', undefined, 'Show Proxy Farm', 'Stop all ports', undefined, 'Quit Proxy Farm']);
    expect(Menu.lastTemplate[0].enabled).toBe(false);
    expect(Menu.lastTemplate[1].type).toBe('separator');
  });

  it('sets the tooltip to the online-count label', () => {
    const { handle } = setup(2);
    expect((handle.tray as FakeTray).tooltip).toBe('2 ports online');
  });

  it('wires each menu action to its callback', () => {
    const { Menu, onShow, onStopAll, onQuit } = setup(1);
    Menu.lastTemplate.find((i) => i.label === 'Show Proxy Farm')?.click?.();
    Menu.lastTemplate.find((i) => i.label === 'Stop all ports')?.click?.();
    Menu.lastTemplate.find((i) => i.label === 'Quit Proxy Farm')?.click?.();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onStopAll).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('setOnlineCount(n) rebuilds the menu and tooltip with the new count', () => {
    const { Menu, handle } = setup(0);
    expect((handle.tray as FakeTray).tooltip).toBe('No ports online');
    handle.setOnlineCount(1);
    expect((handle.tray as FakeTray).tooltip).toBe('1 port online');
    expect(Menu.lastTemplate[0].label).toBe('1 port online');
  });

  it('destroy() tears down the underlying Tray', () => {
    const { handle } = setup(0);
    handle.destroy();
    expect((handle.tray as FakeTray).destroyed).toBe(true);
  });
});
