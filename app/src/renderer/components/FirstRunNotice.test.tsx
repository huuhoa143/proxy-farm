import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DISCLAIMER_NOTICE_VERSION } from '../../shared/contracts';
import { LINKS } from '../../shared/links';
import { createFakeProxyFarmApi, type FakeProxyFarmApi } from '../api';
import { changeLanguage, initI18n } from '../i18n';
import { FIRST_RUN_POINTS, FirstRunNotice } from './FirstRunNotice';

beforeAll(() => {
  initI18n('en');
});

afterEach(() => {
  delete (window as Partial<Window>).proxyFarm;
});

describe('FirstRunNotice', () => {
  it('lists the points, opens the full disclaimer, and saves the acknowledgement', async () => {
    await act(() => changeLanguage('en'));
    const api = createFakeProxyFarmApi();
    const setSettings = vi.spyOn(api, 'setSettings');
    const onAcknowledged = vi.fn();
    render(<FirstRunNotice api={api} onAcknowledged={onAcknowledged} />);

    const notice = screen.getByTestId('first-run-notice');
    expect(notice.querySelectorAll('li')).toHaveLength(FIRST_RUN_POINTS.length);
    expect(notice).toHaveTextContent('Use your own VPN accounts, on your own computer.');
    expect(notice).toHaveTextContent('not affiliated with HMA / Gen Digital, Surfshark, ZoogVPN, NordVPN / Nord Security or ExpressVPN');

    fireEvent.click(screen.getByTestId('first-run-full'));
    expect(screen.getByTestId('disclaimer-full')).toHaveAttribute('href', LINKS.disclaimer);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('disclaimer-modal')).toBeNull();
    expect(setSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('first-run-ack'));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
    expect(setSettings).toHaveBeenCalledWith({ acknowledgedDisclaimer: DISCLAIMER_NOTICE_VERSION });
  });

  it('stays up when saving fails, so it is asked again', async () => {
    const api = createFakeProxyFarmApi();
    vi.spyOn(api, 'setSettings').mockRejectedValueOnce(new Error('disk full'));
    const onAcknowledged = vi.fn();
    render(<FirstRunNotice api={api} onAcknowledged={onAcknowledged} />);
    fireEvent.click(screen.getByTestId('first-run-ack'));
    await waitFor(() => expect(screen.getByTestId('first-run-ack')).not.toBeDisabled());
    expect(onAcknowledged).not.toHaveBeenCalled();
  });
});

describe('first-run notice in the app (integration)', () => {
  async function renderApp(api: FakeProxyFarmApi) {
    vi.resetModules();
    window.proxyFarm = api;
    const { App } = await import('../App');
    return render(<App />);
  }

  it('is shown once, alongside the running ports, and not again after "I understand"', async () => {
    const api = createFakeProxyFarmApi();
    await renderApp(api);
    // Shown over the main screen: existing users' ports are not blocked.
    await waitFor(() => expect(screen.getByTestId('first-run-notice')).toBeInTheDocument());
    expect(screen.getByTestId('main-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('first-run-ack'));
    await waitFor(() => expect(screen.queryByTestId('first-run-notice')).toBeNull());
    expect((await api.getSettings()).acknowledgedDisclaimer).toBe(DISCLAIMER_NOTICE_VERSION);

    // Next launch, same persisted settings: no notice.
    cleanup();
    await renderApp(api);
    await waitFor(() => expect(screen.getByTestId('main-screen')).toBeInTheDocument());
    expect(screen.queryByTestId('first-run-notice')).toBeNull();
  });

  it('is shown when settings come from a main process that predates the field', async () => {
    const api = createFakeProxyFarmApi();
    const { acknowledgedDisclaimer: _omitted, ...legacy } = await api.getSettings();
    vi.spyOn(api, 'getSettings').mockResolvedValue(legacy as never);
    await renderApp(api);
    await waitFor(() => expect(screen.getByTestId('first-run-notice')).toBeInTheDocument());
  });
});
