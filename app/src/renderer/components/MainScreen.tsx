import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProviderId, ProxyFarmApi, RotateResult, Target } from '../../shared/contracts';
import { HostVpnNote } from './HostVpnNote';
import { LocationPicker, type PortRequest } from './LocationPicker';
import { PortTable } from './PortTable';
import { BulkActionBar } from './BulkActionBar';
import { ExportModal } from './ExportModal';
import { ConfirmDialog } from './ConfirmDialog';
import { StatRail } from './StatRail';
import { CredentialsChip } from './CredentialsChip';
import { Icon } from '../ui/Icon';
import { useKeyedTimeouts } from '../ui/useKeyedTimeouts';
import { providerName } from '../ui/providerName';
import { remainingByProvider } from '../portGroups';

export interface MainScreenProps {
  api: ProxyFarmApi;
}

const NOTE_MS = 6000;
const SAME_CITY_NOTE = 'main.rotateResult.sameCityNote';
const COPIED_MS = 1500;
/** Coalesces the target re-reads a burst of port changes triggers into one. */
const TARGETS_REFRESH_MS = 250;

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
  const [copyError, setCopyError] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);
  const [rotateNotes, setRotateNotes] = useState<Record<string, string>>({});
  const [bulkRotateSummary, setBulkRotateSummary] = useState<string | null>(null);
  const [limits, setLimits] = useState<Partial<Record<ProviderId, number>>>({});
  const [rotating, setRotating] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const schedule = useKeyedTimeouts();

  // Only the newest `listTargets` answer is applied: one read while a change is still
  // in flight must not land after (and overwrite) the read that follows it.
  const targetsRead = useRef(0);
  const loadTargets = useCallback(() => {
    const read = ++targetsRead.current;
    void api.listTargets().then((next) => {
      if (read === targetsRead.current) setTargets(next);
    });
  }, [api]);
  /** Re-reads the locations' free-server counts once the current burst of changes settles. */
  const refreshTargets = useCallback(() => schedule('targets', loadTargets, TARGETS_REFRESH_MS), [schedule, loadTargets]);

  useEffect(() => {
    loadTargets();
    void api.listPorts().then((rows) => {
      setPorts(rows);
      setLoaded(true);
    });
    void api.getHostVpnActive().then(setHostVpnActive);
    void api.listProviders().then((providers) =>
      setLimits(Object.fromEntries(providers.map((p) => [p.id, p.limit ?? 0])) as Partial<Record<ProviderId, number>>),
    );
    const offPorts = api.onPortsChanged(setPorts);
    const offVpn = api.onHostVpnChanged(setHostVpnActive);
    return () => {
      offPorts();
      offVpn();
    };
  }, [api, loadTargets]);

  // A location's free-server count changes whenever a port takes or releases a
  // server, so re-read the targets when the set of (port, server) pairs changes
  // — not on every state tick. The handlers below also re-read once their call
  // resolves: a change pushed while a Change IP is still in flight may be read
  // before the main process has settled the pool.
  const pinSignature = useMemo(
    () =>
      ports
        .map((p) => `${p.key}=${p.server ?? ''}:${p.enabled ? 1 : 0}`)
        .sort()
        .join('|'),
    [ports],
  );
  useEffect(() => {
    if (!loaded) return;
    refreshTargets();
  }, [refreshTargets, pinSignature, loaded]);

  const portCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of ports) counts.set(p.locationKey, (counts.get(p.locationKey) ?? 0) + 1);
    return counts;
  }, [ports]);
  const remaining = useMemo(() => remainingByProvider(ports, limits), [ports, limits]);

  function showNotice(text: string) {
    setNotice(text);
    schedule('notice', () => setNotice(null), NOTE_MS);
  }

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectGroup(keys: string[], select: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (select) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === ports.length ? new Set() : new Set(ports.map((p) => p.key))));
  }

  async function handleStart(keys: string[]) {
    await api.startPorts(keys);
    setPorts(await api.listPorts());
    refreshTargets();
  }

  function locationName(locationKey: string): string {
    return targets.find((t) => t.key === locationKey)?.city ?? locationKey;
  }

  /** Add ports per location (spec §6.8); say so when fewer than asked could be added. */
  async function handleAddPorts(requests: PortRequest[]) {
    const notes: string[] = [];
    for (const { locationKey, count } of requests) {
      const result = await api.addPorts(locationKey, count);
      if (result.added.length >= count) continue;
      const target = targets.find((t) => t.key === locationKey);
      const vars = {
        added: result.added.length,
        // `count` (= ports asked for) selects the plural form: "1 port" / "2 ports".
        count,
        location: locationName(locationKey),
        provider: target ? providerName(target.providerId, t) : '',
      };
      notes.push(
        result.noteKey === 'no-free-server' || result.noteKey === 'limit-reached'
          ? t(`main.addResult.${result.noteKey}`, vars)
          : t('main.addResult.generic', vars),
      );
    }
    setPorts(await api.listPorts());
    refreshTargets();
    if (notes.length) showNotice(notes.join(' '));
  }

  async function handleCopy(row: PortRow) {
    // Proxy auth is mandatory, so copy the authenticated host:port:user:pass
    // form (the Export modal's default) — a bare host:port never authenticates.
    const text = await api.exportPorts([row.key], 'hostPortUserPass');
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyError(false);
      setCopiedKey(row.key);
      schedule('copied', () => setCopiedKey(null), COPIED_MS);
    } catch {
      // Clipboard blocked (no permission / non-secure context): surface it and
      // fall back to the Export modal, whose textarea can be selected by hand.
      setCopiedKey(null);
      setCopyError(true);
      schedule('copy-error', () => setCopyError(false), NOTE_MS);
      setExporting([row.key]);
    }
  }

  async function handleStop(keys: string[]) {
    await api.stopPorts(keys);
    setPorts(await api.listPorts());
    refreshTargets();
  }

  async function handleRemove(keys: string[]) {
    await api.removePorts(keys);
    setPorts(await api.listPorts());
    refreshTargets();
    // A later port may reuse the key: it must not inherit a lasting move note.
    setRotateNotes((prev) => keys.reduce(removeKey, prev));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
  }

  function describeRotateResult(result: RotateResult): string | undefined {
    // A move to another city is always said, whether or not the new IP was confirmed.
    if (result.movedTo) return t('main.rotateResult.movedToCityNote', { city: result.movedTo });
    if (result.noteKey === SAME_CITY_NOTE) return t(SAME_CITY_NOTE);
    if (result.changed) {
      return t('main.rotateResult.changedNote', { from: result.from, to: result.to });
    }
    if (result.noteKey) {
      return t(result.noteKey, { defaultValue: result.noteKey });
    }
    return undefined;
  }

  async function handleRotate(row: PortRow, toServer?: string) {
    // Captured up front: a port moved to another city comes back under a new key.
    const key = row.key;
    const fromCity = row.city;
    setRotating((prev) => new Set(prev).add(key));
    let result: RotateResult;
    try {
      result = await api.rotatePort(key, toServer);
    } finally {
      setRotating((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      refreshTargets();
    }
    const rows = await api.listPorts();
    setPorts(rows);
    const note = describeRotateResult(result);
    if (!note) return;
    // A port moved to another city gets that location's key and group: announce
    // it, and leave a lasting note on the moved row (found by its proxy port,
    // which a move keeps) so the move is still visible once the toast is gone.
    if (!rows.some((r) => r.key === key)) {
      showNotice(note);
      const moved = rows.find((r) => r.proxyPort === row.proxyPort);
      if (moved) {
        const movedNote = t('main.rotateResult.movedFromToNote', { from: fromCity, to: result.movedTo ?? moved.city });
        setRotateNotes((prev) => ({ ...removeKey(prev, key), [moved.key]: movedNote }));
      }
      return;
    }
    setRotateNotes((prev) => ({ ...prev, [key]: note }));
    schedule(`rotate:${key}`, () => setRotateNotes((prev) => removeKey(prev, key)), NOTE_MS);
  }

  async function handleBulkRotate(keys: string[]) {
    // One at a time: each change takes a free server, so the next one must see it taken.
    const results: RotateResult[] = [];
    try {
      for (const key of keys) results.push(await api.rotatePort(key));
    } finally {
      refreshTargets();
    }
    const rows = await api.listPorts();
    setPorts(rows);
    // Ports that moved city changed key; drop the stale keys from the selection.
    const live = new Set(rows.map((r) => r.key));
    setSelected((prev) => new Set(Array.from(prev).filter((k) => live.has(k))));
    const movedCity = (r: RotateResult) => Boolean(r.movedTo) || r.noteKey === SAME_CITY_NOTE;
    const changed = results.filter((r) => r.changed && !movedCity(r)).length;
    const moved = results.filter(movedCity).length;
    const unavailable = results.filter((r) => !r.changed && !movedCity(r)).length;
    setBulkRotateSummary(t('main.bulk.rotateSummary', { changed, moved, unavailable }));
    schedule('bulk-rotate', () => setBulkRotateSummary(null), NOTE_MS);
  }

  async function handleMovePort(row: PortRow) {
    await api.stopPorts([row.key]);
    await api.startPorts([row.key]);
    setPorts(await api.listPorts());
    refreshTargets();
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
        onStop={() => void handleStop(selectedKeys)}
        onRotate={() => void handleBulkRotate(selectedKeys)}
        onRemove={() => setConfirmRemove(selectedKeys)}
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
          targets={targets}
          limits={limits}
          selectedKeys={selected}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onSelectGroup={selectGroup}
          onAddPort={(locationKey) => void handleAddPorts([{ locationKey, count: 1 }])}
          rotatingKeys={rotating}
          onCopy={handleCopy}
          onRotate={(row, toServer) => void handleRotate(row, toServer)}
          onStop={(row) => void handleStop([row.key])}
          onRemove={(row) => setConfirmRemove([row.key])}
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
      {notice && (
        <div className="toast" data-testid="notice-toast" role="status">
          <Icon name="info" />
          {notice}
        </div>
      )}
      {copyError && (
        <div className="toast bad" data-testid="copy-error-toast" role="alert">
          <Icon name="alert" />
          {t('main.copyFailed')}
        </div>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={t('main.confirmRemove.title')}
          message={t('main.confirmRemove.message', { count: confirmRemove.length })}
          confirmLabel={t('main.bulk.remove')}
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const keys = confirmRemove;
            setConfirmRemove(null);
            void handleRemove(keys);
          }}
        />
      )}
      {picking && (
        <LocationPicker
          targets={targets}
          portCounts={portCounts}
          remaining={remaining}
          onClose={closePicker}
          onSubmit={(requests) => {
            setPicking(false);
            void handleAddPorts(requests);
          }}
        />
      )}
      {exporting && <ExportModal api={api} targetKeys={exporting} onClose={closeExport} />}
    </div>
  );
}
