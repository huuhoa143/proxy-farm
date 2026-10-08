import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsScreen } from './SettingsScreen';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';

beforeAll(() => {
  initI18n('en');
});

describe('SettingsScreen', () => {
  it('commits text fields on blur, not on every keystroke (no char-by-char password writes)', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'setSettings');
    render(<SettingsScreen api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());

    const pass = screen.getByLabelText('Password');
    fireEvent.change(pass, { target: { value: 'sec' } });
    fireEvent.change(pass, { target: { value: 'secret' } });
    expect(spy).not.toHaveBeenCalled();

    fireEvent.blur(pass);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ proxyPass: 'secret' });
  });

  it('does not persist an empty or out-of-range base port, and shows an inline error', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'setSettings');
    render(<SettingsScreen api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Base port')).toBeInTheDocument());

    const base = screen.getByLabelText('Base port');
    fireEvent.change(base, { target: { value: '' } });
    fireEvent.blur(base);
    await waitFor(() => expect(screen.getByTestId('settings-error')).toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();

    fireEvent.change(base, { target: { value: '80' } });
    fireEvent.blur(base);
    await waitFor(() => expect(screen.getByTestId('settings-error')).toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  it('persists a valid base port on blur', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'setSettings');
    render(<SettingsScreen api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Base port')).toBeInTheDocument());

    const base = screen.getByLabelText('Base port');
    fireEvent.change(base, { target: { value: '30000' } });
    fireEvent.blur(base);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ basePort: 30000 }));
  });

  it('toggles still persist immediately (one write per flip)', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'setSettings');
    render(<SettingsScreen api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Keep this computer awake while ports are on')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Keep this computer awake while ports are on'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ keepAwake: false }));
  });
});
