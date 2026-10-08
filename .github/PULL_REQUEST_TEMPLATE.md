## What and why

<!-- What does this change, and why is it needed? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Commands run, manual checks, OS. For UI changes, add screenshots. -->

## Checklist

- [ ] `pnpm test` passes (in `app/`).
- [ ] `pnpm exec tsc --noEmit` passes.
- [ ] New behaviour has tests; unit tests make no network calls.
- [ ] Every new or changed UI string is in both `en.json` and `vi.json`.
- [ ] No secrets, VPN configs, `.env` files, account data, personal IPs or unredacted logs are committed.
- [ ] Nothing here hammers provider servers; any live testing was rate-limited.
- [ ] New network endpoints are listed in `PRIVACY.md`.
- [ ] Commit subjects are imperative and ≤ 72 characters; bodies explain why.
