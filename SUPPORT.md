# Getting help

Proxy Farm is maintained by volunteers. There is no email or paid support; everything
goes through GitHub.

## Where to ask

- **Questions, setup help, ideas:**
  [GitHub Discussions](https://github.com/huuhoa143/proxy-farm/discussions).
  Search first; your question may already be answered.
- **Bugs:** open an [issue](https://github.com/huuhoa143/proxy-farm/issues/new/choose)
  when the app does something wrong and you can describe how to reproduce it.
- **Feature requests:** use the feature request form in
  [Issues](https://github.com/huuhoa143/proxy-farm/issues/new/choose).
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).

## Problems with your VPN account

Proxy Farm cannot fix your VPN account. If your provider rejects your password, your plan
does not include a server, your account was suspended, or your subscription expired,
contact the provider. Check that the provider's own app works first.

## What to include

- **App version:** Settings → About.
- **OS and version:** for example macOS 15.3 on Apple silicon, or Windows 11 x64.
- **Provider:** HMA, ZoogVPN, Surfshark or config file (and which protocol for files).
- **Port state:** what the status column shows (for example *Retrying* and its reason,
  *Sign-in rejected*, *Port in use*) and the location.
- **Logs:** the relevant lines from the port's **Details** drawer. The app redacts
  known secrets, but read the lines again before posting.
- What you did, what you expected, and what happened instead.

## What never to post

Remove these from text, logs and screenshots:

- Provider passwords, Surfshark or WireGuard private keys, `.ovpn`/`.conf` files.
- HMA device ids (`U1.…`) and device passwords, or `tokenCoreSE.json`.
- Your proxy username and password, and the webhook key.
- Your own public IP address, if you care about it. Exit IPs of VPN servers are usually
  fine to share.

If you posted a secret by mistake, delete the post and change the secret (new password,
new WireGuard key, new proxy password in Settings).
