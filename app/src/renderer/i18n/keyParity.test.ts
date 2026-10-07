import { describe, expect, it } from 'vitest';
import en from './en.json';
import vi from './vi.json';

/** Recursively collect every leaf key path, e.g. "common.theme.light". */
function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') {
    return [prefix];
  }
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n key parity', () => {
  it('has the exact same keys in en.json and vi.json', () => {
    const enKeys = flattenKeys(en).sort();
    const viKeys = flattenKeys(vi).sort();

    const onlyInEn = enKeys.filter((k) => !viKeys.includes(k));
    const onlyInVi = viKeys.filter((k) => !enKeys.includes(k));

    expect(onlyInEn, `keys present in en.json but missing from vi.json: ${onlyInEn.join(', ')}`).toEqual([]);
    expect(onlyInVi, `keys present in vi.json but missing from en.json: ${onlyInVi.join(', ')}`).toEqual([]);
  });

  it('has no empty string values in either file', () => {
    const emptyEn = flattenKeys(en).filter((k) => getPath(en, k) === '');
    const emptyVi = flattenKeys(vi).filter((k) => getPath(vi, k) === '');
    expect(emptyEn).toEqual([]);
    expect(emptyVi).toEqual([]);
  });
});

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
