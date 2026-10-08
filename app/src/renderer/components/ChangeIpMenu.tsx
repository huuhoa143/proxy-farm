import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi, ServerHealth, ServerInfo } from '../../shared/contracts';
import { splitPortKey } from '../../shared/contracts';
import { Icon } from '../ui/Icon';
import type { StatusTone } from '../portStateView';

export interface ChangeIpMenuProps {
  row: PortRow;
  api: ProxyFarmApi;
  /** Every port row, to name the port holding a server (":29002"). */
  rows: readonly PortRow[];
  disabled?: boolean;
  /** A change for this port is in flight. */
  busy?: boolean;
  /** `toServer` undefined = let the controller pick the next free server. */
  onChange: (row: PortRow, toServer?: string) => void;
}

const HEALTH_TONE: Record<ServerHealth, StatusTone> = {
  ok: 'online',
  unknown: 'neutral',
  refused: 'bad',
  dead: 'warn',
};

/** Rough menu height used to decide whether to open upwards. */
const MENU_ESTIMATE_PX = 340;

type Placement = { top?: number; bottom?: number; right: number };

/**
 * "Change IP" split into a menu (spec §4.1, §6.5): a default "next free server"
 * action, then the location's servers with health and who holds each, so the
 * user can move the port to a specific one. Held / refused / dead servers stay
 * focusable but are aria-disabled with the reason as the item's description.
 * Keyboard: ↑/↓/Home/End move, Enter/Space pick, Esc/Tab close.
 */
export function ChangeIpMenu({ row, api, rows, disabled, busy, onChange }: ChangeIpMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ServerInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [place, setPlace] = useState<Placement>({ right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const n = splitPortKey(row.key)?.n;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  function items(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  }

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const right = Math.max(8, window.innerWidth - rect.right);
      const roomBelow = window.innerHeight - rect.bottom;
      setPlace(
        roomBelow < MENU_ESTIMATE_PX && rect.top > roomBelow
          ? { bottom: window.innerHeight - rect.top + 6, right }
          : { top: rect.bottom + 6, right },
      );
    }
    setServers(null);
    setFailed(false);
    setOpen(true);
  }

  // Fetch the pool each time the menu opens: holders and health change often.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    // Health for this port's own account: a server refused for another account is
    // still a valid pick here.
    api.listServers(row.locationKey, row.key).then(
      (list) => live && setServers(list),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, api, row.locationKey, row.key]);

  // Focus the default action as soon as the menu exists.
  useLayoutEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  // Click outside, window resize, or scrolling the page (the menu is fixed) closes it.
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    }
    function onScroll(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      close(false);
    }
    function onResize() {
      close(false);
    }
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = at < 0 ? 0 : (at + 1) % list.length;
        break;
      case 'ArrowUp':
        next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = list.length - 1;
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    list[next]?.focus();
  }

  function pick(toServer?: string) {
    close(true);
    onChange(row, toServer);
  }

  function holderPort(key: string): number | undefined {
    return rows.find((r) => r.key === key)?.proxyPort;
  }

  const freeCount = servers?.filter((s) => !s.heldBy && (s.health === 'ok' || s.health === 'unknown')).length;

  function describe(s: ServerInfo): { status: string; reason?: string; current: boolean } {
    const current = s.heldBy === row.key;
    if (current) return { status: t('main.changeIp.current'), reason: t('main.changeIp.reason.current'), current };
    if (s.heldBy) {
      const port = holderPort(s.heldBy);
      return port
        ? { status: t('main.changeIp.heldBy', { port }), reason: t('main.changeIp.reason.held', { port }), current }
        : { status: t('main.changeIp.heldByOther'), reason: t('main.changeIp.reason.heldOther'), current };
    }
    if (s.health === 'refused') {
      return { status: t('main.changeIp.health.refused'), reason: t('main.changeIp.reason.refused'), current };
    }
    if (s.health === 'dead') {
      return { status: t('main.changeIp.health.dead'), reason: t('main.changeIp.reason.dead'), current };
    }
    return { status: `${t('main.changeIp.free')} · ${t(`main.changeIp.health.${s.health}`)}`, current };
  }

  const label = n ? t('main.changeIp.menuLabel', { n }) : t('main.rotate');

  return (
    <>
      <button
        ref={triggerRef}
        className={`btn ghost sm cim-trigger${open ? ' is-open' : ''}`}
        title={(disabled ? t('main.rotateDisabledHint') : label) as string}
        aria-label={label as string}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || busy}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openMenu();
          }
        }}
        data-testid={`change-ip-${row.key}`}
      >
        <Icon name="rotate" className={busy ? 'spin' : undefined} />
        <span>{busy ? t('main.rotating') : t('main.rotate')}</span>
        <svg className="i caret" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="cim"
            role="menu"
            aria-label={label as string}
            style={{ top: place.top, bottom: place.bottom, right: place.right }}
            onKeyDown={onMenuKey}
            data-testid="change-ip-menu"
          >
            <button type="button" role="menuitem" tabIndex={-1} className="cim-next" onClick={() => pick()}>
              <span className="cim-ic">
                <Icon name="rotate" />
              </span>
              <span className="cim-tx">
                <b>{t('main.changeIp.next')}</b>
                <small>{freeCount === 0 ? t('main.changeIp.noneFreeHint') : t('main.changeIp.nextHint')}</small>
              </span>
            </button>
            <div className="cim-sep" role="separator" />
            <div role="group" aria-labelledby={`${menuId}-h`}>
              <div className="cim-h" id={`${menuId}-h`}>
                <span>{t('main.changeIp.heading', { city: row.city })}</span>
                {freeCount != null && <span className="cim-free">{t('main.group.free', { count: freeCount })}</span>}
              </div>
              {failed ? (
                <p className="cim-msg bad" role="alert">
                  {t('main.changeIp.loadFailed')}
                </p>
              ) : servers === null ? (
                <p className="cim-msg" role="status">
                  <span className="spinner" aria-hidden="true" />
                  {t('main.changeIp.loading')}
                </p>
              ) : servers.length === 0 ? (
                <p className="cim-msg">{t('main.changeIp.empty')}</p>
              ) : (
                <div className="cim-list">
                  {servers.map((s) => {
                    const { status, reason, current } = describe(s);
                    const blocked = Boolean(reason);
                    const ip = s.ip ?? s.server;
                    const descId = `${menuId}-${s.server}`;
                    return (
                      <button
                        key={s.server}
                        type="button"
                        role="menuitemradio"
                        aria-checked={current}
                        aria-disabled={blocked || undefined}
                        aria-label={`${ip} — ${status}`}
                        aria-describedby={reason ? descId : undefined}
                        tabIndex={-1}
                        title={reason ?? (t('main.changeIp.pick', { server: ip }) as string)}
                        className={`cim-srv h-${s.health}${current ? ' is-current' : ''}${blocked ? ' is-blocked' : ''}`}
                        onClick={() => {
                          if (!blocked) pick(s.server);
                        }}
                        data-testid={`server-${s.server}`}
                      >
                        <span className={`status-dot ${HEALTH_TONE[s.health]}`} aria-hidden="true" />
                        <span className="cim-ip">
                          <span className="mono">{ip}</span>
                          {s.ip && s.ip !== s.server && <small className="mono">{s.server}</small>}
                        </span>
                        <span className="cim-st">
                          {current && <Icon name="check" />}
                          {status}
                        </span>
                        {reason && (
                          <span id={descId} className="sr-only">
                            {reason}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
