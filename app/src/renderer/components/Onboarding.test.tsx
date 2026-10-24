import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import type { ProxyFarmApi } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

describe('Onboarding', () => {
  it('adds an HMA account from a license key', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'addAccount');
    render(<Onboarding api={api} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('License key')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('License key'), { target: { value: 'TEST00-TEST11-TEST22' } });
    fireEvent.click(screen.getByText('Add with license key'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('hma', { licenseKey: 'TEST00-TEST11-TEST22' }));
  });

  it('renders only the enabled provider cards (HMA + Surfshark for now)', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('provider-card-hma')).toBeInTheDocument());
    expect(screen.getByTestId('provider-card-surfshark')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-card-zoogvpn')).toBeNull();
    expect(screen.queryByTestId('provider-card-file')).toBeNull();
  });

  it('enables Continue only after an account exists', async () => {
    render(<Onboarding api={createFakeProxyFarmApi()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeEnabled());
  });
});
