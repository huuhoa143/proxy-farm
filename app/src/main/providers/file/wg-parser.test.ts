import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWireguardConf } from './wg-parser';
import { UnsupportedDirectiveError } from './errors';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GOOD = readFileSync(path.join(FIXTURES, 'good.conf'), 'utf8');
const BAD = readFileSync(path.join(FIXTURES, 'bad-unsupported-directive.conf'), 'utf8');

describe('parseWireguardConf', () => {
  it('parses [Interface] and [Peer] into the fields bind() needs', () => {
    const parsed = parseWireguardConf(GOOD);
    expect(parsed.address).toEqual(['10.14.0.2/16']);
    expect(parsed.privateKey).toBe('yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=');
    expect(parsed.mtu).toBe(1280);
    expect(parsed.peerPublicKey).toBe('l8EOWPyzt/njrb74CADY4VOhns/TbUN6KFTbytHcFQw=');
    expect(parsed.allowedIps).toEqual(['0.0.0.0/0']);
    expect(parsed.endpointHost).toBe('vpn.example.net');
    expect(parsed.endpointPort).toBe(51820);
    expect(parsed.keepalive).toBe(25);
  });

  it('ignores DNS (handled by the engine, not per-endpoint)', () => {
    const parsed = parseWireguardConf(GOOD);
    expect((parsed as any).dns).toBeUndefined();
  });

  it('rejects a PostUp/PreUp/PostDown/PreDown hook', () => {
    expect(() => parseWireguardConf(BAD)).toThrow(UnsupportedDirectiveError);
    try {
      parseWireguardConf(BAD);
      expect.fail('expected to throw');
    } catch (err) {
      expect((err as UnsupportedDirectiveError).reasonKey).toBe('file.unsupportedDirective');
      expect((err as UnsupportedDirectiveError).directive).toBe('PostUp');
    }
  });

  it('throws when PrivateKey or Endpoint is missing', () => {
    expect(() => parseWireguardConf('[Interface]\nAddress = 10.14.0.2/16\n[Peer]\nPublicKey = x\nAllowedIPs = 0.0.0.0/0\n')).toThrow(
      /PrivateKey|Endpoint/,
    );
  });

  it('rejects an unknown directive instead of silently ignoring it', () => {
    const withUnknown = GOOD + 'SomeMadeUpKey = 1\n';
    expect(() => parseWireguardConf(withUnknown)).toThrow(UnsupportedDirectiveError);
  });
});
