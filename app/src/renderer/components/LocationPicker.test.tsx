import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LocationPicker } from './LocationPicker';
import { initI18n } from '../i18n';
import type { Target } from '../../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

function target(key: string, city: string, servers: number, freeServers: number, providerId: Target['providerId'] = 'hma'): Target {
  return {
    key,
    providerId,
    country: 'JP',
    city,
    label: city,
    servers: Array.from({ length: servers }, (_, i) => `10.0.${servers}.${i}`),
    freeServers,
  };
}

const TOKYO = target('hma:JP-TOKYO', 'Tokyo', 6, 3);
const OSAKA = target('hma:JP-OSAKA', 'Osaka', 2, 0);
const KYOTO = target('surfshark:JP-KYO', 'Kyoto', 4, 4, 'surfshark');
const NAGOYA = target('hma:JP-NGO', 'Nagoya', 2, 2);

function renderPicker(props: Partial<Parameters<typeof LocationPicker>[0]> = {}) {
  const onSubmit = vi.fn();
  render(
    <LocationPicker
      targets={[TOKYO, OSAKA, KYOTO, NAGOYA]}
      portCounts={new Map([['hma:JP-TOKYO', 2]])}
      onSubmit={onSubmit}
      onClose={() => {}}
      {...props}
    />,
  );
  const row = (key: string) => screen.getByTestId(`pick-${key}`);
  return { onSubmit, row };
}

describe('LocationPicker', () => {
  it("shows each location's pool, free servers and existing ports", () => {
    const { row } = renderPicker();
    expect(row('hma:JP-TOKYO')).toHaveTextContent('6 servers · 3 free');
    expect(row('hma:JP-TOKYO')).toHaveTextContent('2 ports');
    expect(row('surfshark:JP-KYO')).toHaveTextContent('4 servers · 4 free');
  });

  it('disables a location with no free server', () => {
    const { row } = renderPicker();
    expect(row('hma:JP-OSAKA')).toHaveTextContent('No free server');
    expect(within(row('hma:JP-OSAKA')).getByRole('checkbox')).toBeDisabled();
  });

  it('a picked location gets a stepper: default 1, max = free servers', () => {
    const { row } = renderPicker();
    fireEvent.click(within(row('hma:JP-TOKYO')).getByRole('checkbox'));
    const stepper = within(row('hma:JP-TOKYO')).getByRole('group', { name: 'Ports in Tokyo' });
    const input = within(stepper).getByRole('spinbutton');
    const fewer = within(stepper).getByRole('button', { name: 'One port fewer in Tokyo' });
    const more = within(stepper).getByRole('button', { name: 'One more port in Tokyo' });
    expect(input).toHaveValue(1);
    expect(fewer).toBeDisabled();

    fireEvent.click(more);
    fireEvent.click(more);
    expect(input).toHaveValue(3);
    expect(more).toBeDisabled();
    expect(stepper).toHaveAttribute('title', 'Up to 3 — one per free server');

    // Typed values are clamped to 1…max.
    fireEvent.change(input, { target: { value: '99' } });
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: '0' } });
    expect(input).toHaveValue(1);
  });

  it("caps the picks by the provider's remaining port limit, across locations", () => {
    const { row } = renderPicker({ remaining: { hma: 3 } });
    fireEvent.click(within(row('hma:JP-TOKYO')).getByRole('checkbox'));
    const more = within(row('hma:JP-TOKYO')).getByRole('button', { name: 'One more port in Tokyo' });
    fireEvent.click(more);
    fireEvent.click(more);
    // Tokyo took all 3 HMA ports: Nagoya (HMA) is now unavailable, Kyoto (Surfshark) is not.
    expect(within(row('hma:JP-NGO')).getByRole('checkbox')).toBeDisabled();
    expect(row('hma:JP-NGO')).toHaveTextContent('Port limit reached');
    expect(within(row('surfshark:JP-KYO')).getByRole('checkbox')).toBeEnabled();
  });

  it('submits one request per picked location and counts ports in the button', () => {
    const { onSubmit, row } = renderPicker();
    fireEvent.click(within(row('hma:JP-TOKYO')).getByRole('checkbox'));
    fireEvent.click(within(row('hma:JP-TOKYO')).getByRole('button', { name: 'One more port in Tokyo' }));
    fireEvent.click(within(row('surfshark:JP-KYO')).getByRole('checkbox'));
    const submit = screen.getByTestId('picker-submit');
    expect(submit).toHaveTextContent('Add 3 ports');
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith([
      { locationKey: 'hma:JP-TOKYO', count: 2 },
      { locationKey: 'surfshark:JP-KYO', count: 1 },
    ]);
  });

  it('the country checkbox picks only locations that can take a port', () => {
    const { onSubmit } = renderPicker();
    fireEvent.click(screen.getByLabelText('Select every city in Japan'));
    fireEvent.click(screen.getByTestId('picker-submit'));
    const picked = onSubmit.mock.calls[0][0].map((r: { locationKey: string }) => r.locationKey).sort();
    expect(picked).toEqual(['hma:JP-NGO', 'hma:JP-TOKYO', 'surfshark:JP-KYO']);
  });
});
