import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { PortTable } from './PortTable';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import type { PortRow, PortState, ProxyFarmApi } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

function row(key: string, state: PortState, overrides: Partial<PortRow> = {}): PortRow {
  return {
    key,
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
      row('failed-auth', { kind: 'failed', reason: 'auth', untilMs: now + 1000, attempt: 2 }, { providerId: 'hma' }),
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

  it('calls onCopy and onRotate when the corresponding buttons are clicked', () => {
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
    fireEvent.click(screen.getByText('Rotate IP'));
    expect(onRotate).toHaveBeenCalledWith(online);
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
    expect(screen.getByTestId('rotate-note-online')).toHaveTextContent('Exit IP changed: 1.2.3.4 → 5.6.7.8');
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
    const online = (await api.listPorts()).find((p) => p.key === 'hma:JP-TOKYO')!;
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
});
