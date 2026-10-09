# Third-party notices

Proxy Farm's own code is released under the [MIT License](LICENSE). Release builds also
include the third-party components below, which keep their own licenses. Versions are
those resolved in `app/pnpm-lock.yaml` and `app/scripts/singbox.pins.json` at the time of
writing; the lockfile is authoritative.

## sing-box

- Project: <https://github.com/SagerNet/sing-box>
- Version: **1.14.2**
- License: **GPL-3.0-or-later**
  (<https://github.com/SagerNet/sing-box/blob/v1.14.2/LICENSE>)
- Source code for this exact version:
  <https://github.com/SagerNet/sing-box/tree/v1.14.2>, archive
  <https://github.com/SagerNet/sing-box/archive/refs/tags/v1.14.2.tar.gz>

Proxy Farm ships the official, **unmodified** sing-box binaries published at
<https://github.com/SagerNet/sing-box/releases/tag/v1.14.2>. The build verifies each
download against the sha256 values pinned in `app/scripts/singbox.pins.json`. On macOS the
release script code-signs the binary so it can run inside a notarized app; its code is not
changed.

sing-box runs as a **separate program**: Proxy Farm starts one sing-box process per proxy
port, passes it a JSON configuration on standard input and talks to it over its local
HTTP API. Proxy Farm does not link to sing-box code. sing-box remains under the GPL; the
MIT license of Proxy Farm does not apply to it.

As required by GPL-3.0 section 6, each Proxy Farm release on GitHub has the corresponding
source tarball (`sing-box-1.14.2-src.tar.gz`) attached. You can also get the source from
the links above.

## Electron

- Project: <https://www.electronjs.org/>
- Version: 42.0.1
- License: MIT

Electron includes Chromium, Node.js and other components under their own licenses. Their
notices ship with the app in `LICENSES.chromium.html` next to the Electron `LICENSE` file.

## Runtime npm packages

Direct runtime dependencies from `app/package.json`, plus `electron-updater`, which is
listed under devDependencies but bundled into the app:

| Package | Version | License |
|---|---|---|
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| i18next | 26.4.2 | MIT |
| react-i18next | 17.0.16 | MIT |
| socks-proxy-agent | 7.0.0 | MIT |
| electron-updater | 6.8.9 | MIT |
| @fontsource-variable/inter (Inter font) | 5.3.0 | OFL-1.1 |
| @fontsource-variable/bricolage-grotesque (Bricolage Grotesque font) | 5.3.0 | OFL-1.1 |
| @fontsource-variable/jetbrains-mono (JetBrains Mono font) | 5.3.0 | OFL-1.1 |

Their transitive runtime dependencies:

| Package | License |
|---|---|
| scheduler, use-sync-external-store, @babel/runtime, html-parse-stringify | MIT |
| agent-base, debug, ms, socks, ip-address, smart-buffer | MIT |
| builder-util-runtime, fs-extra, jsonfile, universalify, js-yaml, lazy-val, lodash.escaperegexp, lodash.isequal, tiny-typed-emitter | MIT |
| graceful-fs, semver | ISC |
| argparse | Python-2.0 |
| sax | BlueOak-1.0.0 |

The full license text of each package is in its folder under `node_modules` after
`pnpm install`. To list them yourself: `cd app && pnpm licenses list --prod`.

## Bundled certificates and keys

These files in `app/resources/ca/` are public configuration published by third parties.
They contain no secrets of any user.

| File | What it is | Source |
|---|---|---|
| `sectigo-r46.pem` | "Sectigo Public Server Authentication Root R46", a public root CA certificate (valid 2021–2046). Used to verify HMA's OpenVPN servers. | Sectigo Limited; exported from the macOS system root store |
| `zoogvpn-ca.pem` | ZoogVPN's shared OpenVPN CA certificate ("Easy-RSA CA", valid 2022–2032) | ZoogVPN's public OpenVPN configuration files, as collected in [haugene/vpn-configs-contrib](https://github.com/haugene/vpn-configs-contrib) (`openvpn/zoogvpn/`) |
| `zoogvpn-tls-auth.key` | ZoogVPN's shared OpenVPN `tls-auth` static key, identical in every customer's config file | Same as above |
| `expressvpn-ca.pem` | ExpressVPN's OpenVPN CA certificate ("ExpressVPN CA3", valid 2024–2124) | ExpressVPN's "Manual configuration → OpenVPN" profile, identical for every customer; the same bytes are in [qdm12/gluetun](https://github.com/qdm12/gluetun) (`internal/provider/expressvpn/openvpnconf.go`, MIT, see below) |
| `expressvpn-client.crt`, `expressvpn-client.key` | ExpressVPN's shared OpenVPN client certificate (CN `expressvpn_customer`, valid to 2066) and its key, identical in every customer's profile; accounts are told apart by their username and password only | Same as above |
| `expressvpn-tls-auth.key` | ExpressVPN's shared OpenVPN `tls-auth` static key | Same as above |

## Bundled server lists

`app/resources/catalogs/expressvpn-servers.json` is the list of ExpressVPN server
hostnames, countries and cities hard-coded in gluetun
(`internal/provider/expressvpn/updater/hardcoded.go` at commit `26574b9`), with ISO
country codes added. gluetun is distributed under the MIT License:

```
MIT License

Copyright (c) 2018 Quentin McGaw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trademarks

HMA, Gen Digital, Surfshark, ZoogVPN, NordVPN, NordLynx, Nord Security, ExpressVPN,
WireGuard, OpenVPN, Electron and other names are trademarks of their owners. Proxy Farm is not
affiliated with or endorsed by them.
