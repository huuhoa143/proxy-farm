import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AppStatus } from '../shared/contracts';
import { createFakeProxyFarmApi } from './api';

async function renderWithStatus(status: AppStatus) {
  vi.resetModules();
  const api = createFakeProxyFarmApi();
  window.proxyFarm = { ...api, getAppStatus: async () => status };
  const { App } = await import('./App');
  render(<App />);
}

afterEach(() => {
  delete (window as Partial<Window>).proxyFarm;
});

describe('App status surfaces (integration)', () => {
  it('shows a blocking error screen instead of the app when the engine is missing/quarantined', async () => {
    await renderWithStatus({ secretsUnavailable: false, engineError: 'spawn sing-box ENOENT' });
    await waitFor(() => expect(screen.getByTestId('engine-error')).toBeInTheDocument());
    expect(screen.getByText('spawn sing-box ENOENT')).toBeInTheDocument();
    expect(screen.queryByTestId('main-screen')).toBeNull();
  });

  it('shows a persistent banner when secrets are kept in memory only', async () => {
    await renderWithStatus({ secretsUnavailable: true });
    await waitFor(() => expect(screen.getByTestId('secrets-unavailable')).toBeInTheDocument());
    expect(screen.getByTestId('main-screen')).toBeInTheDocument();
  });
});
