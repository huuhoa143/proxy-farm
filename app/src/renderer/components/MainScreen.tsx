import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi, Target } from '../../shared/contracts';
import { HostVpnNote } from './HostVpnNote';
import { LocationPicker } from './LocationPicker';
import { PortTable } from './PortTable';
import { BulkActionBar } from './BulkActionBar';
import { ExportModal } from './ExportModal';

export interface MainScreenProps {
  api: ProxyFarmApi;
}

export function MainScreen({ api }: MainScreenProps) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<Target[]>([]);
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hostVpnActive, setHostVpnActive] = useState(false);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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

  async function handleRotate(row: PortRow) {
    await api.rotatePort(row.key);
    setPorts(await api.listPorts());
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
        />
      )}
      {copiedKey && <span data-testid="copied-toast">{t('main.copied')}</span>}
      <BulkActionBar
        count={selected.size}
        onStart={() => void handleStart(selectedKeys).then(() => setSelected(new Set()))}
        onStop={() => void api.stopPorts(selectedKeys).then(async () => setPorts(await api.listPorts()))}
        onRotate={() => void Promise.all(selectedKeys.map((k) => api.rotatePort(k))).then(async () => setPorts(await api.listPorts()))}
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
