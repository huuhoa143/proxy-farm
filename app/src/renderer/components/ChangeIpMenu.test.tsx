import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangeIpMenu } from './ChangeIpMenu';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import type { PortRow } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

async function setup(props: { disabled?: boolean; busy?: boolean } = {}) {
  const api = createFakeProxyFarmApi();
  const rows = await api.listPorts();
  const row = rows.find((r) => r.key === 'hma:JP-TOKYO#1') as PortRow;
  const onChange = vi.fn();
  render(<ChangeIpMenu row={row} api={api} rows={rows} onChange={onChange} {...props} />);
  const trigger = screen.getByTestId('change-ip-hma:JP-TOKYO#1');
  return { api, row, onChange, trigger };
}

async function openMenu(trigger: HTMLElement) {
  fireEvent.click(trigger);
  const menu = await screen.findByRole('menu');
  // Wait for the pool to load.
  await screen.findByTestId('server-203.0.113.15');
  return menu;
}

describe('ChangeIpMenu', () => {
  it('is a labelled menu button', async () => {
    const { trigger } = await setup();
    expect(trigger).toHaveAccessibleName('Change IP for port #1');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await openMenu(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it("asks for the pool with this port's key, so health is for the port's own account", async () => {
    const { api, trigger } = await setup();
    const spy = vi.spyOn(api, 'listServers');
    await openMenu(trigger);
    expect(spy).toHaveBeenCalledWith('hma:JP-TOKYO', 'hma:JP-TOKYO#1');
  });

  it("lists the location's servers with health and holder, marking the current one", async () => {
    const { trigger } = await setup();
    await openMenu(trigger);

    expect(screen.getByText('Servers in Tokyo')).toBeInTheDocument();
    const current = screen.getByTestId('server-203.0.113.10');
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(current).toHaveTextContent('This port');
    expect(current).toHaveAttribute('aria-disabled', 'true');

    const held = screen.getByTestId('server-203.0.113.11');
    expect(held).toHaveTextContent('Used by :29005');
    expect(held).toHaveAttribute('aria-disabled', 'true');
    expect(held).toHaveAttribute('title', expect.stringContaining('two ports never share an exit IP'));

    const refused = screen.getByTestId('server-203.0.113.13');
    expect(refused).toHaveTextContent('Refused');
    expect(refused).toHaveAttribute('aria-disabled', 'true');
    expect(refused).toHaveAccessibleDescription(expect.stringContaining('7 days'));

    const dead = screen.getByTestId('server-203.0.113.14');
    expect(dead).toHaveTextContent('Not responding');
    expect(dead).toHaveAttribute('aria-disabled', 'true');

    expect(screen.getByTestId('server-203.0.113.12')).toHaveTextContent('Free · Working');
    expect(screen.getByTestId('server-203.0.113.15')).toHaveTextContent('Free · Not tried yet');
    expect(screen.getByTestId('server-203.0.113.12')).not.toHaveAttribute('aria-disabled');
  });

  it('picking a free server calls onChange with it and closes the menu', async () => {
    const { trigger, row, onChange } = await setup();
    await openMenu(trigger);
    fireEvent.click(screen.getByTestId('server-203.0.113.15'));
    expect(onChange).toHaveBeenCalledWith(row, '203.0.113.15');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('"Next free server" calls onChange without a server', async () => {
    const { trigger, row, onChange } = await setup();
    await openMenu(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Next free server/ }));
    expect(onChange).toHaveBeenCalledWith(row, undefined);
  });

  it('the heading names the location as the table does (a localised country for a country-wide one)', async () => {
    const api = createFakeProxyFarmApi();
    const rows = await api.listPorts();
    const row = { ...(rows.find((r) => r.key === 'hma:JP-TOKYO#1') as PortRow), city: 'Japan' };
    render(<ChangeIpMenu row={row} api={api} rows={rows} onChange={() => {}} locationName="Nhật Bản" />);
    await openMenu(screen.getByTestId('change-ip-hma:JP-TOKYO#1'));
    expect(screen.getByText('Servers in Nhật Bản')).toBeInTheDocument();
    expect(screen.queryByText('Servers in Japan')).toBeNull();
  });

  describe('"Next free server" with nothing free here (spec §6.5 step 2)', () => {
    async function noneFree(sameCountryAlternative?: boolean) {
      const api = createFakeProxyFarmApi();
      const rows = await api.listPorts();
      const row = rows.find((r) => r.key === 'hma:JP-TOKYO#1') as PortRow;
      vi.spyOn(api, 'listServers').mockResolvedValue([
        { server: '203.0.113.10', health: 'ok', heldBy: 'hma:JP-TOKYO#1' },
        { server: '203.0.113.13', health: 'refused' },
      ]);
      render(<ChangeIpMenu row={row} api={api} rows={rows} onChange={() => {}} sameCountryAlternative={sameCountryAlternative} />);
      fireEvent.click(screen.getByTestId('change-ip-hma:JP-TOKYO#1'));
      await screen.findByTestId('server-203.0.113.13');
      return screen.getByRole('menuitem', { name: /Next free server/ });
    }

    it('promises another city of the same country only when the provider has one', async () => {
      expect(await noneFree(true)).toHaveTextContent('None free here — tries another city in the same country');
    });

    it('otherwise says the port keeps its server (ZoogVPN Japan is one location)', async () => {
      const next = await noneFree(false);
      expect(next).toHaveTextContent('no other location in this country — the port keeps its server');
      expect(next).not.toHaveTextContent('another city');
    });

    it('makes no promise when it is not told about other locations', async () => {
      expect(await noneFree()).not.toHaveTextContent('another city');
    });
  });

  it('tags a free-tier server (not to be confused with an unheld, "free" one)', async () => {
    const { api, trigger } = await setup();
    vi.spyOn(api, 'listServers').mockResolvedValue([
      { server: 'nl.zgfree.info', ip: '203.0.113.15', health: 'unknown', freeTier: true },
      { server: 'nl1.webunlim.com', ip: '203.0.113.16', health: 'unknown' },
    ]);
    fireEvent.click(trigger);
    const free = await screen.findByTestId('server-nl.zgfree.info');
    expect(free).toHaveTextContent('Free tier');
    expect(screen.getByText('Free tier')).toHaveAttribute('title', 'A free-tier server: it works on every plan.');
    expect(screen.getByTestId('server-nl1.webunlim.com')).not.toHaveTextContent('Free tier');
  });

  it('ignores clicks on held, refused or dead servers', async () => {
    const { trigger, onChange } = await setup();
    await openMenu(trigger);
    for (const ip of ['203.0.113.10', '203.0.113.11', '203.0.113.13', '203.0.113.14']) {
      fireEvent.click(screen.getByTestId(`server-${ip}`));
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('is keyboard navigable: arrows open and move, Home/End jump, Escape closes back to the button', async () => {
    const { trigger, onChange, row } = await setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    await screen.findByTestId('server-203.0.113.15');
    const next = screen.getByRole('menuitem', { name: /Next free server/ });
    expect(next).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByTestId('server-203.0.113.10')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByTestId('server-203.0.113.15')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(next).toHaveFocus(); // wraps
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByTestId('server-203.0.113.15')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(next).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    // Reopened from the keyboard, it still picks normally.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByTestId('server-203.0.113.12');
    fireEvent.click(screen.getByTestId('server-203.0.113.12'));
    expect(onChange).toHaveBeenCalledWith(row, '203.0.113.12');
  });

  it('closes on an outside click', async () => {
    const { trigger } = await setup();
    await openMenu(trigger);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('says so when the server list cannot load', async () => {
    const { api, trigger } = await setup();
    vi.spyOn(api, 'listServers').mockRejectedValueOnce(new Error('ipc'));
    fireEvent.click(trigger);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the server list.");
    // The default action still works without the list.
    expect(screen.getByRole('menuitem', { name: /Next free server/ })).toBeInTheDocument();
  });

  it('is disabled with a hint when the port cannot change IP', async () => {
    const { trigger } = await setup({ disabled: true });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', expect.stringContaining('to change its IP'));
  });

  it('shows progress while a change is in flight', async () => {
    const { trigger } = await setup({ busy: true });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent('Changing…');
  });
});
