import { describe, expect, it, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import type { ProxyFarmApi } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

function apiWithHmaDetected(detected: boolean): ProxyFarmApi {
  const api = createFakeProxyFarmApi();
  const original = api.listProviders.bind(api);
  api.listProviders = async () => {
    const providers = await original();
    return providers.map((p) => (p.id === 'hma' ? { ...p, detected: { found: detected } } : p));
  };
  return api;
}

describe('Onboarding', () => {
  it('shows the HMA "found" state and a Connect CTA when detected', async () => {
    render(<Onboarding api={apiWithHmaDetected(true)} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('hma-detected')).toBeInTheDocument());
    expect(screen.getByTestId('hma-detected')).toHaveTextContent('HMA found on this computer');
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });

  it('shows the HMA "not found" guidance steps and an Enable-support CTA when not detected', async () => {
    render(<Onboarding api={apiWithHmaDetected(false)} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('hma-not-detected')).toBeInTheDocument());
    expect(screen.getByTestId('hma-not-detected')).toHaveTextContent('HMA not found');
    expect(screen.getByText('Enable HMA support')).toBeInTheDocument();
  });

  it('renders all four provider cards', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeEnabled());
    expect(screen.getByTestId('provider-card-hma')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-zoogvpn')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-surfshark')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-file')).toBeInTheDocument();
  });

  it('enables Continue only after an account exists', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeEnabled());
  });
});
