import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileCard, ZoogVpnCard, guessCountryFromFilename } from './OnboardingCards';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';

beforeAll(() => {
  initI18n('en');
});

describe('guessCountryFromFilename', () => {
  it('finds a 2-letter country token surrounded by other words', () => {
    expect(guessCountryFromFilename('mullvad-se-got.conf')).toBe('SE');
  });

  it('finds a leading 2-letter country token', () => {
    expect(guessCountryFromFilename('us-nyc.ovpn')).toBe('US');
  });

  it('returns an empty string when no 2-letter token exists', () => {
    expect(guessCountryFromFilename('myconfig.ovpn')).toBe('');
  });
});

function makeFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/plain' });
}

describe('FileCard', () => {
  it('stages the file, pre-fills a guessed country, and only imports (with that country) on confirm', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'importConfigFile');
    render(<FileCard api={api} onAdded={() => {}} />);

    const file = makeFile('mullvad-se-got.conf', '[Interface]\nPrivateKey = abc\n[Peer]\nPublicKey = def');
    const input = screen.getByTestId('file-dropzone').querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('file-pending')).toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Country')).toHaveValue('SE');

    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'NO' } });
    fireEvent.click(screen.getByText('Import'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('mullvad-se-got.conf', expect.any(String), 'NO'));
  });

  it('blocks import until the country is a valid 2-letter code', async () => {
    const api = createFakeProxyFarmApi();
    const spy = vi.spyOn(api, 'importConfigFile');
    render(<FileCard api={api} onAdded={() => {}} />);

    // No 2-letter token in the name → country starts empty → import disabled.
    const file = makeFile('myconfig.ovpn', 'remote vpn.example.com 1194');
    const input = screen.getByTestId('file-dropzone').querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('file-pending')).toBeInTheDocument());
    expect(screen.getByText('Import').closest('button')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'X' } });
    expect(screen.getByTestId('file-country-invalid')).toBeInTheDocument();
    expect(screen.getByText('Import').closest('button')).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'US' } });
    expect(screen.queryByTestId('file-country-invalid')).toBeNull();
    expect(screen.getByText('Import').closest('button')).toBeEnabled();
  });
});

describe('ZoogVpnCard', () => {
  it('surfaces a rejected addAccount as an inline message instead of failing silently', async () => {
    const api = createFakeProxyFarmApi();
    vi.spyOn(api, 'addAccount').mockRejectedValueOnce(new Error('IPC error: zoogvpn.check.missingPassword'));
    render(<ZoogVpnCard api={api} onAdded={() => {}} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('Check'));

    await waitFor(() =>
      expect(screen.getByTestId('zoogvpn-message')).toHaveTextContent('Enter your ZoogVPN password.'),
    );
  });
});
