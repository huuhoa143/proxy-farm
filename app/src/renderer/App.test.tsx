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
});
