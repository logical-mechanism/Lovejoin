# ui/e2e

Playwright suites for the Lovejoin UI. Two specs, two purposes.

## smoke.spec.ts — runs on every PR

Route-shell coverage. No wallet, no chain. Walks the public routes
(`/`, `/pool`, `/vault`, `/deposit`, `/withdraw`) against an
auto-spawned Vite dev server and asserts the structural elements
that are stable across UI-copy churn.

```sh
pnpm --filter @lovejoin/ui test:e2e
```

Wired into `.github/workflows/ci.yml` as the `e2e-smoke` job. Browser
binaries are cached on the `@playwright/test` version string.

## full-flow.spec.ts — wallet-extension flow against Preprod

The deep flow: connect a CIP-30 wallet, unlock the vault via
`signData`, deposit one mix-box, run three Mix txs, withdraw to a
fresh address, and confirm each tx hash on chain via Blockfrost.

It self-skips unless `E2E_PREPROD_WALLET=1` is set, so the default
`pnpm test:e2e` invocation is safe in CI.

### Run locally

You'll need:

- An unpacked CIP-30 wallet extension (Lace / Eternl / Nami) on disk
  with the funded Preprod wallet already created and the
  `E2E_WALLET_PASSPHRASE` matching its password.
- A funded Preprod address (the wallet itself) holding more than the
  protocol denomination plus a few ADA for fees.
- A Preprod Blockfrost project_id.
- A fresh Preprod destination bech32 (`addr_test1...`) for the
  withdraw to land at.

```sh
E2E_PREPROD_WALLET=1 \
E2E_WALLET_EXTENSION_PATH=/path/to/unpacked-wallet-extension \
E2E_WALLET_PASSPHRASE='your-wallet-password' \
E2E_BLOCKFROST_PROJECT_ID=preprod... \
E2E_DESTINATION_BECH32=addr_test1... \
  pnpm --filter @lovejoin/ui test:e2e -- --headed full-flow
```

Headless Chromium does not load extensions, so this flow forces
headed mode. Pass `--debug` instead of `--headed` to step through
interactively when wallet selectors break.

Optional env:

| Var                     | Default                 | Purpose                                                                     |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `E2E_WALLET_KIND`       | `auto`                  | `lace` / `eternl` / `nami` — disambiguates the password-input selector.     |
| `E2E_WALLET_NAME_REGEX` | `/lace\|eternl\|nami/i` | Regex matched against the installed-wallet rows in the Lovejoin modal.      |
| `E2E_BASE_URL`          | `http://localhost:5179` | When set, the Vite dev server is not spawned — points the test at this URL. |

### Trigger against staging via workflow_dispatch

`.github/workflows/e2e-full-flow.yml` runs the same spec against the
deployed `preprod.lovejo.in` site. Maintainer-only (workflow_dispatch
is gated behind repo write access by default). Required repo secrets:

| Secret                      | Notes                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `E2E_BLOCKFROST_PROJECT_ID` | Preprod Blockfrost project_id.                                                          |
| `E2E_WALLET_EXTENSION_B64`  | Base64-encoded ZIP of the unpacked wallet extension. The job decodes it into a tmp dir. |
| `E2E_WALLET_PASSPHRASE`     | Wallet password.                                                                        |
| `E2E_DESTINATION_BECH32`    | Fresh Preprod withdraw destination.                                                     |

Trigger from the CLI:

```sh
gh workflow run e2e-full-flow.yml
# or with overrides:
gh workflow run e2e-full-flow.yml \
  -f base_url=https://preprod.lovejo.in \
  -f wallet_kind=lace
```

The job uploads a `playwright-full-flow-<run-id>` artifact with the
HTML report + per-step traces + retain-on-failure videos. 30-day
retention.

### Preparing `E2E_WALLET_EXTENSION_B64`

Locate the unpacked extension on your machine (or download a release
build), zip the directory, and base64-encode the zip:

```sh
cd /path/to/wallet-extension/parent
zip -r wallet.zip wallet-extension/
base64 -w0 wallet.zip | gh secret set E2E_WALLET_EXTENSION_B64
rm wallet.zip
```

The decoded archive must contain a `manifest.json` either at its
root or one level deep — the workflow's "Materialise wallet
extension" step searches both.

## Layout

```
e2e/
  smoke.spec.ts      No wallet. Runs on every PR.
  full-flow.spec.ts  Funded-wallet Preprod flow. Manual / dispatch only.
  wallet-driver.ts   CIP-30 popup automation (passphrase + confirm).
  README.md          You are here.
```

When the wallet driver breaks (selectors drift with each wallet
release), open the popup interactively with
`pnpm test:e2e -- --headed --debug full-flow`, inspect the DOM, and
add a new pattern to `CONFIRM_BUTTON_PATTERNS` or a wallet-specific
override in `findPasswordInput`.
