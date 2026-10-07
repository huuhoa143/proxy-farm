import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileCard, guessCountryFromFilename } from './OnboardingCards';
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
});
