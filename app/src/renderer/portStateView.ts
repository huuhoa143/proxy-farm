import type { TFunction } from 'i18next';
import type { FailReason, PortState, ProviderId } from '../shared/contracts';

export type StatusTone = 'neutral' | 'progress' | 'online' | 'warn' | 'bad';

export interface PortStateView {
  tone: StatusTone;
  label: string;
  /** Guidance copy shown under a failed/retrying row; undefined otherwise. */
  guidance?: string;
  /** Extra inline action label (e.g. "Move to another port") for some failure reasons. */
  actionLabel?: string;
  /** Present on `retrying`/`failed` states: seconds left until the next attempt. */
  countdownSeconds?: number;
}

function authGuidanceKey(providerId: ProviderId): string {
  if (providerId === 'hma') return 'portState.failed.auth.guidance.hma';
  if (providerId === 'zoogvpn') return 'portState.failed.auth.guidance.zoogvpn';
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
    default:
      return 'portState.failed.no-server.guidance';
  }
}

/** Map a contracts.PortState to copy + tone, pulling every string from i18n. */
export function describePortState(state: PortState, providerId: ProviderId, t: TFunction): PortStateView {
  const now = Date.now();
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
        guidance: t([`portState.reason.${state.reasonKey}`, state.reasonKey], { defaultValue: state.reasonKey }),
        countdownSeconds: seconds,
      };
    }
    case 'failed': {
      const seconds = Math.max(0, Math.round((state.untilMs - now) / 1000));
      return {
        tone: 'bad',
        label: t(reasonLabelKey(state.reason)),
        guidance: t(reasonGuidanceKey(state.reason, providerId)),
        actionLabel:
          state.reason === 'port-in-use' ? t('portState.failed.port-in-use.action') : undefined,
        countdownSeconds: seconds,
      };
    }
    case 'stopped':
      return { tone: 'neutral', label: t('portState.stopped') };
    default:
      return { tone: 'neutral', label: '' };
  }
}
