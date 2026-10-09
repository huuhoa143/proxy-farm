import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import type { ProviderId, ProxyFarmApi } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

function apiWithHmaDetected(detected: { found: boolean; hintKey?: string }): ProxyFarmApi {
  const api = createFakeProxyFarmApi();
  const original = api.listProviders.bind(api);
  api.listProviders = async () => {
    const providers = await original();
    return providers.map((p) => (p.id === 'hma' ? { ...p, detected } : p));
  };
  return api;
}

describe('Onboarding', () => {
  it('shows the HMA "found" state and a Connect CTA when detected', async () => {
    render(<Onboarding api={apiWithHmaDetected({ found: true })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('hma-detected')).toBeInTheDocument());
    expect(screen.getByTestId('hma-detected')).toHaveTextContent('HMA found on this computer');
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });

  it('shows the HMA "not found" guidance steps with no action button when there is no helper-missing hint', async () => {
    render(<Onboarding api={apiWithHmaDetected({ found: false })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('hma-not-detected')).toBeInTheDocument());
    expect(screen.getByTestId('hma-not-detected')).toHaveTextContent('HMA not found');
    expect(screen.queryByText('Enable HMA support')).toBeNull();
  });

  it('shows the Enable-HMA-support CTA and calls enableHmaSupport() when the helper is missing (ruling A)', async () => {
    const api = apiWithHmaDetected({ found: false, hintKey: 'hma.helperMissing' });
    const spy = vi.spyOn(api, 'enableHmaSupport');
    render(<Onboarding api={api} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('hma-helper-missing')).toBeInTheDocument());
    expect(screen.getByTestId('hma-helper-missing')).toHaveTextContent('HMA needs one more step on Windows');

    fireEvent.click(screen.getByText('Enable HMA support'));
    expect(spy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('hma-message')).toHaveTextContent('HMA helper installed'));
  });

  it('renders all five provider cards', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeEnabled());
    expect(screen.getByTestId('provider-card-hma')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-zoogvpn')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-surfshark')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-nordvpn')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-file')).toBeInTheDocument();
  });

  it('enables Continue only after an account exists', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeEnabled());
  });

  it('hides the port-limit panel until at least one provider is connected', async () => {
    const api = createFakeProxyFarmApi();
    api.listProviders = async () =>
      (['hma', 'zoogvpn', 'surfshark', 'nordvpn', 'file'] as ProviderId[]).map((id) => ({
        id,
        accounts: [],
        detected: id === 'hma' ? { found: false } : undefined,
        limit: 0,
      }));
    render(<Onboarding api={api} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding')).toBeInTheDocument());
    expect(screen.getByTestId('onboarding-continue')).toBeDisabled();
    expect(screen.queryByTestId('provider-limits')).toBeNull();
  });

  it('shows the port-limit panel once an account exists', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('provider-limits')).toBeInTheDocument());
  });
});
