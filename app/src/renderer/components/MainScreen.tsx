import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi, RotateResult, Target } from '../../shared/contracts';
import { HostVpnNote } from './HostVpnNote';
import { LocationPicker } from './LocationPicker';
import { PortTable } from './PortTable';
import { BulkActionBar } from './BulkActionBar';
import { ExportModal } from './ExportModal';
import { StatRail } from './StatRail';
import { CredentialsChip } from './CredentialsChip';
import { Icon } from '../ui/Icon';
import { useKeyedTimeouts } from '../ui/useKeyedTimeouts';

export interface MainScreenProps {
  api: ProxyFarmApi;
}

const NOTE_MS = 6000;
const COPIED_MS = 1500;

function removeKey(record: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function MainScreen({ api }: MainScreenProps) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<Target[]>([]);
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hostVpnActive, setHostVpnActive] = useState(false);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [rotateNotes, setRotateNotes] = useState<Record<string, string>>({});
  const [bulkRotateSummary, setBulkRotateSummary] = useState<string | null>(null);
  const schedule = useKeyedTimeouts();

  useEffect(() => {
    void api.listTargets().then(setTargets);
    void api.listPorts().then((rows) => {
      setPorts(rows);
      setLoaded(true);
    });
    void api.getHostVpnActive().then(setHostVpnActive);
    const offPorts = api.onPortsChanged(setPorts);
    const offVpn = api.onHostVpnChanged(setHostVpnActive);
    return () => {
      offPorts();
      offVpn();
    };
  }, [api]);

  const runningKeys = useMemo(() => new Set(ports.map((p) => p.key)), [ports]);

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
    schedule('copied', () => setCopiedKey(null), COPIED_MS);
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
      schedule(`rotate:${row.key}`, () => setRotateNotes((prev) => removeKey(prev, row.key)), NOTE_MS);
    }
  }

  async function handleBulkRotate(keys: string[]) {
    const results = await Promise.all(keys.map((k) => api.rotatePort(k)));
    setPorts(await api.listPorts());
    const changed = results.filter((r) => r.changed && r.noteKey !== 'main.rotateResult.sameCityNote').length;
    const moved = results.filter((r) => r.changed && r.noteKey === 'main.rotateResult.sameCityNote').length;
    const unavailable = results.filter((r) => !r.changed).length;
    setBulkRotateSummary(t('main.bulk.rotateSummary', { changed, moved, unavailable }));
    schedule('bulk-rotate', () => setBulkRotateSummary(null), NOTE_MS);
  }

  async function handleMovePort(row: PortRow) {
    await api.stopPorts([row.key]);
    await api.startPorts([row.key]);
    setPorts(await api.listPorts());
  }

  const closePicker = useCallback(() => setPicking(false), []);
  const closeExport = useCallback(() => setExporting(null), []);
  const selectedKeys = Array.from(selected);

  return (
    <div className="screen" data-testid="main-screen">
      <HostVpnNote active={hostVpnActive} />
      <StatRail rows={ports} />
      <div className="toolbar">
        <CredentialsChip api={api} />
        <span className="sp" />
        {ports.length > 0 && (
          <button className="btn ghost" onClick={() => setExporting(ports.map((p) => p.key))}>
            <Icon name="export" />
            {t('main.exportAll')}
          </button>
        )}
        <button className="btn primary" onClick={() => setPicking(true)}>
          <Icon name="plus" />
          {t('main.addLocations')}
        </button>
      </div>
      <BulkActionBar
        count={selected.size}
        onStart={() => void handleStart(selectedKeys).then(() => setSelected(new Set()))}
        onStop={() => void api.stopPorts(selectedKeys).then(async () => setPorts(await api.listPorts()))}
        onRotate={() => void handleBulkRotate(selectedKeys)}
        onRemove={() =>
          void api
            .removePorts(selectedKeys)
            .then(async () => setPorts(await api.listPorts()))
            .then(() => setSelected(new Set()))
        }
        onExport={() => setExporting(selectedKeys)}
        onClear={() => setSelected(new Set())}
      />
      {bulkRotateSummary && (
        <div className="banner" data-testid="bulk-rotate-summary" role="status">
          <Icon name="rotate" />
          {bulkRotateSummary}
        </div>
      )}
      {ports.length === 0 ? (
        loaded && (
          <div className="empty">
            <div className="glyph">
              <Icon name="globe" />
            </div>
            <h2>{t('main.emptyTitle')}</h2>
            <p>{t('main.emptyState')}</p>
            <button className="btn primary" onClick={() => setPicking(true)}>
              <Icon name="plus" />
              {t('main.addLocations')}
            </button>
          </div>
        )
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
          copiedKey={copiedKey}
        />
      )}
      {copiedKey && (
        <div className="toast" data-testid="copied-toast" role="status">
          <Icon name="check" />
          {t('main.copied')}
        </div>
      )}
      {picking && (
        <LocationPicker
          targets={targets}
          runningKeys={runningKeys}
          onClose={closePicker}
          onStart={(keys) => {
            setPicking(false);
            void handleStart(keys);
          }}
        />
      )}
      {exporting && <ExportModal api={api} targetKeys={exporting} onClose={closeExport} />}
    </div>
  );
}
