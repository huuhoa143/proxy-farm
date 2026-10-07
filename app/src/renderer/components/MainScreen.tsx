import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi, RotateResult, Target } from '../../shared/contracts';
import { HostVpnNote } from './HostVpnNote';
import { LocationPicker } from './LocationPicker';
import { PortTable } from './PortTable';
import { BulkActionBar } from './BulkActionBar';
import { ExportModal } from './ExportModal';

export interface MainScreenProps {
  api: ProxyFarmApi;
}

function removeKey(record: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function MainScreen({ api }: MainScreenProps) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<Target[]>([]);
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hostVpnActive, setHostVpnActive] = useState(false);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [rotateNotes, setRotateNotes] = useState<Record<string, string>>({});
  const [bulkRotateSummary, setBulkRotateSummary] = useState<string | null>(null);

  useEffect(() => {
    void api.listTargets().then(setTargets);
    void api.listPorts().then(setPorts);
    void api.getHostVpnActive().then(setHostVpnActive);
    const offPorts = api.onPortsChanged(setPorts);
    const offVpn = api.onHostVpnChanged(setHostVpnActive);
    return () => {
      offPorts();
      offVpn();
    };
  }, [api]);

  const untargetedCountries = useMemo(() => targets, [targets]);

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === ports.length ? new Set() : new Set(ports.map((p) => p.key))));
  }

  async function handleStart(keys: string[]) {
    await api.startPorts(keys);
    setPorts(await api.listPorts());
  }

  async function handleCopy(row: PortRow) {
    const text = await api.exportPorts([row.key], 'hostPort');
    await navigator.clipboard?.writeText(text);
    setCopiedKey(row.key);
    setTimeout(() => setCopiedKey((k) => (k === row.key ? null : k)), 1500);
  }

  function describeRotateResult(result: RotateResult): string | undefined {
    if (result.changed) {
      if (result.noteKey === 'main.rotateResult.sameCityNote') {
        return t('main.rotateResult.sameCityNote');
      }
      return t('main.rotateResult.changedNote', { from: result.from, to: result.to });
    }
    if (result.noteKey) {
      return t(result.noteKey, { defaultValue: result.noteKey });
    }
    return undefined;
  }

  async function handleRotate(row: PortRow) {
    const result = await api.rotatePort(row.key);
    setPorts(await api.listPorts());
    const note = describeRotateResult(result);
    if (note) {
      setRotateNotes((prev) => ({ ...prev, [row.key]: note }));
      setTimeout(() => setRotateNotes((prev) => removeKey(prev, row.key)), 6000);
    }
  }

  async function handleMovePort(row: PortRow) {
    await api.stopPorts([row.key]);
    await api.startPorts([row.key]);
    setPorts(await api.listPorts());
  }

  const selectedKeys = Array.from(selected);

  return (
    <div data-testid="main-screen">
      <HostVpnNote active={hostVpnActive} />
      <LocationPicker targets={untargetedCountries} onStart={handleStart} />
      {ports.length === 0 ? (
        <p>{t('main.emptyState')}</p>
      ) : (
        <PortTable
          rows={ports}
          selectedKeys={selected}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onCopy={handleCopy}
          onRotate={handleRotate}
          onMovePort={handleMovePort}
          api={api}
          notes={rotateNotes}
        />
      )}
      {copiedKey && <span data-testid="copied-toast">{t('main.copied')}</span>}
      {bulkRotateSummary && <div data-testid="bulk-rotate-summary">{bulkRotateSummary}</div>}
      <BulkActionBar
        count={selected.size}
        onStart={() => void handleStart(selectedKeys).then(() => setSelected(new Set()))}
        onStop={() => void api.stopPorts(selectedKeys).then(async () => setPorts(await api.listPorts()))}
        onRotate={() =>
          void Promise.all(selectedKeys.map((k) => api.rotatePort(k))).then(async (results) => {
            setPorts(await api.listPorts());
            const changed = results.filter((r) => r.changed && r.noteKey !== 'main.rotateResult.sameCityNote').length;
            const moved = results.filter((r) => r.changed && r.noteKey === 'main.rotateResult.sameCityNote').length;
            const unavailable = results.filter((r) => !r.changed).length;
            setBulkRotateSummary(t('main.bulk.rotateSummary', { changed, moved, unavailable }));
            setTimeout(() => setBulkRotateSummary(null), 6000);
          })
        }
        onRemove={() =>
          void api
            .removePorts(selectedKeys)
            .then(async () => setPorts(await api.listPorts()))
            .then(() => setSelected(new Set()))
        }
        onExport={() => setExporting(selectedKeys)}
        onClear={() => setSelected(new Set())}
      />
      {exporting && <ExportModal api={api} targetKeys={exporting} onClose={() => setExporting(null)} />}
    </div>
  );
}
