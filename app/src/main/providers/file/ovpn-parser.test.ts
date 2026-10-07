import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOvpn } from './ovpn-parser';
import { UnsupportedDirectiveError } from './errors';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GOOD = readFileSync(path.join(FIXTURES, 'good.ovpn'), 'utf8');
const BAD = readFileSync(path.join(FIXTURES, 'bad-unsupported-directive.ovpn'), 'utf8');

describe('parseOvpn', () => {
  it('parses remote, proto, cipher, auth, inline ca, inline tls-auth, and auth-user-pass', () => {
    const parsed = parseOvpn(GOOD);
    expect(parsed.remoteHost).toBe('vpn.example.net');
    expect(parsed.remotePort).toBe(1194);
    expect(parsed.proto).toBe('udp');
    expect(parsed.cipher).toBe('AES-256-GCM');
    expect(parsed.auth).toBe('SHA256');
    expect(parsed.needsAuthUserPass).toBe(true);
    expect(parsed.caLines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(parsed.caLines[parsed.caLines.length - 1]).toBe('-----END CERTIFICATE-----');
    expect(parsed.tlsAuthLines).toBeDefined();
    expect(parsed.tlsAuthLines![0]).toBe('-----BEGIN OpenVPN Static key V1-----');
    expect(parsed.controlWrapDirection).toBe('client');
    expect(parsed.tlsCryptLines).toBeUndefined();
  });

  it('rejects a config with an unsupported directive (e.g. an `up` script hook)', () => {
    expect(() => parseOvpn(BAD)).toThrow(UnsupportedDirectiveError);
    try {
      parseOvpn(BAD);
      expect.fail('expected parseOvpn to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedDirectiveError);
      expect((err as UnsupportedDirectiveError).reasonKey).toBe('file.unsupportedDirective');
      expect((err as UnsupportedDirectiveError).directive).toBe('up');
    }
  });

  it('rejects a tcp proto config with proto parsed correctly when supported', () => {
    const tcpVariant = GOOD.replace('proto udp', 'proto tcp').replace('remote vpn.example.net 1194', 'remote vpn.example.net 443');
    const parsed = parseOvpn(tcpVariant);
    expect(parsed.proto).toBe('tcp');
    expect(parsed.remotePort).toBe(443);
  });

  it('rejects an inline <cert> block (client-certificate auth is unsupported)', () => {
    const withCert = GOOD + '\n<cert>\n-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n</cert>\n';
    expect(() => parseOvpn(withCert)).toThrow(UnsupportedDirectiveError);
  });

  it('rejects a bare (non-inline) ca file reference', () => {
    const withExternalCa = 'client\ndev tun\nproto udp\nremote vpn.example.net 1194\nca ca.crt\n';
    expect(() => parseOvpn(withExternalCa)).toThrow(UnsupportedDirectiveError);
  });

  it('throws when remote is missing', () => {
    expect(() => parseOvpn('client\ndev tun\nproto udp\n')).toThrow(/remote/);
  });
});
