# ui (`@lovejoin/ui`)

The Lovejoin web app. React 19 + Vite + Tailwind v4 + react-i18next, CIP-30 wallet via mesh, served by nginx in production. Ships in 20 languages.

Spec: [docs/spec/06-ui.md](../docs/spec/06-ui.md). The README is a quickstart; the spec is canonical.

## What's here

```
src/
  routes/       Home, Pool, Vault, Box, Deposit, Withdraw, Donate, Protocol, Layout.
  components/   Header, WalletModal, MixButton, MixWidthSlider, Toaster, ConfigPanel, etc.
  lib/          sdk, vault, pool, backend, bech32, store, collateral-status, polyfill, i18n helpers.
  i18n/         index.ts, languages.ts (BCP-47 registry), locales/{en,ar,de,...}.json (20 locales).
  styles/       Tailwind v4 input.
  App.tsx, main.tsx, env.d.ts
e2e/             Playwright specs (smoke, full-flow). Hits Preprod.
scripts/         check-i18n.mjs (lint), translate-i18n.mjs, copy-papers.mjs.
test/            vitest + @testing-library/react component tests.
public/          Static assets (favicon, robots.txt).
vite.config.ts   See "UI bundler pitfalls" memory: libsodium ESM bug, sidan-csl Wasm, vite-plugin-node-polyfills Buffer globals.
```

## Env vars

Build-time only; injected by Vite at compile. There is no runtime config panel in production. `?advanced=1` unlocks an overrides panel for local debugging.

| Var                          | Purpose                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `VITE_BACKEND_URL`           | Lovejoin backend base URL (the self-hosted `ChainProvider`).          |
| `VITE_BLOCKFROST_PROJECT_ID` | Blockfrost fallback project id when the backend is unreachable.       |
| `VITE_COLLATERAL_ENDPOINT`   | Collateral-provider HTTP endpoint (default: a pinned giveme.my host). |
| `VITE_NETWORK`               | `preprod` (default) or `mainnet`.                                     |

`.env.example` at the repo root has the canonical list. Local dev only needs the Blockfrost id.

## Develop

```sh
pnpm install                           # once, repo-root
pnpm --filter @lovejoin/ui dev         # vite on http://localhost:5173
pnpm --filter @lovejoin/ui build       # tsc --noEmit + vite build → dist/
pnpm --filter @lovejoin/ui preview     # serve the production build locally
pnpm --filter @lovejoin/ui test        # vitest unit + component tests
pnpm --filter @lovejoin/ui test:e2e    # Playwright on Preprod
pnpm --filter @lovejoin/ui lint        # tsc + eslint + i18n parity check
```

From the repo root: `make ui-dev` is the same as the `dev` script.

Note on `node`: under VS Code the snap-shim `node` breaks pnpm and the i18n lint subprocess. Use nvm node on PATH (`nvm use 22`) before running anything in this workspace. The i18n lint script pins `process.execPath` to dodge the snap trap; pnpm doesn't.

## i18n contribution flow

English is canonical. All supported locales must stay in lock-step with `en.json` (any new key, every locale gains it in the same change; non-English locales fall back to English for missing keys, but the lint catches structural drift). 20 languages today, registered in [src/i18n/languages.ts](src/i18n/languages.ts) (BCP-47 + native name + `dir` for RTL).

```sh
pnpm --filter @lovejoin/ui run lint            # also runs scripts/check-i18n.mjs
pnpm --filter @lovejoin/ui exec node scripts/translate-i18n.mjs   # bulk-translate stub keys
```

To add a new locale:

1. Add the entry to [src/i18n/languages.ts](src/i18n/languages.ts) (set `dir: "rtl"` if needed).
2. Create `src/i18n/locales/<code>.json` by copying `en.json` and translating.
3. Re-run `pnpm --filter @lovejoin/ui run lint` to confirm parity.

Lint rule: raw English strings inside JSX are rejected. Strings live in `en.json` and are referenced via `useTranslation()`. M-numbers and other internal-milestone references stay in CLAUDE.md / spec, never in `en.json`.

## E2E

```sh
pnpm --filter @lovejoin/ui exec playwright install --with-deps   # once
BLOCKFROST_PROJECT_ID_PREPROD=preprod... \
  pnpm --filter @lovejoin/ui test:e2e
```

E2E is opt-in via env vars; the suite skips cleanly when creds aren't set.

## Privacy posture

No analytics, no telemetry, no cookies. Wallet-derived vault seed lives in memory for the session; IndexedDB stores no seed material. See [docs/spec/06-ui.md](../docs/spec/06-ui.md) §"Privacy UX rules".
