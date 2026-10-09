import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOvpn } from './ovpn-parser';
import { UnsupportedDirectiveError } from './errors';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GOOD = readFileSync(path.join(FIXTURES, 'good.ovpn'), 'utf8');
const BAD = readFileSync(path.join(FIXTURES, 'bad-unsupported-directive.ovpn'), 'utf8');
const EXPRESS = readFileSync(path.join(FIXTURES, 'expressvpn-style.ovpn'), 'utf8');

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

  it('rejects an inline <cert> block without its <key>, and a <key> without its <cert>', () => {
    const cert = '\n<cert>\n-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n</cert>\n';
    const key = '\n<key>\n-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n</key>\n';
    expect(() => parseOvpn(GOOD + cert)).toThrow(UnsupportedDirectiveError);
    expect(() => parseOvpn(GOOD + key)).toThrow(UnsupportedDirectiveError);
  });

  it('still rejects <pkcs12> and <extra-certs> blocks', () => {
    const block = (tag: string) => `\n<${tag}>\n-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n</${tag}>\n`;
    expect(() => parseOvpn(GOOD + block('pkcs12'))).toThrow(UnsupportedDirectiveError);
    expect(() => parseOvpn(GOOD + block('extra-certs'))).toThrow(UnsupportedDirectiveError);
  });

  it('rejects a bare (non-inline) ca file reference', () => {
    const withExternalCa = 'client\ndev tun\nproto udp\nremote vpn.example.net 1194\nca ca.crt\n';
    expect(() => parseOvpn(withExternalCa)).toThrow(UnsupportedDirectiveError);
  });

  it('throws when remote is missing', () => {
    expect(() => parseOvpn('client\ndev tun\nproto udp\n')).toThrow(/remote/);
  });

  it('a single remote is a one-server pool', () => {
    const parsed = parseOvpn(GOOD);
    expect(parsed.remotes).toEqual([{ host: 'vpn.example.net', port: 1194, proto: 'udp' }]);
    expect(parsed.servers).toEqual(['vpn.example.net']);
  });

  it('keeps every remote line, in file order, as the server pool', () => {
    const multi = GOOD.replace(
      'remote vpn.example.net 1194',
      'remote a.example.net 1194\nremote 198.51.100.7 1194\nremote b.example.net 1194\nremote-random',
    );
    const parsed = parseOvpn(multi);
    expect(parsed.servers).toEqual(['a.example.net', '198.51.100.7', 'b.example.net']);
    expect(parsed.remoteHost).toBe('a.example.net');
    expect(parsed.remotes).toHaveLength(3);
  });

  it('dedupes a host listed twice and drops remotes whose port or protocol differs from the first', () => {
    // bind() only learns the resolved IP, so every server must share one port + protocol.
    const multi = GOOD.replace(
      'remote vpn.example.net 1194',
      'remote a.example.net 1194\nremote a.example.net 443 tcp\nremote b.example.net 1194 udp\nremote c.example.net 1195\nremote a.example.net 1194',
    );
    const parsed = parseOvpn(multi);
    expect(parsed.remotes).toHaveLength(5);
    expect(parsed.remotes[1]).toEqual({ host: 'a.example.net', port: 443, proto: 'tcp' });
    expect(parsed.servers).toEqual(['a.example.net', 'b.example.net']);
  });

  it("applies the file's proto to remotes without their own, even when proto comes later", () => {
    const parsed = parseOvpn(GOOD.replace('proto udp\n', '').replace('cipher AES', 'proto tcp\ncipher AES'));
    expect(parsed.proto).toBe('tcp');
    expect(parsed.remotes[0].proto).toBe('tcp');
  });

  it("uses the first remote's own protocol over the file's proto", () => {
    const parsed = parseOvpn(GOOD.replace('remote vpn.example.net 1194', 'remote vpn.example.net 443 tcp'));
    expect(parsed.proto).toBe('tcp');
    expect(parsed.remotePort).toBe(443);
  });

  it('rejects a remote with an unknown protocol or a bad port', () => {
    expect(() => parseOvpn(GOOD.replace('remote vpn.example.net 1194', 'remote vpn.example.net 1194 udp6'))).toThrow(
      UnsupportedDirectiveError,
    );
    expect(() => parseOvpn(GOOD.replace('remote vpn.example.net 1194', 'remote vpn.example.net 70000'))).toThrow(/port/);
  });

  it('extracts a numeric tun-mtu directive', () => {
    const withTunMtu = GOOD.replace('fast-io', 'tun-mtu 1350\nfast-io');
    expect(parseOvpn(withTunMtu).tunMtu).toBe(1350);
  });

  it('leaves tunMtu undefined when the directive is absent', () => {
    expect(parseOvpn(GOOD).tunMtu).toBeUndefined();
  });

  it('ignores a non-numeric tun-mtu value rather than throwing', () => {
    const withBogusMtu = GOOD.replace('fast-io', 'tun-mtu not-a-number\nfast-io');
    expect(parseOvpn(withBogusMtu).tunMtu).toBeUndefined();
  });
});

describe('parseOvpn: an ExpressVPN-style profile (client certificate, fragment, verify-x509-name)', () => {
  it('parses the whole file', () => {
    const parsed = parseOvpn(EXPRESS);
    expect(parsed.servers).toEqual(['vpn-ca-version-2.example.net']);
    expect(parsed.remotePort).toBe(1195);
    expect(parsed.proto).toBe('udp');
    expect(parsed.needsAuthUserPass).toBe(true);
    expect(parsed.cipher).toBe('AES-256-GCM');
    expect(parsed.auth).toBe('SHA512');
    expect(parsed.tunMtu).toBe(1500);
  });

  it('keeps the inline client certificate and key', () => {
    const parsed = parseOvpn(EXPRESS);
    expect(parsed.clientCertLines).toEqual([
      '-----BEGIN CERTIFICATE-----',
      'RkFLRS1DTElFTlQtQ0VSVC1mb3ItdGVzdGluZy1vbmx5',
      '-----END CERTIFICATE-----',
    ]);
    expect(parsed.clientKeyLines?.[0]).toBe('-----BEGIN RSA PRIVATE KEY-----');
    expect(parsed.clientKeyLines?.at(-1)).toBe('-----END RSA PRIVATE KEY-----');
  });

  it('maps fragment, mssfix, comp-lzo no, verify-x509-name and ns-cert-type', () => {
    const parsed = parseOvpn(EXPRESS);
    expect(parsed.fragment).toBe(1300);
    expect(parsed.mssFix).toBe(1200);
    expect(parsed.compressionLzo).toBe('no');
    expect(parsed.serverName).toBe('Server');
    expect(parsed.serverNameType).toBe('name-prefix');
    expect(parsed.nsCertType).toBe('server');
  });

  it('leaves every new field unset for a profile without those directives', () => {
    const parsed = parseOvpn(GOOD);
    for (const field of ['clientCertLines', 'clientKeyLines', 'fragment', 'mssFix', 'compressionLzo', 'serverName', 'serverNameType', 'nsCertType'] as const) {
      expect(parsed[field]).toBeUndefined();
    }
  });

  it('reads verify-x509-name with each type, a quoted name, and no type (subject)', () => {
    const withName = (line: string) => parseOvpn(EXPRESS.replace('verify-x509-name Server name-prefix', line));
    expect(withName('verify-x509-name vpn.example.net name')).toMatchObject({ serverName: 'vpn.example.net', serverNameType: 'name' });
    expect(withName("verify-x509-name 'C=VG, CN=Server' subject")).toMatchObject({ serverName: 'C=VG, CN=Server', serverNameType: 'subject' });
    expect(withName('verify-x509-name "Server"')).toMatchObject({ serverName: 'Server', serverNameType: 'subject' });
    expect(() => withName('verify-x509-name Server bogus')).toThrow(UnsupportedDirectiveError);
    expect(() => withName('verify-x509-name')).toThrow(UnsupportedDirectiveError);
  });

  it('rejects ns-cert-type other than server, and a non-numeric fragment or mssfix', () => {
    expect(() => parseOvpn(EXPRESS.replace('ns-cert-type server', 'ns-cert-type client'))).toThrow(UnsupportedDirectiveError);
    expect(() => parseOvpn(EXPRESS.replace('fragment 1300', 'fragment lots'))).toThrow(UnsupportedDirectiveError);
    expect(() => parseOvpn(EXPRESS.replace('mssfix 1200', 'mssfix big'))).toThrow(UnsupportedDirectiveError);
  });

  it('keeps ignoring a bare mssfix and comp-lzo values other than no, as before', () => {
    expect(parseOvpn(EXPRESS.replace('mssfix 1200', 'mssfix')).mssFix).toBeUndefined();
    expect(parseOvpn(EXPRESS.replace('comp-lzo no', 'comp-lzo')).compressionLzo).toBeUndefined();
    expect(parseOvpn(EXPRESS.replace('comp-lzo no', 'comp-lzo adaptive')).compressionLzo).toBeUndefined();
  });
});
