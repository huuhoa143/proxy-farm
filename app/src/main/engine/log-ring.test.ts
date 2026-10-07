import { describe, expect, it } from 'vitest';
import { LogRing, redactLine } from './log-ring';

describe('redactLine', () => {
  it('redacts a username= value', () => {
    expect(redactLine('auth attempt username=alice password=hunter2')).toBe('auth attempt username=[redacted] password=[redacted]');
  });

  it('redacts quoted username/password values, re-quoting the redaction', () => {
    expect(redactLine('login with username="bob smith" password="p@ss word"')).toBe(
      'login with username="[redacted]" password="[redacted]"',
    );
  });

  it('redacts a 64-hex token', () => {
    const hex64 = 'a'.repeat(64);
    expect(redactLine(`bearer token=${hex64} ok`)).toBe('bearer token=[redacted] ok');
  });

  it('redacts a hex run longer than 64 chars as a single match (no partial redaction)', () => {
    const hex70 = 'b'.repeat(70);
    const line = `blob=${hex70} end`;
    const out = redactLine(line);
    expect(out).toBe('blob=[redacted] end');
    expect(out).not.toContain('b'.repeat(64));
  });

  it('does not touch an unrelated shorter hex string', () => {
    const hex32 = 'b'.repeat(32);
    const line = `request id=${hex32}`;
    expect(redactLine(line)).toBe(line);
  });

  it('leaves lines with no secrets untouched', () => {
    const line = 'INFO endpoint/openvpn-client[ep]: tunnel established to 5.62.19.134:1194 over udp';
    expect(redactLine(line)).toBe(line);
  });

  it('is case-insensitive on the field name', () => {
    expect(redactLine('Username=alice Password=hunter2')).toBe('Username=[redacted] Password=[redacted]');
  });

  it('strips ANSI escape codes before redacting', () => {
    const line = '\x1b[32mINFO\x1b[0m username=\x1b[31malice\x1b[0m';
    expect(redactLine(line)).toBe('INFO username=[redacted]');
  });

  it('redacts a quoted JSON field for each sensitive key', () => {
    const line = '{"username":"alice","password":"hunter2","private_key":"AAAA...","pre_shared_key":"BBBB...","secret":"s3kr3t"}';
    expect(redactLine(line)).toBe(
      '{"username":"[redacted]","password":"[redacted]","private_key":"[redacted]","pre_shared_key":"[redacted]","secret":"[redacted]"}',
    );
  });

  it('redacts a "key: value" colon form for each sensitive key', () => {
    expect(redactLine('private_key: AAAABBBBCCCC')).toBe('private_key: [redacted]');
    expect(redactLine('pre_shared_key: DDDDEEEEFFFF')).toBe('pre_shared_key: [redacted]');
    expect(redactLine('secret: topsecret')).toBe('secret: [redacted]');
  });

  it('redacts user:pass@ URL userinfo', () => {
    expect(redactLine('connecting to socks5h://alice:S3cr3t@127.0.0.1:1080')).toBe(
      'connecting to socks5h://[redacted]@127.0.0.1:1080',
    );
  });

  it('does not touch a bare host:port with no @ (not userinfo)', () => {
    const line = 'dial tcp 127.0.0.1:1080';
    expect(redactLine(line)).toBe(line);
  });

  it('does not redact an unrelated key that merely contains a sensitive key as a substring', () => {
    const line = 'password_hash_old=deadbeef';
    expect(redactLine(line)).toBe(line);
  });
});

describe('LogRing', () => {
  it('stores redacted lines, not raw ones', () => {
    const ring = new LogRing(10);
    ring.push('username=alice password=hunter2');
    expect(ring.lines).toEqual(['username=[redacted] password=[redacted]']);
  });

  it('never contains the raw secret string anywhere in its lines', () => {
    const ring = new LogRing(10);
    ring.push('connecting username=svc-acct password=Tr0ub4dor&3 now');
    expect(ring.lines.join('\n')).not.toContain('Tr0ub4dor&3');
    expect(ring.lines.join('\n')).not.toContain('svc-acct');
  });

  it('is a fixed-size ring: oldest lines drop once capacity is exceeded', () => {
    const ring = new LogRing(3);
    ring.push('a');
    ring.push('b');
    ring.push('c');
    ring.push('d');
    expect(ring.lines).toEqual(['b', 'c', 'd']);
  });

  it('keeps insertion order', () => {
    const ring = new LogRing(5);
    ['1', '2', '3'].forEach((l) => ring.push(l));
    expect(ring.lines).toEqual(['1', '2', '3']);
  });
});
