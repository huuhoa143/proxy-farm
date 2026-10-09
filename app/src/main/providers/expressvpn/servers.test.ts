import { describe, expect, it } from 'vitest';
import { expressLocationKey, groupLocations, loadServers, type ExpressServer } from './servers';

const xs = (host: string, country: string, countryName: string, city = '', via?: string): ExpressServer => ({
  host,
  country,
  countryName,
  city,
  ...(via ? { via } : {}),
});

describe('expressvpn servers: the bundled catalog', () => {
  const servers = loadServers();

  it('lists every hostname of the gluetun catalog, each in the ExpressVPN domain', () => {
    expect(servers).toHaveLength(160);
    for (const s of servers) {
      expect(s.host).toMatch(/^[a-z0-9-]+-ca-version-2\.expressnetw\.com$/);
      expect(s.country).toMatch(/^[A-Z]{2}$/);
    }
    expect(new Set(servers.map((s) => s.host)).size).toBe(servers.length);
  });

  it('names Vietnam, the UK and the USA by their ISO codes', () => {
    expect(servers.find((s) => s.host === 'vietnam-ca-version-2.expressnetw.com')).toMatchObject({ country: 'VN', city: '' });
    expect(servers.find((s) => s.host === 'uk-london-ca-version-2.expressnetw.com')).toMatchObject({ country: 'GB', city: 'London' });
    expect(servers.find((s) => s.host === 'usa-newyork-ca-version-2.expressnetw.com')).toMatchObject({ country: 'US', city: 'New York' });
  });

  it('keeps where a "via" location really stands', () => {
    expect(servers.find((s) => s.host === 'india-sg-ca-version-2.expressnetw.com')).toMatchObject({ country: 'IN', via: 'Singapore' });
    expect(servers.find((s) => s.host === 'ph-via-sing-ca-version-2.expressnetw.com')).toMatchObject({ country: 'PH', via: 'Singapore' });
  });

  it('groups into one location per country, city and "via"', () => {
    const targets = groupLocations(servers);
    expect(targets).toHaveLength(145);
    expect(new Set(targets.map((t) => t.key)).size).toBe(targets.length);
  });
});

describe('expressvpn servers: location keys and grouping', () => {
  it('keys a country-wide location by its country, a city by country and city', () => {
    expect(expressLocationKey(xs('vietnam-ca-version-2.expressnetw.com', 'VN', 'Vietnam'))).toBe('expressvpn:VN');
    expect(expressLocationKey(xs('usa-newyork-ca-version-2.expressnetw.com', 'US', 'USA', 'New York'))).toBe('expressvpn:US-NEW-YORK');
    expect(expressLocationKey(xs('india-uk-ca-version-2.expressnetw.com', 'IN', 'India', '', 'UK'))).toBe('expressvpn:IN-VIA-UK');
  });

  it('pools the hostnames of one location, in catalog order', () => {
    const targets = groupLocations([
      xs('usa-losangeles-2-ca-version-2.expressnetw.com', 'US', 'USA', 'Los Angeles'),
      xs('vietnam-ca-version-2.expressnetw.com', 'VN', 'Vietnam'),
      xs('usa-losangeles-ca-version-2.expressnetw.com', 'US', 'USA', 'Los Angeles'),
    ]);
    expect(targets).toEqual([
      {
        key: 'expressvpn:US-LOS-ANGELES',
        providerId: 'expressvpn',
        country: 'US',
        city: 'Los Angeles',
        label: 'USA — Los Angeles',
        servers: ['usa-losangeles-2-ca-version-2.expressnetw.com', 'usa-losangeles-ca-version-2.expressnetw.com'],
      },
      {
        key: 'expressvpn:VN',
        providerId: 'expressvpn',
        country: 'VN',
        city: 'Vietnam',
        label: 'Vietnam',
        countryWide: true,
        servers: ['vietnam-ca-version-2.expressnetw.com'],
      },
    ]);
  });

  it('marks a "via" location virtual and says where it stands', () => {
    const [target] = groupLocations([xs('india-sg-ca-version-2.expressnetw.com', 'IN', 'India', '', 'Singapore')]);
    expect(target).toMatchObject({ key: 'expressvpn:IN-VIA-SINGAPORE', country: 'IN', city: 'via Singapore', label: 'India (via Singapore)', virtualLocation: true });
    expect(target.countryWide).toBeUndefined();
  });
});
