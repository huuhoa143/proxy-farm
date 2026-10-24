/** Synthetic NordVPN server-list fixtures for the unit tests (spec §5.5): RFC 5737
 * addresses and dummy keys, nothing real. */

export const PK_HANOI = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export const PK_HCMC = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
export const PK_SAO = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';

/** Synthetic Nord ids (country, city) per city name, like the API's numeric ids. */
export const NORD_IDS: Record<string, { countryId: number; cityId: number }> = {
  Hanoi: { countryId: 234, cityId: 3196 },
  'Ho Chi Minh City': { countryId: 234, cityId: 3197 },
  'São Paulo': { countryId: 30, cityId: 300 },
};

export interface ApiServerExtras {
  /** Server status; default 'online'. */
  status?: string;
  /** `wireguard_udp`'s own status; default 'online'. */
  wgStatus?: string;
  /** Group ids; default [11] (standard). */
  groups?: number[];
}

/** One server shaped like the API's `fields[...]`-trimmed answer. */
export function apiServer(
  hostname: string,
  station: string,
  load: number,
  cc: string,
  country: string,
  city: string,
  publicKey?: string,
  virtual = false,
  extras: ApiServerExtras = {},
) {
  const ids = NORD_IDS[city];
  return {
    hostname,
    station,
    load,
    status: extras.status ?? 'online',
    groups: (extras.groups ?? [11]).map((id) => ({ id })),
    locations: [{ country: { ...(ids ? { id: ids.countryId } : {}), code: cc, name: country, city: { ...(ids ? { id: ids.cityId } : {}), name: city } } }],
    technologies: [
      { identifier: 'openvpn_udp', metadata: [], pivot: { status: 'online' } },
      ...(publicKey
        ? [{ identifier: 'wireguard_udp', metadata: [{ name: 'public_key', value: publicKey }], pivot: { status: extras.wgStatus ?? 'online' } }]
        : []),
    ],
    specifications: [
      { identifier: 'version', values: [{ value: '2.1.0' }] },
      ...(virtual ? [{ identifier: 'virtual_location', values: [{ value: 'true' }] }] : []),
    ],
  };
}

/** Synthetic list (RFC 5737 addresses): two VN cities, one accented city, and junk. */
export function samplePayload() {
  return [
    apiServer('vn53.nordvpn.com', '192.0.2.3', 20, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true),
    apiServer('vn52.nordvpn.com', '192.0.2.1', 15, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true),
    apiServer('vn57.nordvpn.com', '198.51.100.67', 15, 'VN', 'Vietnam', 'Ho Chi Minh City', PK_HCMC, true),
    apiServer('vn56.nordvpn.com', '198.51.100.45', 12, 'VN', 'Vietnam', 'Ho Chi Minh City', PK_HCMC, true),
    apiServer('vn61.nordvpn.com', '198.51.100.111', 12, 'VN', 'Vietnam', 'Ho Chi Minh City', PK_HCMC, true),
    apiServer('br1.nordvpn.com', '203.0.113.10', 30, 'BR', 'Brazil', 'São Paulo', PK_SAO),
    // skipped: no WireGuard, a bad key, no IPv4, no city, Dedicated IP / Double VPN only,
    // offline, WireGuard offline
    apiServer('vn99.nordvpn.com', '192.0.2.99', 1, 'VN', 'Vietnam', 'Hanoi'),
    apiServer('vn98.nordvpn.com', '192.0.2.98', 1, 'VN', 'Vietnam', 'Hanoi', 'not-a-key'),
    apiServer('vn97.nordvpn.com', '', 1, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true),
    apiServer('vn96.nordvpn.com', '192.0.2.96', 1, 'VN', 'Vietnam', '', PK_HANOI),
    apiServer('vn95.nordvpn.com', '192.0.2.95', 1, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true, { groups: [9, 23] }),
    apiServer('vn94.nordvpn.com', '192.0.2.94', 1, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true, { groups: [1] }),
    apiServer('vn93.nordvpn.com', '192.0.2.93', 1, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true, { status: 'offline' }),
    apiServer('vn92.nordvpn.com', '192.0.2.92', 1, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true, { wgStatus: 'maintenance' }),
  ];
}
