import { describe, expect, it, vi } from 'vitest';
import { createSaveExport, exportFileName, MAX_EXPORT_BYTES } from './save-export';

const date = new Date(2026, 9, 9, 7, 5);

function setup(dialogResult: { canceled: boolean; filePath?: string } = { canceled: false, filePath: '/tmp/out.csv' }) {
  const showSaveDialog = vi.fn(async () => dialogResult);
  const writeFile = vi.fn(async () => {});
  const save = createSaveExport({ showSaveDialog, writeFile, defaultDir: '/Users/me/Downloads/', now: () => date });
  return { save, showSaveDialog, writeFile };
}

describe('save export to file', () => {
  it('names the file by date and format', () => {
    expect(exportFileName('csv', date)).toBe('proxy-farm-2026-10-09-0705.csv');
    expect(exportFileName('socks5Url', date)).toBe('proxy-farm-2026-10-09-0705.txt');
  });

  it('writes the text to the path the dialog returned, with a per-format filter', async () => {
    const { save, showSaveDialog, writeFile } = setup();
    expect(await save('a,b', 'csv')).toEqual({ saved: true, path: '/tmp/out.csv' });
    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultPath: '/Users/me/Downloads/proxy-farm-2026-10-09-0705.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    expect(writeFile).toHaveBeenCalledWith('/tmp/out.csv', 'a,b');

    await save('x', 'hostPort');
    expect(showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({ filters: [{ name: 'Text', extensions: ['txt'] }] }));
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const { save, writeFile } = setup({ canceled: true });
    expect(await save('x', 'csv')).toEqual({ saved: false });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('refuses non-string or oversized text without opening the dialog', async () => {
    const { save, showSaveDialog } = setup();
    expect(await save({ evil: true }, 'csv')).toMatchObject({ saved: false, error: expect.any(String) });
    expect(await save('x'.repeat(MAX_EXPORT_BYTES + 1), 'csv')).toMatchObject({ saved: false, error: expect.any(String) });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('reports a write failure instead of rejecting', async () => {
    const { save, writeFile } = setup();
    writeFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    expect(await save('x', 'csv')).toEqual({ saved: false, error: 'EACCES: permission denied' });
  });
});
