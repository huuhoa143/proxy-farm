import { describe, expect, it } from 'vitest';
import { LogRing, redactLine } from './log-ring';

describe('redactLine', () => {
  it('redacts a username= value', () => {
    expect(redactLine('auth attempt username=alice password=hunter2')).toBe('auth attempt username=[redacted] password=[redacted]');
  });

  it('redacts quoted username/password values', () => {
    expect(redactLine('login with username="bob smith" password="p@ss word"')).toBe(
      'login with username=[redacted] password=[redacted]',
    );
  });

  it('redacts a 64-hex token', () => {
    const hex64 = 'a'.repeat(64);
    expect(redactLine(`bearer token=${hex64} ok`)).toBe('bearer token=[redacted] ok');
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
