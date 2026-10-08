# Security policy

## Supported versions

Proxy Farm is maintained by volunteers. Security fixes go into the latest release only.

| Version | Supported |
|---|---|
| Latest 0.x release of the desktop app | Yes |
| Older desktop releases | No: please update |
| v1 (Docker, tag `v1-docker`) | No: archived |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/huuhoa143/proxy-farm/security/advisories/new>

Please include:

- What the problem is and what an attacker could do with it.
- Steps to reproduce, or a proof of concept.
- App version (Settings → About), OS and version, and the provider involved, if any.
- Any relevant log lines from the port's Details drawer.

Never include real credentials, private keys, HMA device ids, proxy passwords or your
own public IP. Use placeholders.

## What to expect

- We aim to acknowledge reports within **7 days**. This is a volunteer project, so a fix
  can take longer; we will keep you updated in the advisory.
- We will agree a disclosure date with you, publish a GitHub Security Advisory with the
  fix, and credit you unless you prefer otherwise.

## Scope

In scope:

- The desktop app in `app/`: main process, preload and renderer.
- The IPC surface between renderer and main process.
- Local proxy authentication and the LAN-sharing rule (a proxy username and password are
  required when ports listen on `0.0.0.0`).
- The optional rotate webhook (Bearer key, Host allowlist).
- Storage of secrets (Electron `safeStorage`) and redaction of logs.
- The generated sing-box configuration (for example, a path that bypasses the tunnel or
  leaks DNS or IPv6 outside it).
- The update path (electron-updater and GitHub Releases) and the build scripts that
  download and verify sing-box.

Out of scope:

- Vulnerabilities in a VPN provider's servers, apps or accounts. Report those to the
  provider.
- Vulnerabilities in sing-box itself. Report those to
  [SagerNet/sing-box](https://github.com/SagerNet/sing-box); tell us too if the bundled
  version is affected.
- Running with LAN sharing (`0.0.0.0`) on a network you do not trust or without a
  firewall, or sharing your proxy credentials.
- Attacks that need an attacker already running code as your user or with admin rights
  on your computer.
- The archived v1 Docker edition.

## Safe harbor

We will not pursue or support legal action against anyone who researches and reports a
vulnerability in good faith under this policy: test only against your own installation
and accounts, do not access other people's data, do not degrade VPN providers' services,
and give us reasonable time to fix the problem before you disclose it.
