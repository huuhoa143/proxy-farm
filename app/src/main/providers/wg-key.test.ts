import { describe, expect, it } from 'vitest';
import { migrateKeyLabels, wgKeyLabel, wgPublicKey } from './wg-key';

// RFC 7748 §6.1, Alice's X25519 key pair.
const PRIVATE = 'dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=';
const PUBLIC = 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=';

describe('wgPublicKey / wgKeyLabel', () => {
  it('derives the X25519 public key of a WireGuard private key', () => {
    expect(wgPublicKey(PRIVATE)).toBe(PUBLIC);
  });

  it('labels the account after the end of its public key, never its private key', () => {
    const label = wgKeyLabel(PRIVATE);
    expect(label).toBe('pubkey …qqbTmo');
    expect(label).not.toContain(PRIVATE.replace(/=+$/, '').slice(-4));
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => wgPublicKey('c2hvcnQ=')).toThrow();
  });
});

describe('migrateKeyLabels', () => {
  const secret = (privateKey: string) => JSON.stringify({ kind: 'wgkey', privateKey });

  it('relabels a legacy private-key label after the public key', () => {
    const accounts = [{ id: 'nordvpn-1', label: `key …${PRIVATE.slice(-6)}`, secretRef: 'account:nordvpn-1' }];
    const out = migrateKeyLabels(accounts, () => secret(PRIVATE));
    expect(out).toEqual([{ id: 'nordvpn-1', label: 'pubkey …qqbTmo', secretRef: 'account:nordvpn-1' }]);
  });

  it('leaves other labels, and accounts whose key cannot be read, alone', () => {
    const accounts = [
      { label: 'someone@example.com', secretRef: 'a' },
      { label: 'device …A1B2C3', secretRef: 'b' },
      { label: 'pubkey …qqbTmo', secretRef: 'c' },
      { label: 'key …lost12', secretRef: 'd' },
      { label: 'key …other1', secretRef: 'e' },
    ];
    const load = (ref: string) => (ref === 'e' ? JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }) : null);
    expect(migrateKeyLabels(accounts, load)).toBe(accounts); // unchanged: the same array
  });
});
