import path from 'node:path';
import type { ExportFormat, SaveExportResult } from '../../shared/contracts';

/** The slice of Electron's `dialog.showSaveDialog` this needs (bound to the main window). */
export type ShowSaveDialog = (options: {
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}) => Promise<{ canceled: boolean; filePath?: string }>;

export interface SaveExportDeps {
  showSaveDialog: ShowSaveDialog;
  writeFile(path: string, text: string): Promise<void>;
  /** Folder the dialog opens in (Downloads). */
  defaultDir: string;
  now?: () => Date;
}

/** Larger than any real export (thousands of ports); refuses anything absurd from IPC. */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

const pad = (n: number) => String(n).padStart(2, '0');

/** `proxy-farm-<yyyy-mm-dd-hhmm>.<txt|csv>`, in local time. */
export function exportFileName(format: ExportFormat, date: Date): string {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `proxy-farm-${stamp}.${format === 'csv' ? 'csv' : 'txt'}`;
}

/**
 * "Save to file…" in the Export modal (spec §4.2): the native save dialog picks the
 * path — the renderer never names one — and the text the renderer shows is written
 * there as is. Never rejects: a failure comes back as `error` for the modal to show.
 */
export function createSaveExport(deps: SaveExportDeps): (text: unknown, format: unknown) => Promise<SaveExportResult> {
  const now = deps.now ?? (() => new Date());
  return async (text, format) => {
    if (typeof text !== 'string') return { saved: false, error: 'invalid text' };
    if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_BYTES) return { saved: false, error: 'export too large' };
    const csv = format === 'csv';
    const defaultPath = path.join(deps.defaultDir, exportFileName(csv ? 'csv' : 'hostPort', now()));
    const filters = csv ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'Text', extensions: ['txt'] }];
    try {
      const { canceled, filePath } = await deps.showSaveDialog({ defaultPath, filters });
      if (canceled || !filePath) return { saved: false };
      await deps.writeFile(filePath, text);
      return { saved: true, path: filePath };
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
