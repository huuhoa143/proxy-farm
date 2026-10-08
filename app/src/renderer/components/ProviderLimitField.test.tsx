import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderLimitField } from './ProviderLimitField';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';

beforeAll(() => {
  initI18n('en');
});

describe('ProviderLimitField', () => {
  it('labels the field with the provider display name, not the raw id', () => {
    render(<ProviderLimitField api={createFakeProxyFarmApi()} providerId="zoogvpn" />);
    const field = screen.getByTestId('provider-limit-zoogvpn');
    expect(field).toHaveTextContent('ZoogVPN');
    expect(field).not.toHaveTextContent('zoogvpn');
    expect(screen.getByLabelText('Port limit — ZoogVPN')).toBeInTheDocument();
  });

  it('uses the i18n name for the file provider', () => {
    render(<ProviderLimitField api={createFakeProxyFarmApi()} providerId="file" />);
    expect(screen.getByTestId('provider-limit-file')).toHaveTextContent('Config file');
  });

  it('Save calls setLimit with the entered value and shows the saved state', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'setLimit');
    render(<ProviderLimitField api={api} providerId="hma" />);

    expect(screen.queryByTestId('provider-limit-saved-hma')).toBeNull();
    fireEvent.change(screen.getByLabelText('Port limit — HMA'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(spy).toHaveBeenCalledWith('hma', 12);
    await waitFor(() => expect(screen.getByTestId('provider-limit-saved-hma')).toHaveTextContent('Saved'));
  });

  it('starts at the current limit reported by listProviders (Ruling C)', async () => {
    const { rerender } = render(<ProviderLimitField api={createFakeProxyFarmApi()} providerId="hma" />);
    rerender(<ProviderLimitField api={createFakeProxyFarmApi()} providerId="hma" initialLimit={7} />);
    await waitFor(() => expect((screen.getByLabelText('Port limit — HMA') as HTMLInputElement).value).toBe('7'));
  });
});
