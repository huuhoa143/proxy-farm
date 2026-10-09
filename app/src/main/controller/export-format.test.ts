import { describe, expect, it } from 'vitest';
import type { PortRow } from '../../shared/contracts';
import { CSV_HEADER, csvField, exportCsv, exportLines, formatProxy, sanitizeChecks } from './export-format';

describe('export formats (spec §4.2, 4 v1 line formats)', () => {
  const c = { host: '127.0.0.1', user: 'proxy', pass: 's3cret' };

  it('hostPortUserPass', () => {
    expect(formatProxy('hostPortUserPass', 29001, c)).toBe('127.0.0.1:29001:proxy:s3cret');
  });

  it('socks5Url', () => {
    expect(formatProxy('socks5Url', 29001, c)).toBe('socks5://proxy:s3cret@127.0.0.1:29001');
  });

  it('hostPort', () => {
    expect(formatProxy('hostPort', 29001, c)).toBe('127.0.0.1:29001');
  });

  it('curl', () => {
    expect(formatProxy('curl', 29001, c)).toBe('curl -x socks5h://proxy:s3cret@127.0.0.1:29001 https://api.ipify.org');
  });

  it('omits credentials when no auth is configured', () => {
    const noAuth = { host: '127.0.0.1', user: '', pass: '' };
    expect(formatProxy('hostPortUserPass', 1, noAuth)).toBe('127.0.0.1:1');
    expect(formatProxy('socks5Url', 1, noAuth)).toBe('socks5://127.0.0.1:1');
    expect(formatProxy('curl', 1, noAuth)).toBe('curl -x socks5h://127.0.0.1:1 https://api.ipify.org');
  });

  it('URL-encodes credentials containing reserved characters', () => {
    expect(formatProxy('socks5Url', 1, { host: 'h', user: 'a@b', pass: 'p:q' })).toBe('socks5://a%40b:p%3Aq@h:1');
  });

  it('joins several ports with newlines, one per line', () => {
    expect(exportLines('hostPort', [29001, 29002, 29003], c)).toBe(
      '127.0.0.1:29001\n127.0.0.1:29002\n127.0.0.1:29003',
    );
  });

  it('returns an empty string for an empty port list', () => {
    expect(exportLines('hostPort', [], c)).toBe('');
  });
});

describe('CSV export', () => {
  const c = { host: '127.0.0.1', user: 'proxy', pass: 's3cret' };
  const row = (over: Partial<PortRow>): PortRow => ({
    key: 'hma:JP#1',
    locationKey: 'hma:JP',
    providerId: 'hma',
    accountId: 'hma-1',
    label: 'Tokyo',
    country: 'JP',
    city: 'Tokyo',
    proxyPort: 29001,
    enabled: true,
    state: { kind: 'online', since: 1, exitIp: '203.0.113.10', country: 'JP', latencyMs: 42 },
    autoRotateMin: 0,
    ...over,
  });

  it('quotes a field only when it holds a comma, quote or line break (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\r')).toBe('"cr\r"');
    expect(csvField(undefined)).toBe('');
    expect(csvField(42)).toBe('42');
  });

  it('writes the header, then one CRLF-separated row per port', () => {
    const text = exportCsv([row({}), row({ key: 'hma:NL#1', city: 'Amsterdam', country: 'NL', proxyPort: 29002, state: { kind: 'stopped' } })], c);
    expect(text.split('\r\n')).toEqual([
      'host,port,username,password,location,provider,exit_ip,country,status,latency_ms',
      '127.0.0.1,29001,proxy,s3cret,Tokyo,hma,203.0.113.10,JP,alive,42',
      '127.0.0.1,29002,proxy,s3cret,Amsterdam,hma,,NL,stopped,',
    ]);
  });

  it('takes status and latency from the latest check when there is one', () => {
    expect(exportCsv([row({})], c, { 'hma:JP#1': { ok: true, latencyMs: 77 } }).split('\r\n')[1]).toMatch(/,alive,77$/);
    // A failed check makes the port dead and drops the poll's older latency.
    expect(exportCsv([row({})], c, { 'hma:JP#1': { ok: false } }).split('\r\n')[1]).toMatch(/,dead,$/);
  });

  it('escapes credentials and location names that need it', () => {
    const line = exportCsv([row({ city: 'Washington, D.C.' })], { host: 'h', user: 'u"x', pass: 'p,q' }).split('\r\n')[1];
    expect(line).toBe('h,29001,"u""x","p,q","Washington, D.C.",hma,203.0.113.10,JP,alive,42');
  });

  it('is just the header for no ports', () => {
    expect(exportCsv([], c)).toBe(CSV_HEADER.join(','));
  });
});

describe('sanitizeChecks', () => {
  it('keeps well-formed results and drops the rest', () => {
    expect(
      sanitizeChecks({
        a: { ok: true, latencyMs: 41.6 },
        b: { ok: false },
        c: { ok: 'yes' },
        d: { ok: true, latencyMs: -1 },
        e: null,
        f: { ok: true, latencyMs: Number.NaN },
      }),
    ).toEqual({ a: { ok: true, latencyMs: 42 }, b: { ok: false }, d: { ok: true }, f: { ok: true } });
    expect(sanitizeChecks(undefined)).toEqual({});
    expect(sanitizeChecks([{ ok: true }])).toEqual({});
  });
});
