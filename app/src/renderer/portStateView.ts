import type { TFunction } from 'i18next';
import { isTerminalFailure, type FailReason, type PortState, type ProviderId } from '../shared/contracts';
import { providerName } from './ui/providerName';

export type StatusTone = 'neutral' | 'progress' | 'online' | 'warn' | 'bad';

export interface PortStateView {
  tone: StatusTone;
  label: string;
  /** Guidance copy shown under a failed/retrying row; undefined otherwise. */
  guidance?: string;
  /** Extra inline action label (e.g. "Move to another port") for some failure reasons. */
  actionLabel?: string;
  /** Present on `retrying`/transient `failed` states: seconds left until the next attempt. */
  countdownSeconds?: number;
  /** A failure the user must act on (bad credentials / not in plan): retrying won't fix it,
   * so the UI shows an actionable message instead of a retry countdown. */
  terminal?: boolean;
}

/** Failures retrying can't fix — the user must change something (credentials, plan). */
export { isTerminalFailure };

function authGuidanceKey(providerId: ProviderId): string {
  if (providerId === 'hma') return 'portState.failed.auth.guidance.hma';
  if (providerId === 'zoogvpn') return 'portState.failed.auth.guidance.zoogvpn';
  if (providerId === 'expressvpn') return 'portState.failed.auth.guidance.expressvpn';
  return 'portState.failed.auth.guidance.generic';
}

function reasonLabelKey(reason: FailReason): string {
  switch (reason) {
    case 'auth':
      return 'portState.failed.auth.label';
    case 'not-in-plan':
      return 'portState.failed.not-in-plan.label';
    case 'port-in-use':
      return 'portState.failed.port-in-use.label';
    case 'no-server':
      return 'portState.failed.no-server.label';
    case 'key-rejected':
      return 'portState.failed.key-rejected.label';
    default:
      return 'portState.failed.no-server.label';
  }
}

function reasonGuidanceKey(reason: FailReason, providerId: ProviderId): string {
  switch (reason) {
    case 'auth':
      return authGuidanceKey(providerId);
    case 'not-in-plan':
      return 'portState.failed.not-in-plan.guidance';
    case 'port-in-use':
      return 'portState.failed.port-in-use.guidance';
    case 'no-server':
      return 'portState.failed.no-server.guidance';
    case 'key-rejected':
      if (providerId === 'surfshark' || providerId === 'nordvpn') return `portState.failed.key-rejected.guidance.${providerId}`;
      return 'portState.failed.key-rejected.guidance.generic';
    default:
      return 'portState.failed.no-server.guidance';
  }
}

export interface DescribePortStateOptions {
  /** True when ANOTHER port of the same account is currently online — i.e. the
   * credentials demonstrably work. An `auth` rejection on THIS port is then
   * location-specific (the server refused valid creds for that location), so the
   * copy points the user at trying another location rather than at their sign-in. */
  accountHasWorkingPeer?: boolean;
}

/** Map a contracts.PortState to copy + tone, pulling every string from i18n. */
export function describePortState(
  state: PortState,
  providerId: ProviderId,
  t: TFunction,
  opts: DescribePortStateOptions = {},
): PortStateView {
  const now = Date.now();
  // Copy that names the provider ("Your ZoogVPN plan doesn't include…").
  const provider = providerName(providerId, t);
  switch (state.kind) {
    case 'queued':
      return { tone: 'neutral', label: t('portState.queued') };
    case 'connecting':
      return { tone: 'progress', label: t('portState.connecting') };
    case 'verifying':
      return { tone: 'progress', label: t('portState.verifying') };
    case 'online':
      return { tone: 'online', label: t('portState.online') };
    case 'retrying': {
      const seconds = Math.max(0, Math.round((state.untilMs - now) / 1000));
      return {
        tone: 'warn',
        label: t('portState.retrying', { seconds }),
        // engine/controller reasons are bare keys ('unreachable'); older callers pass a full i18n key.
        guidance: t([`portState.reason.${state.reasonKey}`, state.reasonKey], { defaultValue: state.reasonKey, provider }),
        countdownSeconds: seconds,
      };
    }
    case 'failed': {
      const terminal = isTerminalFailure(state.reason);
      const seconds = Math.max(0, Math.round((state.untilMs - now) / 1000));
      // An auth rejection while the same account is online elsewhere is a
      // location-specific refusal, not bad credentials — say so, and steer the
      // user to another location instead of to their (working) sign-in.
      const locationRejected = state.reason === 'auth' && opts.accountHasWorkingPeer === true && state.detail === undefined;
      // What the app found out about the failure (spec §5.2), when it knows more than the reason.
      const detail = state.detail ? `portState.failed.detail.${state.detail}` : undefined;
      return {
        tone: 'bad',
        label: t(detail ? `${detail}.label` : locationRejected ? 'portState.failed.auth.labelLocation' : reasonLabelKey(state.reason), { provider }),
        guidance: t(
          detail ? `${detail}.guidance` : locationRejected ? 'portState.failed.auth.guidance.locationRejected' : reasonGuidanceKey(state.reason, providerId),
          { provider },
        ),
        actionLabel:
          state.reason === 'port-in-use' ? t('portState.failed.port-in-use.action') : undefined,
        // Terminal failures don't retry, so they carry no countdown.
        countdownSeconds: terminal ? undefined : seconds,
        terminal,
      };
    }
    case 'stopped':
      return { tone: 'neutral', label: t('portState.stopped') };
    default:
      return { tone: 'neutral', label: '' };
  }
}
