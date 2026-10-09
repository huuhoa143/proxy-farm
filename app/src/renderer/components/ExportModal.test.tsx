import { describe, expect, it, beforeAll, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { PortRow } from '../../shared/contracts';
import { ExportModal } from './ExportModal';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import type { CheckRecord } from '../portFilter';

const TOKYO_1 = 'hma:JP-TOKYO#1';
const TOKYO_2 = 'hma:JP-TOKYO#2';

beforeAll(() => {
  initI18n('en');
});

async function renderExport(checks: Record<string, CheckRecord> = {}) {
  const api = createFakeProxyFarmApi();
  const rows = await api.listPorts();
  render(<ExportModal api={api} targetKeys={rows.map((r) => r.key)} rows={rows} checks={checks} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('export-text')).not.toHaveValue(''));
  return { api, rows };
}

function sinceOf(rows: PortRow[], key: string): number {
  const state = rows.find((r) => r.key === key)!.state;
  return state.kind === 'online' ? state.since : -1;
}

describe('ExportModal', () => {
  it('exports only alive ports by default and says how many were left out', async () => {
    await renderExport();
    expect(screen.getByTestId('export-alive-only')).toBeChecked();
    // A long CSV row scrolls sideways instead of wrapping onto two lines.
    expect(screen.getByTestId('export-text')).toHaveAttribute('wrap', 'off');
    expect(screen.getByTestId('export-count')).toHaveTextContent('2 ports');
    expect(screen.getByTestId('export-left-out')).toHaveTextContent('3 ports that are not alive left out');
    expect(screen.getByTestId('export-text')).toHaveValue(
      '127.0.0.1:29001:proxyfarm:demo-pass-1234\n127.0.0.1:29005:proxyfarm:demo-pass-1234',
    );

    fireEvent.click(screen.getByTestId('export-alive-only'));
    expect(screen.getByTestId('export-count')).toHaveTextContent('5 ports');
    expect(screen.queryByTestId('export-left-out')).toBeNull();
    await waitFor(() => expect((screen.getByTestId('export-text') as HTMLTextAreaElement).value.split('\n')).toHaveLength(5));
  });

  it('a failed check makes a port not alive', async () => {
    const api = createFakeProxyFarmApi();
    const rows = await api.listPorts();
    const checks = { [TOKYO_2]: { ok: false, at: 1, since: sinceOf(rows, TOKYO_2) } };
    render(<ExportModal api={api} targetKeys={[TOKYO_1, TOKYO_2]} rows={rows} checks={checks} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('export-text')).toHaveValue('127.0.0.1:29001:proxyfarm:demo-pass-1234'));
    expect(screen.getByTestId('export-left-out')).toHaveTextContent('1 port that is not alive left out');
  });

  it('CSV passes the current check results to main', async () => {
    const api = createFakeProxyFarmApi();
    const rows = await api.listPorts();
    const exportSpy = vi.spyOn(api, 'exportPorts');
    const checks = { [TOKYO_1]: { ok: true, latencyMs: 61, at: 1, since: sinceOf(rows, TOKYO_1) } };
    render(<ExportModal api={api} targetKeys={[TOKYO_1]} rows={rows} checks={checks} onClose={() => {}} />);
    fireEvent.click(screen.getByText('CSV'));
    await waitFor(() =>
      expect(screen.getByTestId('export-text')).toHaveValue(
        // A textarea shows CRLF as LF; the text itself keeps CRLF (see the save test).
        'host,port,username,password,location,provider,exit_ip,country,status,latency_ms\n' +
          '127.0.0.1,29001,proxyfarm,demo-pass-1234,Tokyo,hma,203.0.113.10,JP,alive,61',
      ),
    );
    expect(exportSpy).toHaveBeenLastCalledWith([TOKYO_1], 'csv', { [TOKYO_1]: { ok: true, latencyMs: 61 } });
  });

  it('Copy all waits, like Save, until the text matches the current settings', async () => {
    const { api, rows } = await renderExport();
    expect(screen.getByTestId('export-copy')).toBeEnabled();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = api.exportPorts.bind(api);
    api.exportPorts = async (...args: Parameters<typeof api.exportPorts>) => (await gate, real(...args));
    fireEvent.click(screen.getByTestId('export-alive-only'));
    expect(screen.getByTestId('export-copy')).toBeDisabled();
    expect(screen.getByTestId('export-save')).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('export-copy')).toBeEnabled());
    expect((screen.getByTestId('export-text') as HTMLTextAreaElement).value.split('\n')).toHaveLength(rows.length);
  });

  it('Save to file writes the shown text and reports where', async () => {
    const { api } = await renderExport();
    const save = vi.spyOn(api, 'saveExportFile');
    fireEvent.click(screen.getByText('CSV'));
    await waitFor(() => expect((screen.getByTestId('export-text') as HTMLTextAreaElement).value).toMatch(/^host,port/));
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-save'));
    });
    const shown = (screen.getByTestId('export-text') as HTMLTextAreaElement).value;
    expect(save).toHaveBeenCalledWith(shown.replace(/\n/g, '\r\n'), 'csv');
    expect(screen.getByTestId('export-saved')).toHaveTextContent('Saved to /fake/proxy-farm.csv');
  });

  it('Save to file shows a failure inline, and nothing when cancelled', async () => {
    const { api } = await renderExport();
    const save = vi.spyOn(api, 'saveExportFile').mockResolvedValueOnce({ saved: false, error: 'EACCES: permission denied' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-save'));
    });
    expect(screen.getByTestId('export-save-error')).toHaveTextContent('Could not save the file: EACCES: permission denied');

    save.mockResolvedValueOnce({ saved: false });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-save'));
    });
    expect(screen.queryByTestId('export-save-error')).toBeNull();
    expect(screen.queryByTestId('export-saved')).toBeNull();
  });
});
