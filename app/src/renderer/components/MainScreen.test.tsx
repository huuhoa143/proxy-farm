import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MainScreen } from './MainScreen';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';

const TOKYO_1 = 'hma:JP-TOKYO#1';

beforeAll(() => {
  initI18n('en');
  // jsdom has no clipboard API by default.
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
});

beforeEach(() => {
  window.localStorage.clear();
});

async function renderMain(api = createFakeProxyFarmApi()) {
  render(<MainScreen api={api} />);
  await waitFor(() => expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toBeInTheDocument());
  return api;
}

// Queries here avoid document-wide *ByRole: on the full port table it computes
// the accessible name of every button, which took seconds per call under a
// loaded full-suite run and pushed these tests past vitest's 5 s timeout.
// Role queries stay, but scoped to a small subtree (the menu, a row).

/** The header's "Add locations" button. */
function addLocationsButton(): HTMLElement {
  return screen.getByText('Add locations', { selector: 'button' });
}

/** Open a row's Change IP menu and pick "Next free server", or a given server. */
async function changeIp(portKey: string, server?: string) {
  fireEvent.click(screen.getByTestId(`change-ip-${portKey}`));
  const menu = await screen.findByTestId('change-ip-menu');
  const item = server
    ? await within(menu).findByTestId(`server-${server}`)
    : within(menu).getByRole('menuitem', { name: /Next free server/ });
  // The change resolves asynchronously; let React flush it inside act().
  await act(async () => {
    fireEvent.click(item);
  });
}

describe('MainScreen', () => {
  it('renders the sample ports and shows the host-VPN note only when active', async () => {
    const api = await renderMain();
    expect(screen.queryByTestId('host-vpn-note')).toBeNull();

    act(() => api.__setHostVpnActive(true));
    await waitFor(() => expect(screen.getByTestId('host-vpn-note')).toBeInTheDocument());
  });

  it('groups ports by location with pool counts in the header', async () => {
    await renderMain();
    const stats = screen.getByTestId('group-stats-hma:JP-TOKYO');
    expect(stats).toHaveTextContent('2 ports · 2 online');
    await waitFor(() => expect(stats).toHaveTextContent('6 servers · 2 free'));
    // Both Tokyo ports sit under the Tokyo header, in port-number order.
    const order = screen.getAllByTestId(/^port-row-hma:JP-TOKYO/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([`port-row-${TOKYO_1}`, 'port-row-hma:JP-TOKYO#2']);
    // The stat rail counts locations, not ports.
    expect(within(screen.getByTestId('stat-rail')).getByText('Locations').nextSibling).toHaveTextContent('4');
  });

  it('+ Add port adds a port on a free server, then disables itself when none is left', async () => {
    const api = await renderMain();
    const addSpy = vi.spyOn(api, 'addPorts');
    const add = await screen.findByTestId('add-port-hma:JP-TOKYO');

    fireEvent.click(add);
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO#3')).toBeInTheDocument());
    expect(addSpy).toHaveBeenCalledWith('hma:JP-TOKYO', 1);
    expect(screen.getByTestId('port-row-hma:JP-TOKYO#3')).toHaveTextContent('203.0.113.12');

    fireEvent.click(screen.getByTestId('add-port-hma:JP-TOKYO'));
    await waitFor(() => expect(screen.getByTestId('port-row-hma:JP-TOKYO#4')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('add-port-hma:JP-TOKYO')).toHaveAttribute('aria-disabled', 'true'),
    );
    expect(screen.getByTestId('group-stats-hma:JP-TOKYO')).toHaveTextContent('0 free');
  });

  it('tells the user when fewer ports than asked could be added', async () => {
    const api = await renderMain();
    vi.spyOn(api, 'addPorts').mockResolvedValueOnce({ added: [], noteKey: 'limit-reached' });
    fireEvent.click(await screen.findByTestId('add-port-hma:JP-TOKYO'));
    expect(await screen.findByTestId('notice-toast')).toHaveTextContent(
      'Added 0 of 1 port in Tokyo — HMA reached its port limit.',
    );
  });

  it('pluralises the shortfall note by the number of ports asked for', async () => {
    const api = await renderMain();
    vi.spyOn(api, 'addPorts').mockResolvedValueOnce({ added: [], noteKey: 'no-free-server' });
    fireEvent.click(addLocationsButton());
    const picker = await screen.findByTestId('location-picker');
    const tokyo = within(picker).getByTestId('pick-hma:JP-TOKYO');
    fireEvent.click(within(tokyo).getByRole('checkbox'));
    fireEvent.click(within(tokyo).getByRole('button', { name: 'One more port in Tokyo' }));
    fireEvent.click(within(picker).getByTestId('picker-submit'));
    expect(await screen.findByTestId('notice-toast')).toHaveTextContent(
      'Added 0 of 2 ports in Tokyo — no more free servers there.',
    );
  });

  it('the location picker adds the chosen number of ports per location', async () => {
    const api = await renderMain();
    const addSpy = vi.spyOn(api, 'addPorts');
    fireEvent.click(addLocationsButton());
    const picker = await screen.findByTestId('location-picker');

    const tokyo = within(picker).getByTestId('pick-hma:JP-TOKYO');
    expect(tokyo).toHaveTextContent('6 servers · 2 free');
    expect(tokyo).toHaveTextContent('2 ports');
    fireEvent.click(within(tokyo).getByRole('checkbox'));
    fireEvent.click(within(tokyo).getByRole('button', { name: 'One more port in Tokyo' }));
    expect(within(tokyo).getByRole('spinbutton')).toHaveValue(2);

    fireEvent.click(within(picker).getByTestId('pick-hma:SG-SIN').querySelector('input[type=checkbox]')!);
    fireEvent.click(within(picker).getByTestId('picker-submit'));

    await waitFor(() => expect(screen.getByTestId('port-row-hma:SG-SIN#1')).toBeInTheDocument());
    expect(addSpy).toHaveBeenCalledWith('hma:JP-TOKYO', 2);
    expect(addSpy).toHaveBeenCalledWith('hma:SG-SIN', 1);
    expect(screen.getByTestId('port-row-hma:JP-TOKYO#4')).toBeInTheDocument();
  });

  it('bulk-exports the selected ports through the export modal', async () => {
    await renderMain();
    const row = screen.getByTestId(`port-row-${TOKYO_1}`);
    fireEvent.click(within(row).getByRole('checkbox'));

    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('1 port selected');
    fireEvent.click(screen.getByText('Export'));

    await waitFor(() =>
      expect(screen.getByTestId('export-text')).toHaveValue('127.0.0.1:29001:proxyfarm:demo-pass-1234'),
    );

    fireEvent.click(screen.getByText('socks5://…'));
    await waitFor(() =>
      expect(screen.getByTestId('export-text')).toHaveValue('socks5://proxyfarm:demo-pass-1234@127.0.0.1:29001'),
    );
  });

  it('the group checkbox selects every port of that location', async () => {
    await renderMain();
    fireEvent.click(screen.getByLabelText('Select every port in Tokyo'));
    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('2 ports selected');
  });

  it('Change IP → next free server moves the port to the best free server', async () => {
    await renderMain();
    expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toHaveTextContent('203.0.113.10');
    await changeIp(TOKYO_1);
    await waitFor(() =>
      expect(screen.getByTestId(`rotate-note-${TOKYO_1}`)).toHaveTextContent(
        'Exit IP changed: 203.0.113.10 → 203.0.113.12',
      ),
    );
    expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toHaveTextContent('203.0.113.12');
  });

  it('Change IP → a picked server moves the port to that server', async () => {
    const api = await renderMain();
    const rotateSpy = vi.spyOn(api, 'rotatePort');
    await changeIp(TOKYO_1, '203.0.113.15');
    expect(rotateSpy).toHaveBeenCalledWith(TOKYO_1, '203.0.113.15');
    await waitFor(() => expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toHaveTextContent('203.0.113.15'));
  });

  it('shows a rotate-result note: no free server', async () => {
    await renderMain();
    await changeIp('zoogvpn:NL#1');
    await waitFor(() =>
      expect(screen.getByTestId('rotate-note-zoogvpn:NL#1')).toHaveTextContent(
        'No free server left for this location — the IP stays the same.',
      ),
    );
  });

  it('a port moved to another city shows up in that group, with a notice', async () => {
    await renderMain();
    await changeIp('hma:US-NYC#1');
    await waitFor(() => expect(screen.getByTestId('port-row-hma:US-LA#1')).toBeInTheDocument());
    expect(screen.queryByTestId('port-row-hma:US-NYC#1')).toBeNull();
    expect(screen.getByTestId('group-hma:US-LA')).toBeInTheDocument();
    expect(await screen.findByTestId('notice-toast')).toHaveTextContent('the port moved to Los Angeles, in the same country');
  });

  it('a move to another city is reported even when the new exit IP could not be confirmed', async () => {
    const api = await renderMain();
    vi.spyOn(api, 'rotatePort').mockResolvedValueOnce({ changed: false, noteKey: 'main.rotateResult.sameCityNote', movedTo: 'Osaka' });
    await changeIp(TOKYO_1);
    await waitFor(() =>
      expect(screen.getByTestId(`rotate-note-${TOKYO_1}`)).toHaveTextContent('No free server left here — the port moved to Osaka, in the same country.'),
    );
  });

  it('bulk Change IP summarises changed / moved-to-another-city / unavailable', async () => {
    await renderMain();
    for (const key of [TOKYO_1, 'hma:US-NYC#1', 'zoogvpn:NL#1']) {
      fireEvent.click(within(screen.getByTestId(`port-row-${key}`)).getByRole('checkbox'));
    }

    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Change IP'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-rotate-summary')).toHaveTextContent(
        '1 changed IP, 1 moved to another city, 1 had no free server',
      ),
    );
    // The moved port's old key is no longer selected.
    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('2 ports selected');
  });

  it('per-row copy copies the authenticated host:port:user:pass form', async () => {
    const api = createFakeProxyFarmApi();
    const exportSpy = vi.spyOn(api, 'exportPorts');
    const writeSpy = vi.spyOn(navigator.clipboard, 'writeText');
    await renderMain(api);

    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByText('Copy'));
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith('127.0.0.1:29001:proxyfarm:demo-pass-1234'));
    expect(exportSpy).toHaveBeenCalledWith([TOKYO_1], 'hostPortUserPass');
  });

  it('surfaces an error and opens Export as a manual fallback when the clipboard write rejects', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await renderMain();

    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByText('Copy'));
    await waitFor(() => expect(screen.getByTestId('copy-error-toast')).toBeInTheDocument());
    expect(screen.getByTestId('export-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('copied-toast')).toBeNull();
  });

  it('per-row Stop stops only that port', async () => {
    const api = createFakeProxyFarmApi();
    const stopSpy = vi.spyOn(api, 'stopPorts');
    await renderMain(api);

    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByText('Stop'));
    await waitFor(() => expect(stopSpy).toHaveBeenCalledWith([TOKYO_1]));
  });

  it('per-row Remove confirms first, then removes that port', async () => {
    const api = createFakeProxyFarmApi();
    const removeSpy = vi.spyOn(api, 'removePorts');
    await renderMain(api);

    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByText('Remove'));
    expect(removeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith([TOKYO_1]));
  });

  it('bulk Remove asks for confirmation before removing', async () => {
    const api = createFakeProxyFarmApi();
    const removeSpy = vi.spyOn(api, 'removePorts');
    await renderMain(api);

    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByRole('checkbox'));
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Remove'));
    expect(removeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith([TOKYO_1]));
  });

  describe('note timeouts', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a second Change IP restarts the note timer instead of being cleared by the first one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await renderMain();

      await changeIp(TOKYO_1);
      await waitFor(() =>
        expect(screen.getByTestId(`rotate-note-${TOKYO_1}`)).toHaveTextContent('203.0.113.10 → 203.0.113.12'),
      );

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      await changeIp(TOKYO_1);
      await waitFor(() =>
        expect(screen.getByTestId(`rotate-note-${TOKYO_1}`)).toHaveTextContent('203.0.113.12 → 203.0.113.10'),
      );

      // 7 s after the first change, 3 s after the second: the first timer must
      // not have removed the second note.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId(`rotate-note-${TOKYO_1}`)).toHaveTextContent('203.0.113.12 → 203.0.113.10');

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByTestId(`rotate-note-${TOKYO_1}`)).toBeNull();
    });

    it('a second bulk Change IP restarts the summary timer', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await renderMain();
      fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByRole('checkbox'));

      fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Change IP'));
      await waitFor(() => expect(screen.getByTestId('bulk-rotate-summary')).toBeInTheDocument());
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Change IP'));
      // The summary is set in the same tick as the refreshed rows.
      await waitFor(() => expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toHaveTextContent('203.0.113.10'));
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
