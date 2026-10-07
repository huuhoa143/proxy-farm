import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PortTable } from './PortTable';
import { initI18n } from '../i18n';
import type { PortRow, PortState } from '../../shared/contracts';

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
      />,
    );
    fireEvent.click(screen.getByLabelText(online.label));
    expect(onToggleSelect).toHaveBeenCalledWith('online');
  });
});
