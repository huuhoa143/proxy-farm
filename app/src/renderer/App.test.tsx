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

  it('can navigate to Providers (onboarding) and Settings from the nav', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('main-screen')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Providers'));
    await waitFor(() => expect(screen.getByTestId('onboarding')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Settings'));
    await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeInTheDocument());
  });

  it('switches language from the header, not only from Settings (fix item 3)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('main-screen')).toBeInTheDocument());

    const headerSwitch = screen.getByLabelText('Language') as HTMLSelectElement;
    fireEvent.change(headerSwitch, { target: { value: 'vi' } });

    // "Cài đặt" (Settings) is unambiguous — unlike "Cổng" (Ports), which
    // also labels the port-table's Port column.
    await waitFor(() => expect(screen.getByText('Cài đặt')).toBeInTheDocument());
    // Switch back so later tests in this file see English again.
    fireEvent.change(screen.getByLabelText('Ngôn ngữ'), { target: { value: 'en' } });
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());
  });
});
