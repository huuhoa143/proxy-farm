import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import type { PortRow } from '../../shared/contracts';
import { MainScreen } from './MainScreen';
import { CheckStoreProvider, createCheckStore } from '../checkStore';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';

// Sample ports of the fake API: Tokyo #1 and #2 online, New York retrying, Amsterdam
// failed (auth), one Surfshark port stopped.
const TOKYO_1 = 'hma:JP-TOKYO#1';
const TOKYO_2 = 'hma:JP-TOKYO#2';
const NYC = 'hma:US-NYC#1';
const AMS = 'zoogvpn:NL#1';

beforeAll(() => {
  initI18n('en');
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
});

beforeEach(() => {
  window.localStorage.clear();
});

async function renderMain(api = createFakeProxyFarmApi()) {
  const view = render(<MainScreen api={api} />);
  await waitFor(() => expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toBeInTheDocument());
  return { api, view };
}

function shownRows(): string[] {
  return screen.getAllByTestId(/^port-row-/).map((el) => el.getAttribute('data-testid')!.slice('port-row-'.length));
}

function chip(status: string): HTMLElement {
  return screen.getByTestId(`filter-status-${status}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('MainScreen filters', () => {
  it('status chips count every port once and show only their bucket', async () => {
    await renderMain();
    expect(chip('all')).toHaveTextContent('All 5');
    expect(chip('alive')).toHaveTextContent('Alive 2');
    expect(chip('dead')).toHaveTextContent('Dead 2');
    expect(chip('connecting')).toHaveTextContent('Connecting 0');
    expect(chip('stopped')).toHaveTextContent('Stopped 1');

    fireEvent.click(chip('dead'));
    expect(chip('dead')).toHaveAttribute('aria-pressed', 'true');
    expect(shownRows().sort()).toEqual([NYC, AMS].sort());
    // A group with no visible row is hidden.
    expect(screen.queryByTestId('group-hma:JP-TOKYO')).toBeNull();
  });

  it('group headers count only the visible rows', async () => {
    await renderMain();
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: '29005' } });
    expect(shownRows()).toEqual([TOKYO_2]);
    expect(screen.getByTestId('group-stats-hma:JP-TOKYO')).toHaveTextContent('1 port · 1 online');
  });

  it('search matches location names in either language without accents, IPs and ports', async () => {
    await renderMain();
    const search = screen.getByTestId('filter-search');
    fireEvent.change(search, { target: { value: 'new york' } });
    expect(shownRows()).toEqual([NYC]);
    fireEvent.change(search, { target: { value: 'nhat ban' } }); // Nhật Bản = Japan (vi)
    expect(shownRows()).toEqual([TOKYO_1, TOKYO_2]);
    fireEvent.change(search, { target: { value: '203.0.113.11' } });
    expect(shownRows()).toEqual([TOKYO_2]);
  });

  it('the provider filter combines with status', async () => {
    await renderMain();
    fireEvent.change(screen.getByTestId('filter-provider'), { target: { value: 'zoogvpn' } });
    expect(shownRows()).toEqual([AMS]);
    expect(chip('all')).toHaveTextContent('All 1');
    fireEvent.click(chip('alive'));
    expect(screen.getByTestId('filter-empty')).toBeInTheDocument();
  });

  it('an empty result offers to clear the filters', async () => {
    await renderMain();
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: 'atlantis' } });
    expect(screen.queryByTestId(/^port-row-/)).toBeNull();
    expect(screen.getByTestId('filter-empty')).toHaveTextContent('No ports match the filter');
    fireEvent.click(screen.getByTestId('filter-clear'));
    expect(shownRows()).toHaveLength(5);
    expect(screen.getByTestId('filter-search')).toHaveValue('');
  });

  it('remembers the filter across launches', async () => {
    const { view } = await renderMain();
    fireEvent.click(chip('stopped'));
    view.unmount();
    await act(async () => {
      render(<MainScreen api={createFakeProxyFarmApi()} />);
    });
    await waitFor(() => expect(screen.getByTestId('filter-status-stopped')).toHaveAttribute('aria-pressed', 'true'));
    expect(shownRows()).toEqual(['surfshark:DE-FRA#1']);
  });
});

describe('MainScreen selection under a filter', () => {
  it('select-all selects only the visible ports and keeps hidden selections', async () => {
    await renderMain();
    fireEvent.click(chip('alive'));
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('2 ports selected');

    fireEvent.click(chip('dead'));
    // Still selected, now hidden: the bar says so.
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('2 ports selected (2 hidden)');
    expect(screen.getByLabelText('Select all')).not.toBeChecked();

    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('4 ports selected (2 hidden)');
    // Unticking clears only the visible ones.
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('2 ports selected (2 hidden)');
  });

  it('bulk actions apply to hidden selected ports too', async () => {
    const { api } = await renderMain();
    const stop = vi.spyOn(api, 'stopPorts');
    fireEvent.click(chip('alive'));
    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.click(chip('stopped'));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByText('Stop'));
    });
    expect(stop).toHaveBeenCalledWith(expect.arrayContaining([TOKYO_1, TOKYO_2]));
  });
});

describe('MainScreen Check all', () => {
  it('checks the visible online ports, shows each result, then a summary that selects the dead ones', async () => {
    const { api } = await renderMain();
    const test = vi.spyOn(api, 'testPort').mockImplementation(async (key) =>
      key === TOKYO_2 ? { ok: false } : { ok: true, exitIp: '203.0.113.10', latencyMs: 37 },
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('check-all'));
    });
    await waitFor(() => expect(screen.getByTestId('check-summary')).toHaveTextContent('1 alive · 1 dead · 3 skipped'));
    expect(test.mock.calls.map((c) => c[0]).sort()).toEqual([TOKYO_1, TOKYO_2]);
    // Never a speed test in bulk.
    expect(test.mock.calls.every((c) => c[1] === false)).toBe(true);
    expect(screen.getByTestId(`check-${TOKYO_1}`)).toHaveTextContent('37 ms');
    expect(screen.getByTestId(`check-${TOKYO_1}`)).toHaveTextContent('now');
    expect(screen.getByTestId(`check-${TOKYO_2}`)).toHaveTextContent('Check failed');
    // An online port whose check failed counts as dead.
    expect(chip('dead')).toHaveTextContent('Dead 3');
    expect(chip('alive')).toHaveTextContent('Alive 1');

    fireEvent.click(screen.getByTestId('check-select-dead'));
    expect(chip('dead')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('1 port selected');
    expect(within(screen.getByTestId(`port-row-${TOKYO_2}`)).getByRole('checkbox')).toBeChecked();
    expect(screen.queryByTestId('check-summary')).toBeNull();
  });

  it('a result is dropped when the port reconnects', async () => {
    const api = createFakeProxyFarmApi();
    let push!: (rows: PortRow[]) => void;
    const subscribe = api.onPortsChanged.bind(api);
    vi.spyOn(api, 'onPortsChanged').mockImplementation((cb) => {
      push = cb;
      return subscribe(cb);
    });
    vi.spyOn(api, 'testPort').mockResolvedValue({ ok: false });
    await renderMain(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('check-all'));
    });
    await waitFor(() => expect(screen.getByTestId(`check-${TOKYO_1}`)).toBeInTheDocument());
    expect(chip('dead')).toHaveTextContent('Dead 4');

    const rows = await api.listPorts();
    act(() =>
      push(rows.map((r): PortRow => (r.key === TOKYO_1 && r.state.kind === 'online' ? { ...r, state: { ...r.state, since: r.state.since + 1 } } : r))),
    );
    await waitFor(() => expect(screen.queryByTestId(`check-${TOKYO_1}`)).toBeNull());
    expect(screen.getByTestId(`check-${TOKYO_2}`)).toBeInTheDocument();
    expect(chip('dead')).toHaveTextContent('Dead 3');
  });

  it('shows progress, refuses a second run, and Stop drops the queued checks', async () => {
    const api = createFakeProxyFarmApi();
    const base = (await api.listPorts()).find((r) => r.key === TOKYO_1)!;
    const many: PortRow[] = Array.from({ length: 6 }, (_, i) => ({ ...base, key: `hma:JP-TOKYO#${i + 1}`, proxyPort: 29001 + i }));
    vi.spyOn(api, 'listPorts').mockResolvedValue(many);
    const pending = new Map<string, ReturnType<typeof deferred<{ ok: boolean; latencyMs?: number }>>>();
    const test = vi.spyOn(api, 'testPort').mockImplementation((key) => {
      const d = deferred<{ ok: boolean; latencyMs?: number }>();
      pending.set(key, d);
      return d.promise;
    });
    await renderMain(api);

    await act(async () => {
      fireEvent.click(screen.getByTestId('check-all'));
    });
    expect(screen.getByTestId('check-progress')).toHaveTextContent('Checking 0/6');
    expect(test).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('check-all')).toBeDisabled();

    await act(async () => {
      pending.get('hma:JP-TOKYO#1')!.resolve({ ok: true, latencyMs: 20 });
    });
    expect(screen.getByTestId('check-progress')).toHaveTextContent('Checking 1/6');
    expect(test).toHaveBeenCalledTimes(5);

    fireEvent.click(screen.getByTestId('check-stop'));
    await act(async () => {
      for (const d of pending.values()) d.resolve({ ok: true, latencyMs: 20 });
    });
    await waitFor(() => expect(screen.getByTestId('check-summary')).toHaveTextContent('5 alive · 0 dead · 1 skipped'));
    expect(test).toHaveBeenCalledTimes(5);
    expect(screen.queryByTestId('check-progress')).toBeNull();
    expect(screen.getByTestId('check-all')).not.toBeDisabled();
  });

  it('bulk Check checks the selected online ports and skips the rest', async () => {
    const { api } = await renderMain();
    const test = vi.spyOn(api, 'testPort');
    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_1}`)).getByRole('checkbox'));
    fireEvent.click(within(screen.getByTestId(`port-row-${NYC}`)).getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('bulk-check'));
    });
    await waitFor(() => expect(screen.getByTestId('check-summary')).toHaveTextContent('1 alive · 0 dead · 1 skipped'));
    expect(test.mock.calls.map((c) => c[0])).toEqual([TOKYO_1]);
  });
});

describe('MainScreen Check all across a tab switch', () => {
  it('keeps the results, and a running check, when the user leaves the Ports screen and comes back', async () => {
    const api = createFakeProxyFarmApi();
    const store = createCheckStore();
    const pending = new Map<string, ReturnType<typeof deferred<{ ok: boolean; latencyMs?: number }>>>();
    vi.spyOn(api, 'testPort').mockImplementation((key) => {
      const d = deferred<{ ok: boolean; latencyMs?: number }>();
      pending.set(key, d);
      return d.promise;
    });
    const screenWithStore = () => (
      <CheckStoreProvider value={store}>
        <MainScreen api={api} />
      </CheckStoreProvider>
    );
    const first = render(screenWithStore());
    await waitFor(() => expect(screen.getByTestId(`port-row-${TOKYO_1}`)).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('check-all'));
    });
    await act(async () => {
      pending.get(TOKYO_1)!.resolve({ ok: true, latencyMs: 44 });
    });
    expect(screen.getByTestId('check-progress')).toHaveTextContent('Checking 1/2');

    first.unmount(); // another tab
    await act(async () => {
      pending.get(TOKYO_2)!.resolve({ ok: false });
    });

    render(screenWithStore());
    await waitFor(() => expect(screen.getByTestId(`check-${TOKYO_1}`)).toHaveTextContent('44 ms'));
    expect(screen.getByTestId(`check-${TOKYO_2}`)).toHaveTextContent('Check failed');
    expect(screen.getByTestId('check-summary')).toHaveTextContent('1 alive · 1 dead · 3 skipped');
  });
});

describe('MainScreen Check all order', () => {
  it('checks ports in on-screen order, not the order main lists them in', async () => {
    const api = createFakeProxyFarmApi();
    const listed = await api.listPorts();
    // New York (United States) first in main's list, but its group sorts after Japan.
    const nyc = listed.find((r) => r.key === NYC)!;
    const rows: PortRow[] = [
      { ...nyc, state: { kind: 'online', since: 1, exitIp: '203.0.113.20', country: 'US' } },
      ...listed.filter((r) => r.key === TOKYO_2),
      ...listed.filter((r) => r.key !== NYC && r.key !== TOKYO_2),
    ];
    vi.spyOn(api, 'listPorts').mockResolvedValue(rows);
    const test = vi.spyOn(api, 'testPort').mockResolvedValue({ ok: true, latencyMs: 5 });
    await renderMain(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('check-all'));
    });
    await waitFor(() => expect(screen.getByTestId('check-summary')).toBeInTheDocument());
    expect(test.mock.calls.map((c) => c[0])).toEqual([TOKYO_1, TOKYO_2, NYC]);
  });
});

describe('MainScreen toolbar Export', () => {
  it('exports the visible ports when nothing is selected, the selection otherwise', async () => {
    await renderMain();
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: 'tokyo' } });
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() =>
      expect(screen.getByTestId('export-text')).toHaveValue(
        '127.0.0.1:29001:proxyfarm:demo-pass-1234\n127.0.0.1:29005:proxyfarm:demo-pass-1234',
      ),
    );
    fireEvent.click(screen.getByText('Close', { selector: '.mf button' }));

    fireEvent.click(within(screen.getByTestId(`port-row-${TOKYO_2}`)).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(screen.getByTestId('export-text')).toHaveValue('127.0.0.1:29005:proxyfarm:demo-pass-1234'));
  });
});
