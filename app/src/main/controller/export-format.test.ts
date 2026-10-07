import { describe, expect, it } from 'vitest';
import { exportLines, formatProxy } from './export-format';

describe('export formats (spec §4.2, 4 v1 formats)', () => {
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
