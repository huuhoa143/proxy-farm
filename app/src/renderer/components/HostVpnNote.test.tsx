import { describe, expect, it, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HostVpnNote } from './HostVpnNote';
import { initI18n } from '../i18n';

beforeAll(() => {
  initI18n('en');
});

describe('HostVpnNote', () => {
  it('shows the info note when another VPN is active', () => {
    render(<HostVpnNote active={true} />);
    expect(screen.getByTestId('host-vpn-note')).toHaveTextContent(
      'Another VPN is active on this computer — Proxy Farm keeps working normally.',
    );
  });

  it('renders nothing when no other VPN is active', () => {
    render(<HostVpnNote active={false} />);
    expect(screen.queryByTestId('host-vpn-note')).toBeNull();
  });
});
