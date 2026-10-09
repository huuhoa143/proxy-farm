import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { PortTable } from './PortTable';
import { createFakeProxyFarmApi } from '../api';
import { changeLanguage, initI18n } from '../i18n';
import type { PortRow, PortState, ProxyFarmApi, Target } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

function row(key: string, state: PortState, overrides: Partial<PortRow> = {}): PortRow {
  return {
    key,
    locationKey: key,
    providerId: 'hma',
    accountId: 'hma-1',
    label: `Location ${key}`,
    country: 'JP',
    city: 'Tokyo',
    proxyPort: 29001,
    enabled: state.kind !== 'stopped',
    state,
    autoRotateMin: 0,
    ...overrides,
  };
}

const noop = () => {};

describe('PortTable', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function defaultApi(): ProxyFarmApi {
    return createFakeProxyFarmApi();
  }

  it('renders every PortState variant with its label and affordances', () => {
    const now = Date.now();
    const rows: PortRow[] = [
      row('queued', { kind: 'queued' }),
      row('connecting', { kind: 'connecting', since: now }),
      row('verifying', { kind: 'verifying', since: now }),
      row('online', { kind: 'online', since: now, exitIp: '203.0.113.5', country: 'JP', latencyMs: 40 }),
      row('retrying', { kind: 'retrying', untilMs: now + 10_000, attempt: 1, reasonKey: 'portState.failed.no-server.guidance' }),
      // Different account from the online row so this reads as genuine bad creds
      // (no working peer) → the generic "check your sign-in" guidance, not the
      // location-specific one (that case is covered in portStateView.test.ts).
      row('failed-auth', { kind: 'failed', reason: 'auth', untilMs: now + 1000, attempt: 2 }, { providerId: 'hma', accountId: 'hma-2' }),
      row('failed-port', { kind: 'failed', reason: 'port-in-use', untilMs: now + 1000, attempt: 1 }),
      row('stopped', { kind: 'stopped' }),
    ];

    render(
      <PortTable
        rows={rows}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        onMovePort={noop}
        api={defaultApi()}
      />,
    );

    expect(screen.getByTestId('port-row-queued')).toHaveTextContent('Queued');
    expect(screen.getByTestId('port-row-connecting')).toHaveTextContent('Connecting…');
    expect(screen.getByTestId('port-row-verifying')).toHaveTextContent('Verifying…');
    expect(screen.getByTestId('port-row-online')).toHaveTextContent('Online');
    expect(screen.getByTestId('port-row-online')).toHaveTextContent('203.0.113.5');
    expect(screen.getByTestId('port-row-retrying')).toHaveTextContent(/Retrying in \d+s/);
    expect(screen.getByTestId('port-row-failed-auth')).toHaveTextContent('Sign-in rejected');
    expect(screen.getByTestId('guidance-failed-auth')).toHaveTextContent(
      "HMA rejected the device credentials — open the HMA app and check you're signed in.",
    );
    expect(screen.getByTestId('port-row-failed-port')).toHaveTextContent('Port in use');
    expect(screen.getByTestId('guidance-failed-port')).toHaveTextContent('Move to another port');
    expect(screen.getByTestId('port-row-stopped')).toHaveTextContent('Stopped');

    // Rotate is only actionable for an online port.
    const onlineRotate = screen.getByTestId('port-row-online').querySelector('button[disabled]');
    expect(onlineRotate).toBeNull();
    const stoppedRotateBtn = screen.getByTestId('port-row-stopped').querySelector('button:disabled');
    expect(stoppedRotateBtn).not.toBeNull();
  });

  it('calls onCopy, and onRotate from the Change IP menu', async () => {
    const onCopy = vi.fn();
    const onRotate = vi.fn();
    const online = row('online', { kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' });

    render(
      <PortTable
        rows={[online]}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={onCopy}
        onRotate={onRotate}
        api={defaultApi()}
      />,
    );

    fireEvent.click(screen.getByText('Copy'));
    expect(onCopy).toHaveBeenCalledWith(online);
    fireEvent.click(screen.getByText('Change IP'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Next free server/ }));
    expect(onRotate).toHaveBeenCalledWith(online, undefined);
  });

  it('toggles row selection via the checkbox', () => {
    const onToggleSelect = vi.fn();
    const online = row('online', { kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' });
    render(
      <PortTable
        rows={[online]}
        selectedKeys={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={defaultApi()}
      />,
    );
    fireEvent.click(screen.getByLabelText(online.label));
    expect(onToggleSelect).toHaveBeenCalledWith('online');
  });

  it('shows a rotate-result note under the row when provided', () => {
    const online = row('online', { kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' });
    render(
      <PortTable
        rows={[online]}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={defaultApi()}
        notes={{ online: 'Exit IP changed: 1.2.3.4 → 5.6.7.8' }}
      />,
    );
    const note = screen.getByTestId('rotate-note-online');
    expect(note).toHaveTextContent('Exit IP changed: 1.2.3.4 → 5.6.7.8');
    expect(note).toHaveAttribute('title', 'Exit IP changed: 1.2.3.4 → 5.6.7.8');
    // Its own full-width row right under the port's row — not inside the Status cell,
    // where a long "a → b" wrapped and widened the column.
    const portRow = screen.getByTestId('port-row-online');
    expect(portRow).not.toContainElement(note);
    const noteRow = screen.getByTestId('rotate-note-row-online');
    expect(portRow.nextElementSibling).toBe(noteRow);
    const cell = note.closest('td');
    expect(cell?.colSpan).toBe(portRow.querySelectorAll(':scope > td').length - 1);
  });

  it('renders no note row when there is no rotate-result note', () => {
    const online = row('online', { kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' });
    render(
      <PortTable
        rows={[online]}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={defaultApi()}
      />,
    );
    expect(screen.queryByTestId('rotate-note-row-online')).toBeNull();
  });

  describe("an exit is tagged with the location's country, not the IP database's guess", () => {
    const hanoi: Target = {
      key: 'nordvpn:VN-HANOI',
      providerId: 'nordvpn',
      country: 'VN',
      city: 'Hanoi',
      label: 'Vietnam — Hanoi',
      servers: ['192.0.2.1'],
      virtualLocation: true,
    };
    const vnRow = (country: string) =>
      row('nordvpn:VN-HANOI#1', { kind: 'online', since: 1, exitIp: '192.0.2.7', country }, {
        locationKey: 'nordvpn:VN-HANOI',
        providerId: 'nordvpn',
        accountId: 'nordvpn-1',
        country: 'VN',
        city: 'Hanoi',
      });
    const renderRows = (rows: PortRow[]) =>
      render(
        <PortTable rows={rows} selectedKeys={new Set()} onToggleSelect={noop} onToggleSelectAll={noop} onCopy={noop} onRotate={noop} api={defaultApi()} targets={[hanoi]} />,
      );

    it('a disagreeing geolocation is a hint beside the tag, explained in its tooltip', () => {
      renderRows([vnRow('BR')]);
      expect(screen.getByTestId('exit-cc-nordvpn:VN-HANOI#1')).toHaveTextContent('(VN)');
      const hint = screen.getByTestId('geo-hint-nordvpn:VN-HANOI#1');
      expect(hint).toHaveTextContent('IP geolocates to BR');
      expect(hint.getAttribute('title')).toMatch(/IP databases place 192\.0\.2\.7 in Brazil, not Vietnam.*virtual locations/);
    });

    it('no hint when the geolocation agrees', () => {
      renderRows([vnRow('VN')]);
      expect(screen.getByTestId('exit-cc-nordvpn:VN-HANOI#1')).toHaveTextContent('(VN)');
      expect(screen.queryByTestId('geo-hint-nordvpn:VN-HANOI#1')).toBeNull();
    });

    it('the group header marks a virtual location, and the drawer keeps the raw geolocation', async () => {
      renderRows([vnRow('HK')]);
      expect(screen.getByTestId('virtual-nordvpn:VN-HANOI')).toHaveTextContent('virtual location');
      fireEvent.click(screen.getByText('Details'));
      const facts = await screen.findByTestId('exit-facts-nordvpn:VN-HANOI#1');
      expect(facts).toHaveTextContent('192.0.2.7');
      expect(facts).toHaveTextContent('Vietnam (VN)');
      expect(facts).toHaveTextContent('Hong Kong SAR China (HK)');
    });

    it("a NordVPN exit's tooltip says it is fixed while connected and may change on reconnect; HMA's has none", () => {
      const hma = row('hma:JP-TOKYO#1', { kind: 'online', since: 1, exitIp: '203.0.113.5', country: 'JP' }, { server: '203.0.113.5' });
      renderRows([{ ...vnRow('VN'), server: '192.0.2.1' }, hma]);
      expect(screen.getByTestId('exit-ip-nordvpn:VN-HANOI#1').getAttribute('title')).toMatch(
        /^Exit IP of this connection\. NordVPN keeps it while the port stays connected; after a reconnect .* it may be a different one/,
      );
      expect(screen.getByTestId('exit-ip-hma:JP-TOKYO#1')).not.toHaveAttribute('title');
      expect(screen.getByTitle(/^Pinned to server 192\.0\.2\.1\. NordVPN picks the exit IP when the port connects/)).toBeInTheDocument();
      expect(screen.getByTitle('Pinned to server 203.0.113.5. This port keeps this exit IP until you change it.')).toBeInTheDocument();
    });

    it('in Vietnamese', async () => {
      await act(() => changeLanguage('vi'));
      try {
        renderRows([vnRow('HK')]);
        expect(screen.getByTestId('geo-hint-nordvpn:VN-HANOI#1')).toHaveTextContent('IP định vị ở HK');
        expect(screen.getByTestId('virtual-nordvpn:VN-HANOI')).toHaveTextContent('vị trí ảo');
      } finally {
        await act(() => changeLanguage('en'));
      }
    });
  });

  it('Details drawer fetches logs and Refresh re-fetches them', async () => {
    const online = row('online', { kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' });
    const api = defaultApi();
    render(
      <PortTable
        rows={[online]}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={api}
      />,
    );

    fireEvent.click(screen.getByText('Details'));
    await waitFor(() => expect(screen.getByTestId('logs-online')).toHaveTextContent('log line 1'));

    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByTestId('logs-online')).toHaveTextContent('log line 2'));
  });

  it('the Test button runs testPort and renders exit IP + latency', async () => {
    // Uses the fake api's own sample port (hma:JP-TOKYO, online) rather than
    // an ad-hoc PortRow, because testPort() looks the key up in the fake's
    // internal port map.
    const api = defaultApi();
    const online = (await api.listPorts()).find((p) => p.key === 'hma:JP-TOKYO#1')!;
    expect(online.state.kind).toBe('online');

    render(
      <PortTable
        rows={[online]}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={api}
      />,
    );

    const testId = `port-row-${online.key}`;
    const detailsId = `details-${online.key}`;
    const resultId = `test-result-${online.key}`;

    fireEvent.click(within(screen.getByTestId(testId)).getByText('Details'));
    await waitFor(() => expect(screen.getByTestId(detailsId)).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId(detailsId)).getByText('Test'));
    await waitFor(() => expect(screen.getByTestId(resultId)).toHaveTextContent('203.0.113.10'));
    expect(screen.getByTestId(resultId)).toHaveTextContent('42 ms');
  });

  it('shows an action-needed line (not a retry countdown) for a terminal auth failure', () => {
    const now = Date.now();
    const rows: PortRow[] = [
      row('failed-auth', { kind: 'failed', reason: 'auth', untilMs: now + 60_000, attempt: 4 }),
      row('failed-noserver', { kind: 'failed', reason: 'no-server', untilMs: now + 60_000, attempt: 2 }),
      row('failed-key', { kind: 'failed', reason: 'key-rejected', untilMs: now, attempt: 3 }),
    ];
    render(
      <PortTable
        rows={rows}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={defaultApi()}
      />,
    );
    const authRow = screen.getByTestId('port-row-failed-auth');
    expect(within(authRow).getByTestId('terminal-failed-auth')).toBeInTheDocument();
    expect(authRow).not.toHaveTextContent('Next try in');
    // A WireGuard key the app stopped retrying is action-needed too.
    const keyRow = screen.getByTestId('port-row-failed-key');
    expect(within(keyRow).getByTestId('terminal-failed-key')).toBeInTheDocument();
    expect(keyRow).not.toHaveTextContent('Next try in');
    // A transient failure still counts down to its next attempt.
    expect(screen.getByTestId('port-row-failed-noserver')).toHaveTextContent('Next try in');
  });

  it('renders per-row Stop and Remove that call the handlers (Stop disabled when stopped)', () => {
    const onStop = vi.fn();
    const onRemove = vi.fn();
    const rows: PortRow[] = [
      row('online', { kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' }),
      row('stopped', { kind: 'stopped' }),
    ];
    render(
      <PortTable
        rows={rows}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        onStop={onStop}
        onRemove={onRemove}
        api={defaultApi()}
      />,
    );
    const onlineRow = screen.getByTestId('port-row-online');
    fireEvent.click(within(onlineRow).getByText('Stop'));
    expect(onStop).toHaveBeenCalledWith(rows[0]);
    fireEvent.click(within(onlineRow).getByText('Remove'));
    expect(onRemove).toHaveBeenCalledWith(rows[0]);

    // Stop is disabled on an already-stopped port.
    const stoppedRow = screen.getByTestId('port-row-stopped');
    const stopBtn = within(stoppedRow).getByText('Stop').closest('button');
    expect(stopBtn).toBeDisabled();
  });

  it('ticks the retrying countdown every second', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const retrying = row('retrying', {
      kind: 'retrying',
      untilMs: now + 5000,
      attempt: 1,
      reasonKey: 'portState.failed.no-server.guidance',
    });
    render(
      <PortTable
        rows={[retrying]}
        selectedKeys={new Set()}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        onCopy={noop}
        onRotate={noop}
        api={defaultApi()}
      />,
    );
    expect(screen.getByTestId('port-row-retrying')).toHaveTextContent('Retrying in 5s');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('port-row-retrying')).toHaveTextContent('Retrying in 4s');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('port-row-retrying')).toHaveTextContent('Retrying in 2s');
  });

  describe('grouped by location (spec §4.1)', () => {
    const tokyo: Target = {
      key: 'hma:JP-TOKYO',
      providerId: 'hma',
      country: 'JP',
      city: 'Tokyo',
      label: 'Tokyo, Japan',
      servers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
      freeServers: 1,
    };
    const hanoi: Target = {
      key: 'zoogvpn:VN-HAN',
      providerId: 'zoogvpn',
      country: 'VN',
      city: 'Hanoi',
      label: 'Hanoi, Vietnam',
      servers: ['vn1.webunlim.com'],
      freeServers: 0,
    };
    const online = (ip: string): PortState => ({ kind: 'online', since: Date.now(), exitIp: ip, country: 'JP' });
    const rows: PortRow[] = [
      row('zoogvpn:VN-HAN#1', { kind: 'stopped' }, { locationKey: 'zoogvpn:VN-HAN', providerId: 'zoogvpn', country: 'VN', city: 'Hanoi', server: 'vn1.webunlim.com', serverIp: '198.51.100.20', proxyPort: 29003 }),
      row('hma:JP-TOKYO#2', online('10.0.0.2'), { locationKey: 'hma:JP-TOKYO', server: '10.0.0.2', serverIp: '10.0.0.2', proxyPort: 29002 }),
      row('hma:JP-TOKYO#1', { kind: 'connecting', since: Date.now() }, { locationKey: 'hma:JP-TOKYO', server: '10.0.0.1', serverIp: '10.0.0.1', proxyPort: 29001 }),
    ];

    function renderGrouped(overrides: Partial<Parameters<typeof PortTable>[0]> = {}) {
      return render(
        <PortTable
          rows={rows}
          targets={[tokyo, hanoi]}
          selectedKeys={new Set()}
          onToggleSelect={noop}
          onToggleSelectAll={noop}
          onCopy={noop}
          onRotate={noop}
          onAddPort={noop}
          api={defaultApi()}
          {...overrides}
        />,
      );
    }

    it('renders one header per location, sorted by country, ports sorted by number', () => {
      renderGrouped();
      const order = screen
        .getAllByTestId(/^(group-(?!stats)|port-row-)/)
        .map((el) => el.getAttribute('data-testid'));
      expect(order).toEqual([
        'group-hma:JP-TOKYO',
        'port-row-hma:JP-TOKYO#1',
        'port-row-hma:JP-TOKYO#2',
        'group-zoogvpn:VN-HAN',
        'port-row-zoogvpn:VN-HAN#1',
      ]);
    });

    it('header shows ports, online count and the server pool', () => {
      renderGrouped();
      expect(screen.getByTestId('group-stats-hma:JP-TOKYO')).toHaveTextContent('2 ports · 1 online');
      expect(screen.getByTestId('group-stats-hma:JP-TOKYO')).toHaveTextContent('3 servers · 1 free');
      expect(screen.getByTestId('group-stats-zoogvpn:VN-HAN')).toHaveTextContent('1 port · 0 online');
      expect(screen.getByTestId('group-stats-zoogvpn:VN-HAN')).toHaveTextContent('1 server · 0 free');
    });

    it('rows show #n and the pinned server IP', () => {
      renderGrouped();
      const r = screen.getByTestId('port-row-zoogvpn:VN-HAN#1');
      expect(r).toHaveTextContent('#1');
      expect(within(r).getByText('198.51.100.20')).toHaveAttribute('title', expect.stringContaining('vn1.webunlim.com'));
      expect(within(r).getByRole('checkbox')).toHaveAccessibleName('Hanoi · port #1');
    });

    it('+ Add port calls onAddPort, and is disabled with a reason when no server is free', () => {
      const onAddPort = vi.fn();
      renderGrouped({ onAddPort });
      fireEvent.click(screen.getByTestId('add-port-hma:JP-TOKYO'));
      expect(onAddPort).toHaveBeenCalledWith('hma:JP-TOKYO');

      const blocked = screen.getByTestId('add-port-zoogvpn:VN-HAN');
      expect(blocked).toHaveAttribute('aria-disabled', 'true');
      expect(blocked).toHaveAttribute('title', 'Every server in Hanoi is already in use or unavailable.');
      fireEvent.click(blocked);
      expect(onAddPort).toHaveBeenCalledTimes(1);
    });

    it('a country-wide location is headed by the localised country, once ("Đức", not "Germany Đức")', async () => {
      const germany: Target = { ...hanoi, key: 'zoogvpn:DE', country: 'DE', city: 'Germany', label: 'Germany', countryWide: true, servers: ['de3.webunlim.com'] };
      const de = row('zoogvpn:DE#1', { kind: 'online', since: Date.now(), exitIp: '185.1.1.1', country: 'DE' }, {
        locationKey: 'zoogvpn:DE', providerId: 'zoogvpn', country: 'DE', city: 'Germany', server: 'de3.webunlim.com', serverIp: '185.1.1.1', proxyPort: 29009,
      });
      await act(() => changeLanguage('vi'));
      try {
        renderGrouped({ rows: [de], targets: [germany] });
        const header = screen.getByTestId('group-zoogvpn:DE');
        expect(header).toHaveTextContent('Đức');
        expect(header).not.toHaveTextContent('Germany');
        expect(header.textContent!.match(/Đức/g)).toHaveLength(1);
        expect(within(screen.getByTestId('port-row-zoogvpn:DE#1')).getAllByRole('checkbox')[0]).toHaveAccessibleName('Đức · cổng #1');
        fireEvent.click(screen.getByTestId('change-ip-zoogvpn:DE#1'));
        expect(await screen.findByText('Máy chủ ở Đức')).toBeInTheDocument();
      } finally {
        await act(() => changeLanguage('en'));
      }
    });

    it("the Change IP menu learns whether the port's provider has another location in its country", async () => {
      const api = createFakeProxyFarmApi();
      const spy = vi.spyOn(api, 'listServers').mockResolvedValue([{ server: '10.0.0.1', health: 'ok', heldBy: 'hma:JP-TOKYO#2' }]);
      const osaka: Target = { ...tokyo, key: 'hma:JP-OSAKA', city: 'Osaka' };
      const surfsharkOsaka: Target = { ...osaka, key: 'surfshark:JP-OSA', providerId: 'surfshark' };
      const { unmount } = renderGrouped({ api, targets: [tokyo, hanoi, surfsharkOsaka] }); // another provider's city does not count
      fireEvent.click(screen.getByTestId('change-ip-hma:JP-TOKYO#2'));
      expect(await screen.findByRole('menuitem', { name: /Next free server/ })).toHaveTextContent('no other location in this country');
      unmount();
      renderGrouped({ api, targets: [tokyo, hanoi, osaka] });
      fireEvent.click(screen.getByTestId('change-ip-hma:JP-TOKYO#2'));
      expect(await screen.findByRole('menuitem', { name: /Next free server/ })).toHaveTextContent('tries another city in the same country');
      expect(spy).toHaveBeenCalled();
    });

    it('+ Add port says so when the location is not in the plan', () => {
      renderGrouped({ targets: [tokyo, { ...hanoi, notInPlan: true }] });
      const blocked = screen.getByTestId('add-port-zoogvpn:VN-HAN');
      expect(blocked).toHaveAttribute('aria-disabled', 'true');
      expect(blocked).toHaveAttribute('title', expect.stringContaining("Your ZoogVPN plan doesn't include this location"));
    });

    it('the group header says "Not in your plan" instead of a free-server count', () => {
      renderGrouped({ targets: [tokyo, { ...hanoi, freeServers: 0, notInPlan: true }] });
      const stats = screen.getByTestId('group-stats-zoogvpn:VN-HAN');
      expect(stats).toHaveTextContent('Not in your plan');
      expect(stats).not.toHaveTextContent('free');
      expect(screen.getByTestId('not-in-plan-zoogvpn:VN-HAN')).toHaveAttribute('title', expect.stringContaining("Your ZoogVPN plan doesn't include this location"));
      expect(screen.queryByTestId('not-in-plan-hma:JP-TOKYO')).toBeNull();
    });

    it("+ Add port is disabled at the provider's port limit", () => {
      renderGrouped({ limits: { hma: 2 } });
      const blocked = screen.getByTestId('add-port-hma:JP-TOKYO');
      expect(blocked).toHaveAttribute('aria-disabled', 'true');
      expect(blocked).toHaveAttribute('title', 'HMA is at its limit of 2 ports — raise it on the Providers screen.');
    });

    it('collapsing a group hides its ports and is remembered', () => {
      const { unmount } = renderGrouped();
      const toggle = within(screen.getByTestId('group-hma:JP-TOKYO')).getByRole('button', {
        name: 'Show or hide the ports in Tokyo',
      });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('port-row-hma:JP-TOKYO#1')).toBeNull();
      expect(screen.getByTestId('port-row-zoogvpn:VN-HAN#1')).toBeInTheDocument();

      unmount();
      renderGrouped();
      expect(screen.queryByTestId('port-row-hma:JP-TOKYO#1')).toBeNull();
    });

    it('the group checkbox selects every port of the group', () => {
      const onSelectGroup = vi.fn();
      renderGrouped({ onSelectGroup, selectedKeys: new Set(['hma:JP-TOKYO#1']) });
      const box = screen.getByLabelText('Select every port in Tokyo') as HTMLInputElement;
      expect(box.indeterminate).toBe(true);
      fireEvent.click(box);
      expect(onSelectGroup).toHaveBeenCalledWith(['hma:JP-TOKYO#1', 'hma:JP-TOKYO#2'], true);
    });

    it('Change IP is offered for online/failed ports but not while stopped or connecting', () => {
      renderGrouped();
      expect(screen.getByTestId('change-ip-hma:JP-TOKYO#2')).toBeEnabled();
      expect(screen.getByTestId('change-ip-hma:JP-TOKYO#1')).toBeDisabled();
      expect(screen.getByTestId('change-ip-zoogvpn:VN-HAN#1')).toBeDisabled();
    });
  });
});
