import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { PortTable } from './PortTable';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
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

    it("+ Add port is disabled at the provider's port limit", () => {
      renderGrouped({ limits: { hma: 2 } });
      const blocked = screen.getByTestId('add-port-hma:JP-TOKYO');
      expect(blocked).toHaveAttribute('aria-disabled', 'true');
      expect(blocked).toHaveAttribute('title', 'HMA is at its limit of 2 ports — raise it in Settings.');
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
