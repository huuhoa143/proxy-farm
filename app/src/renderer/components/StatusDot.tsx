import type { StatusTone } from '../portStateView';

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span className={`status-dot ${tone}`} data-testid="status-dot" data-tone={tone} />;
}
