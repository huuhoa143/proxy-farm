import { describe, expect, it, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { App } from './App';

beforeAll(() => {
  // App reads window.proxyFarm at import time via getProxyFarmApi(); leaving
  // it undefined in jsdom makes it fall back to the in-memory fake, which
  // ships sample accounts, so the app lands on the main screen.
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
});

describe('App', () => {
  it('boots straight to the main screen when the (fake) backend already has accounts', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('main-screen')).toBeInTheDocument());
  });

  it('starts in Vietnamese, the default language, and can navigate from the nav', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('main-screen')).toBeInTheDocument());

    fireEvent.click(screen.getByText('VPN'));
    await waitFor(() => expect(screen.getByTestId('onboarding')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Cài đặt'));
    await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeInTheDocument());
  });

  it('switches language from the header, not only from Settings (fix item 3)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('main-screen')).toBeInTheDocument());

    const headerSwitch = screen.getByLabelText('Ngôn ngữ') as HTMLSelectElement;
    fireEvent.change(headerSwitch, { target: { value: 'en' } });
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    // Switch back so later tests in this file see the default (Vietnamese) again.
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'vi' } });
    // "Cài đặt" (Settings) is unambiguous — unlike "Cổng" (Ports), which
    // also labels the port-table's Port column.
    await waitFor(() => expect(screen.getByText('Cài đặt')).toBeInTheDocument());
  });
});
