import { describe, expect, it } from 'vitest';
import { classifyLog } from './signals';

describe('classifyLog', () => {
  it('classifies an OpenVPN tunnel-established line', () => {
    const line = 'INFO[0000] endpoint/openvpn-client[ep]: tunnel established to 5.62.19.134:1194 over udp';
    expect(classifyLog(line)).toBe('established');
  });

  it('classifies a terminal auth-failure line', () => {
    const line =
      'ERROR[0001] endpoint/openvpn-client[ep]: client terminated: authentication failed: terminal (auth-retry none)';
    expect(classifyLog(line)).toBe('auth-terminal');
  });

  it('returns null for an unrelated info line', () => {
    const line = 'INFO[0000] inbound/mixed[in]: tcp server started at 127.0.0.1:39501';
    expect(classifyLog(line)).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(classifyLog('')).toBeNull();
  });

  it('does not misclassify a non-terminal auth failure', () => {
    const line = 'ERROR[0001] endpoint/openvpn-client[ep]: authentication failed, retrying';
    expect(classifyLog(line)).toBeNull();
  });
});
