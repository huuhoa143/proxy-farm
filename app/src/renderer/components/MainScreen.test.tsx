import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MainScreen } from './MainScreen';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';

beforeAll(() => {
  initI18n('en');
  // jsdom has no clipboard API by default.
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
});

describe('MainScreen', () => {
  it('renders the sample ports and shows the host-VPN note only when active', async () => {
    const api = createFakeProxyFarmApi();
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());
    expect(screen.queryByTestId('host-vpn-note')).toBeNull();

    act(() => api.__setHostVpnActive(true));
    await waitFor(() => expect(screen.getByTestId('host-vpn-note')).toBeInTheDocument());
  });

  it('bulk-exports the selected ports through the export modal', async () => {
    const api = createFakeProxyFarmApi();
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    const row = screen.getByTestId('port-row-hma:JP-TOKYO');
    fireEvent.click(within(row).getByRole('checkbox'));

    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('1 ports selected');
    fireEvent.click(screen.getByText('Export'));

    await waitFor(() =>
      expect(screen.getByTestId('export-text')).toHaveValue('127.0.0.1:29001:proxyfarm:demo-pass-1234'),
    );

    fireEvent.click(screen.getByText('socks5://…'));
    await waitFor(() =>
      expect(screen.getByTestId('export-text')).toHaveValue('socks5://proxyfarm:demo-pass-1234@127.0.0.1:29001'),
    );
  });

  it('rotating an online port updates its exit IP', async () => {
    const api = createFakeProxyFarmApi();
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());
    const row = screen.getByTestId('port-row-hma:JP-TOKYO');
    expect(row).toHaveTextContent('203.0.113.10');
    fireEvent.click(within(row).getByText('Rotate IP'));
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toHaveTextContent('203.0.113.11'));
  });

  it('shows a rotate-result note: changed exit IP', async () => {
    const api = createFakeProxyFarmApi();
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Rotate IP'));
    await waitFor(() =>
      expect(screen.getByTestId('rotate-note-hma:JP-TOKYO')).toHaveTextContent(
        'Exit IP changed: 203.0.113.10 → 203.0.113.11',
      ),
    );
  });

  it('shows a rotate-result note: no other server available', async () => {
    const api = createFakeProxyFarmApi();
    await api.startPorts(['zoogvpn:NL-AMS']);
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-zoogvpn:NL-AMS')).toHaveTextContent('Online'));
    fireEvent.click(within(screen.getByTestId('port-row-zoogvpn:NL-AMS')).getByText('Rotate IP'));
    await waitFor(() =>
      expect(screen.getByTestId('rotate-note-zoogvpn:NL-AMS')).toHaveTextContent(
        'No other server is available for this location.',
      ),
    );
  });

  it('bulk rotate summarises changed / moved-to-another-city / unavailable', async () => {
    const api = createFakeProxyFarmApi();
    await api.startPorts(['hma:US-NYC', 'zoogvpn:NL-AMS']);
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    for (const key of ['hma:JP-TOKYO', 'hma:US-NYC', 'zoogvpn:NL-AMS']) {
      fireEvent.click(within(screen.getByTestId(`port-row-${key}`)).getByRole('checkbox'));
    }

    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Rotate IP'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-rotate-summary')).toHaveTextContent(
        '1 rotated, 1 moved to another city, 1 had no other server available',
      ),
    );
  });

  it('per-row copy copies the authenticated host:port:user:pass form', async () => {
    const api = createFakeProxyFarmApi();
    const exportSpy = vi.spyOn(api, 'exportPorts');
    const writeSpy = vi.spyOn(navigator.clipboard, 'writeText');
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Copy'));
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith('127.0.0.1:29001:proxyfarm:demo-pass-1234'));
    expect(exportSpy).toHaveBeenCalledWith(['hma:JP-TOKYO'], 'hostPortUserPass');
  });

  it('surfaces an error and opens Export as a manual fallback when the clipboard write rejects', async () => {
    const api = createFakeProxyFarmApi();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Copy'));
    await waitFor(() => expect(screen.getByTestId('copy-error-toast')).toBeInTheDocument());
    expect(screen.getByTestId('export-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('copied-toast')).toBeNull();
  });

  it('per-row Stop stops only that port', async () => {
    const api = createFakeProxyFarmApi();
    const stopSpy = vi.spyOn(api, 'stopPorts');
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Stop'));
    await waitFor(() => expect(stopSpy).toHaveBeenCalledWith(['hma:JP-TOKYO']));
  });

  it('per-row Remove confirms first, then removes that port', async () => {
    const api = createFakeProxyFarmApi();
    const removeSpy = vi.spyOn(api, 'removePorts');
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Remove'));
    expect(removeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(['hma:JP-TOKYO']));
  });

  it('bulk Remove asks for confirmation before removing', async () => {
    const api = createFakeProxyFarmApi();
    const removeSpy = vi.spyOn(api, 'removePorts');
    render(<MainScreen api={api} />);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByRole('checkbox'));
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Remove'));
    expect(removeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(['hma:JP-TOKYO']));
  });

  describe('note timeouts', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a second rotate restarts the note timer instead of being cleared by the first one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const api = createFakeProxyFarmApi();
      render(<MainScreen api={api} />);
      await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());

      fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Rotate IP'));
      await waitFor(() =>
        expect(screen.getByTestId('rotate-note-hma:JP-TOKYO')).toHaveTextContent('203.0.113.10 → 203.0.113.11'),
      );

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByText('Rotate IP'));
      await waitFor(() =>
        expect(screen.getByTestId('rotate-note-hma:JP-TOKYO')).toHaveTextContent('203.0.113.11 → 203.0.113.10'),
      );

      // 7 s after the first rotate, 3 s after the second: the first timer must
      // not have removed the second note.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId('rotate-note-hma:JP-TOKYO')).toHaveTextContent('203.0.113.11 → 203.0.113.10');

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByTestId('rotate-note-hma:JP-TOKYO')).toBeNull();
    });

    it('a second bulk rotate restarts the summary timer', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const api = createFakeProxyFarmApi();
      render(<MainScreen api={api} />);
      await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toBeInTheDocument());
      fireEvent.click(within(screen.getByTestId('port-row-hma:JP-TOKYO')).getByRole('checkbox'));

      fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Rotate IP'));
      await waitFor(() => expect(screen.getByTestId('bulk-rotate-summary')).toBeInTheDocument());
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Rotate IP'));
      // The summary is set in the same tick as the refreshed rows.
      await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO')).toHaveTextContent('203.0.113.10'));
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId('bulk-rotate-summary')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByTestId('bulk-rotate-summary')).toBeNull();
    });
  });
});
