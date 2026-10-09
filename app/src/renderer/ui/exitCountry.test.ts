import { describe, expect, it } from 'vitest';
import { exitCountry } from './exitCountry';

describe('exitCountry', () => {
  it("tags the exit with the location's country, with the geolocation as a hint when they disagree", () => {
    // NordVPN Vietnam (a virtual location) whose exit ifconfig.co places in Brazil.
    expect(exitCountry('VN', 'BR')).toEqual({ tag: 'VN', geo: 'BR' });
    // HMA Vienna, which ifconfig.co placed in GB.
    expect(exitCountry('AT', 'GB')).toEqual({ tag: 'AT', geo: 'GB' });
  });

  it('no hint when the geolocation agrees or is unknown', () => {
    expect(exitCountry('JP', 'JP')).toEqual({ tag: 'JP' });
    expect(exitCountry('JP', 'unknown')).toEqual({ tag: 'JP' });
    expect(exitCountry('jp', 'jp')).toEqual({ tag: 'JP' });
  });

  it('without a location country (an imported file), falls back to the geolocation', () => {
    expect(exitCountry('', 'DE')).toEqual({ tag: 'DE' });
    expect(exitCountry('', 'unknown')).toEqual({});
  });
});
