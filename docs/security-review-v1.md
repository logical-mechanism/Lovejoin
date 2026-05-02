# Security review — v1.0.0 pre-launch (internal)

**Status:** complete (2026-05-01) — issue [#44](https://github.com/logical-mechanism/Lovejoin/issues/44)
**Reviewers:** project contributors only
**Scope:** the `dev` branch at the security-review pass (commit at PR head; see PR for SHA).

This document is the public-facing record of the v1.0.0 internal security review. The review's purpose was to make the disclosure promise in [SECURITY.md](../SECURITY.md) credible — i.e. surface anything obvious before going public, fix critical/high issues here, and triage everything else.

This is _not_ an independent audit. Independent crypto and contract reviewers are required before any mainnet deployment per `docs/spec/11-open-questions.md` OQ-M.

## Summary

| Severity            | Count | Disposition                                                                                       |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| Critical            | 0     | —                                                                                                 |
| High                | 3     | Fixed in this PR (H1 / H2 / H3)                                                                   |
| Medium              | 9     | 6 fixed in this PR (M1–M5 + spec drift on Owner branch); 3 tracked as follow-up issues for v1.0.0 |
| Low / informational | many  | Noted in "Verifications passed" / "Low / informational" below; nothing exploitable                |

The protocol-critical layers (Aiken validators, off-chain crypto, wallet seed derivation) came out clean — zero findings above informational. All actionable findings sit in the Fastify backend and the GitHub Actions / repo-settings perimeter. That mirrors where mature web stacks tend to surface issues during security review.

## Process

The review combined an automated triage pass with a manual checklist driven by the issue body.

1. **Threat-model re-read.** [docs/spec/08-threat-model.md](spec/08-threat-model.md) attack list, severity classification, and "out of scope" stance.
2. **Five parallel audit passes** across the repo:
   - `offchain/src/crypto/` + `offchain/src/wallet/seed.ts` — RFC 6979 nonces, scalar reduction, encoding parity, side-channel concerns, deterministic seed derivation, leakage of signature material.
   - `contracts/validators/` + `contracts/lib/lovejoin/` — every rule in `docs/spec/03-contracts.md` §0–§3 cross-referenced against attack categories (datum substitution, front-running, drain via paired Owner withdraws, replay/malleability, subgroup confusion).
   - `backend/` — rate limiting, input validation, secrets handling, CORS, security headers, db-sync queries (parameterised vs. concatenated), connection-pool bounds, indexer reconnect logic, dependency advisories.
   - `ui/` — `dangerouslySetInnerHTML` / `eval`, analytics SDKs, mesh-dep telemetry, cookies / localStorage / IndexedDB, CSP, external domains the UI talks to, react-i18next `Trans` rendering safety.
   - `.github/workflows/` + `Dockerfile` + `.do/` — secret references, CI permissions scope, action pinning, base-image hygiene, branch protection.
3. **Encoding parity re-run.** The "build-blocker" risk from [docs/spec/12-build-guide.md](spec/12-build-guide.md) §"Risk 1" — `cd offchain && pnpm vitest run test/crypto/encoding-parity.test.ts`. 4 tests / 1000 vectors per N ∈ {2,3,4,6,8} green. The Aiken-side parity vectors at `contracts/lib/lovejoin/encoding_parity_kat.test.ak` are part of `aiken check` (378 tests passing).
4. **Triage** into critical / high / medium / low using the [docs/spec/08-threat-model.md](spec/08-threat-model.md) §"Severity classification" guide.
5. **Fix** all critical and high findings; defer mediums / lows that are non-exploitable to follow-up issues (or, if cheap, fold them into this PR).

Severity definitions (from the threat model):

- **P0 — critical.** Funds can be stolen, or invalid proofs are accepted. Halt all work, hotfix.
- **P1 — high.** Privacy promise broken (passive observer linking beyond stated bounds), or DoS preventing mixing > 1 hour.
- **P2 — medium.** Privacy leak requiring active attacker effort, or correctness bug in non-critical paths.
- **P3 — low.** UX issue, performance regression < 10%.

The Fastify-side findings are best read as backend-DoS-amplifier and information-leak issues (P2-shaped) where the proxy-IP rate-limit defect (H1) crosses into P1 territory because, unfixed, a single bad actor can deny mixing service to all good users by tripping the global ceiling. That's why H1, H2, and H3 were treated as high.

## Findings

### Critical (P0)

None.

### High (P1) — fixed in this PR

#### H1 — `@fastify/rate-limit` keys requests on the proxy IP, not the client

[backend/src/api/server.ts:78-81](../backend/src/api/server.ts) registered the plugin with no `keyGenerator` and the Fastify factory had no `trustProxy`. With Fastify's default `trustProxy: false`, `req.ip` resolves to the LB's internal address. Behind DigitalOcean App Platform / Cloudflare every request collapses onto the same key and the configured per-IP ceiling becomes a single global counter — trivially exhausted by one bad actor, tarpitting all other users. Pulls the privacy claim ("backend logs IPs only for rate limiting, retention < 24h") into doubt because the limit doesn't actually apply per-IP.

**Fix:** set `trustProxy: true` on the Fastify factory and `keyGenerator: req.ip` explicitly on `@fastify/rate-limit`. The Fastify default is now correct, and the explicit `keyGenerator` keeps it that way against future framework changes.

#### H2 — `/submit` and `/evaluate` accept Fastify's default 1 MiB body and share the global rate limit

Cardano transactions are bounded by `max_tx_size` (≤16 KiB on mainnet/preprod). The two POST endpoints accepted hex CBOR up to Fastify's default `bodyLimit: 1MiB` and were rate-limited only by the global 600/min — i.e. no per-route ceiling for the most expensive endpoints in the API. Combined with H1, that meant a single client could submit 1 MiB junk hex blobs to `/submit` 600 times per minute (60 GiB/h) with the server doing `Buffer.from(hex)` + ogmios round-trips before rejecting them.

**Fix:**

- `bodyLimit: 64 * 1024` (64 KiB ≈ 4× the upper bound for any current Cardano tx including post-Conway headroom) on `/submit` + `/evaluate`.
- Per-route `{ max: 60, timeWindow: '1 minute' }` on `/submit` + `/evaluate`. Sane clients submit a tx once and poll `/tx/:hash` for confirmation; legitimate retries don't approach 60/min.
- Hex length cap (`TX_HEX_MAX_LENGTH = 64 KiB`) baked into the validator so a malformed request rejects before any decode work.

#### H3 — db-sync and ogmios error messages bubble to clients verbatim

Multiple routes returned `{ error: "...", message: (err as Error).message }` to the caller. `node-postgres` errors routinely include the failing SQL, the server hostname / port, the role name, and the database name. ogmios connection failures include the upstream URL (especially relevant when the deploy uses Cloudflare Access in front of the Cardano node). `/health` exposed `runtimeError: fatalError?.message` and `chainsyncReconnect.lastErrorMessage` straight from the runtime layer.

A public caller hitting these paths during an outage could enumerate backend topology — host:port, project ids, database names — with no authentication.

**Fix:**

- New helper `redactUpstreamMessage(raw)` in [backend/src/api/server.ts](../backend/src/api/server.ts). Strips `postgres://` URIs, `wss://` / `https://` URIs, IPv4-with-optional-port, `project_id=...` patterns, and Blockfrost-shaped `preprod...` / `mainnet...` / `preview...` tokens. Caps result at 256 chars.
- Applied on `/health` (`runtimeError`, `chainsyncReconnect.lastErrorMessage`), `/protocol-params`, `/history` (failure path), `/utxos/:address`, `/tx/:hash`, `/tx/:hash/utxos`, `/submit`, `/evaluate`.
- Operators still get the full message via `console.error` — DigitalOcean App Platform captures stderr.
- The `/submit` test suite asserts ledger-rejection messages (`ScriptExecutionFailure`, etc.) still pass through; redaction only trims hosts/credentials and length.

### Medium (P2) — folded into this PR

#### M1 — No baseline security headers

Fastify shipped no `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, or `Cross-Origin-Resource-Policy` on responses. For a JSON API consumed by a browser UI on a separate origin (`lovejo.in` → backend), at minimum `nosniff`, `no-referrer`, and HSTS belong on every response.

**Fix:** added an `onSend` hook in [backend/src/api/server.ts](../backend/src/api/server.ts) that sets the headers above on every reply. No new dependency (helmet would also work; we kept the dep footprint flat).

#### M2 — `parseCorsOrigins` defaulted to `*`

[backend/src/config.ts:277-283](../backend/src/config.ts) returned `"*"` when `CORS_ORIGINS` was unset or empty. The README at the same time claimed "Empty = same-origin only". A "I forgot to set CORS_ORIGINS in prod" deploy left the API reflecting any caller's origin.

**Fix:** closed default. Empty / unset → empty allow-list (same-origin only, matching the README). Operators must set `CORS_ORIGINS=https://lovejo.in,https://preprod.lovejo.in` in prod, or pass `*` explicitly for local dev.

#### M3 — Blockfrost upstream body fragment in thrown error

[backend/src/db/blockfrost-history.ts](../backend/src/db/blockfrost-history.ts) included `body.slice(0, 200)` in the `Error` it threw. The H3 redactor catches most patterns at the API surface, but the Blockfrost client itself shouldn't be the one carrying that data forward — upstream bodies have been observed echoing the project id in 4xx responses.

**Fix:** drain + log full body server-side via `console.error`; the thrown error only carries the status code + path. Closes the leak at the source.

#### M4 — `/history` and `/utxos` accept arbitrary 4..200-char strings

The pg queries are parameterised so the strings are not an SQLi vector, but a caller could issue heavy `tx_out.address = '<arbitrary>'` index lookups returning zero rows.

**Fix:** new `validateBech32AddressForNetwork` in [backend/src/address.ts](../backend/src/address.ts) checks length (10..200) and HRP (`addr` for mainnet, `addr_test` for preprod/preview) before issuing the lookup. Wired into both routes. The check is intentionally weaker than full bech32 charset/checksum validation — those would slow the hot path and be marginal value over the parameterised SQL guarantee. The HRP+length check is enough to reject the obvious junk and wrong-network calls.

#### M5 — `pg` pool unbounded on time

[backend/src/db/dbsync.ts](../backend/src/db/dbsync.ts) constructed the Pool with `max: 5` only — no `idleTimeoutMillis`, `connectionTimeoutMillis`, `query_timeout`, or `statement_timeout`. Five slow callers could stall every other history/utxo request.

**Fix:** `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`, `query_timeout: 10_000`, `statement_timeout: 10_000`.

#### Spec drift — Owner branch supports N ≥ 1 (bulk withdraw)

[docs/spec/03-contracts.md](spec/03-contracts.md) §2 said the Owner branch requires "Exactly one well-formed mix input." [contracts/validators/mix_logic.ak:101-103](../contracts/validators/mix_logic.ak) actually enforces `n >= 1`, allowing bulk withdraw of multiple owner-controlled boxes in one tx. Math is sound (each Schnorr proof is independently bound to its own `(a_i, b_i)` and shares the same `ctx` over all outputs); threat-model A2 already classifies it as acceptable residual.

**Fix:** updated §2 Owner-branch text to match the implementation, with a cross-reference to the F-1 protection (`fee_contract` requires a `Mix` redeemer, not `Owner`, so the "drain via paired Owner withdraws against the fee shard" concern is structurally blocked).

### Medium (P2) — tracked as follow-up issues for v1.0.0

These are non-exploitable (no proven attack path) but require deploy-side verification (CSP) or larger code surface (reconnect logic) than belongs in this hardening PR. Tracked separately under the v1.0.0 milestone:

- **UI CSP tightening + dependency bumps** — [issue #76](https://github.com/logical-mechanism/Lovejoin/issues/76). [ui/nginx.conf](../ui/nginx.conf) currently sets only `Content-Security-Policy: frame-ancestors 'none'`; needs a real allow-list and a staging smoke test against mesh's WASM bundle and the inline LCP `<style>` block. `pnpm audit` reports 18 advisories, none reachable from the production browser bundle, but worth bumping dev tooling and tracking the upstream mesh deps.
- **`OgmiosTxClient` bounded reconnect** — [issue #77](https://github.com/logical-mechanism/Lovejoin/issues/77). [backend/src/indexer/ogmios-tx.ts:206-211](../backend/src/indexer/ogmios-tx.ts) clears `fatalError` on every request and reconnects immediately. No backoff, no circuit breaker. Mirror the bounded reconnect in [backend/src/indexer/runtime.ts:223-302](../backend/src/indexer/runtime.ts).
- **Repo settings — branch protection on `main`** — covered by the v1 release-automation issue ([#48](https://github.com/logical-mechanism/Lovejoin/issues/48)). `gh api repos/.../branches/main/protection` returns 404 today; branch protection lands as part of the release-automation pass.

### Low / informational

#### Validators

- **No critical/high/medium findings.** All 378 `aiken check` tests pass, every spec rule has positive + negative coverage, the M4 pre-uncompression optimisation in `mix_logic.ak` correctly drops N² G1 uncompresses to N without bypassing subgroup checks (uncompressed points are used for curve equations; raw bytes only feed the FS hash preimage where subgroup membership is irrelevant).
- The fee-contract's PayMixFee path correctly distinguishes a Mix redeemer from an Owner redeemer via [contracts/validators/fee_contract.ak:103-109](../contracts/validators/fee_contract.ak), so the threat-model A2 "drain via paired Owner withdraws" path is structurally blocked from the fee-shard side. The "acceptable residual" caveat in the threat model still applies to non-fee-shard Owner txs (i.e., users paying their own tx fee).

#### Crypto / wallet seed

- `deriveSeedFromWalletSignature` in [offchain/src/wallet/seed.ts](../offchain/src/wallet/seed.ts) returns `signatureHex` to the caller. The signature is the long-term root secret from which every Lovejoin owner key is derived; widening the SDK boundary by exposing it adds a soft surface for accidental leakage in future code (e.g. an "export wallet" feature stashing it somewhere persistent). Defense-in-depth: drop `signatureHex` from the return type, or add a TSDoc warning. The current sole UI caller in [ui/src/lib/vault.ts:218](../ui/src/lib/vault.ts) destructures only `seed` and is hygienic today.
- bigint scalars (`r_p`, `secret`, `witness`, per-branch `z`) are not zeroed after use — JS-runtime limitation, not a coding bug. Mitigation already in place: no `console.log` of secret material anywhere in `offchain/src/crypto/` or `offchain/src/wallet/`, no IndexedDB persistence.
- Subgroup check confirmed on every `g1_uncompress` callsite (via `@noble/curves` `Point.fromBytes` → `assertValidity` → `isTorsionFree`).
- Side-channel posture: `@noble/curves` constant-time scalar mul (`Point.multiply`); RFC 6979 deterministic nonces in [offchain/src/crypto/nonce.ts](../offchain/src/crypto/nonce.ts) with the spec-mandated counter increment on `r == 0` retries.

#### UI

- No `dangerouslySetInnerHTML`, no `eval` / `new Function`, no string-form `setTimeout`/`setInterval`, no analytics or telemetry dependencies, no service worker.
- No cookies. localStorage holds three non-secret keys: `lovejoin.config.v1` (advanced-mode runtime overrides; `?advanced=1`-gated, dev-only), `lovejoin/lang/v1` (UI locale), `lovejoin.pool.feePayer` (fee-payer mode). No IndexedDB at all — vault state lives in React state only and re-derives the seed on each unlock.
- All long-form prose flows through `react-i18next`'s `<Trans>` with an explicit allow-list of tags (`<a1>`, `<b>`, `<c>`, `<e>`, `<paper>`); a malicious translator submitting `<script>` would render as escaped text, not as a script element.
- `?advanced=1` panel is `import.meta.env.DEV`-gated and tree-shaken from production builds.
- nginx security headers in-repo: HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, COOP same-origin, Permissions-Policy locking out camera/mic/geo/payment/usb/interest-cohort.
- Two CLAUDE.md memory entries about UI internals (`project_owner_secret_storage_m6.md`, `project_ui_bundler_pitfalls.md`) are out of date — vault now uses Argon2id-from-password derivation, no IndexedDB. Update on next memory pass.

#### CI / deploy

- No `pull_request_target` triggers. Forked PRs run with read-only `GITHUB_TOKEN`.
- No `set -x` / `printenv` / secret echoes in any `run:` block. Failed-run log spot-check (release run 25243703737) returned only the action-side mask placeholder (`github-token: ***`).
- Cloudflared binary in `backend/Dockerfile:88-101` is downloaded over HTTPS without a `sha256sum -c` against a pinned digest. Trust depends on HTTPS + GitHub's release infrastructure. Upgrade to checksum-verified or to upstream `cloudflare/cloudflared:<tag>` image when convenient.
- Base images pinned by tag (`node:22-alpine`, `alpine:3.20`, `nginx:1.27-alpine`) rather than by `@sha256:` digest. Pin by digest + Dependabot is the standard move for v1; the v1 plan's release-automation step covers it.
- UI runtime image has no `USER` directive. nginx:alpine drops to the `nginx` user from PID 1; defense-in-depth adds `USER nginx` after the static-asset copy.
- `actions/checkout@v4` runs without `with: { persist-credentials: false }` on the read-only jobs. Combined with the now-fixed top-level `permissions: contents: read`, the residual amplification surface is small.

## Verifications passed

These were re-confirmed during the review and are stated here so the disposition is auditable:

- **Encoding parity (the build-blocker risk).** TS prover's FS preimage matches the canonical bytes for 1000 random vectors per N ∈ {2,3,4,6,8} for Schnorr / DHTuple / sigma-OR. Aiken-side parity KAT (`contracts/lib/lovejoin/encoding_parity_kat.test.ak`) green via `aiken check` (378 tests).
- **Mix `ctx` excludes the fee-contract output.** [offchain/src/tx/mix.ts:408-431](../offchain/src/tx/mix.ts) `computeMixCtx` iterates only `outputDatums[0..N-1]` and `outputValues[0..N-1]`. The validator side at [contracts/validators/mix_logic.ak:162-181](../contracts/validators/mix_logic.ak) does the same. Avoids the circular `tx.fee ← proof_size ← ctx ← tx.fee` dependency the spec warns about.
- **Subgroup check on all G1 uncompress callsites.** Both off-chain (`@noble/curves` `assertValidity`) and on-chain (Aiken's `bls12_381_g1_uncompress` builtin). Validators additionally reject `a == b`.
- **All `pg` queries parameterised.** No string concatenation of user input. Verified at [backend/src/db/dbsync.ts:118-330](../backend/src/db/dbsync.ts).
- **No analytics, no telemetry, no cookies.** Verified end-to-end: backend has no telemetry deps and `logger: false`; UI has no analytics SDKs, no `document.cookie`, no service worker, no third-party CDN scripts; nginx config sets no `Set-Cookie`.
- **Wallet-derived seed is deterministic + domain-separated.** `seed = blake2b_256(SEED_DOMAIN_TAG_V1 || stake_addr_utf8 || sig_bytes)`; per-deposit `x_i` via HKDF-SHA256 with `info = OWNER_HKDF_TAG_V1 || u32_be(index)`, reduced mod `r`. Stake-only address requirement enforced. Determinism asserted by tests at [offchain/test/wallet/seed.test.ts](../offchain/test/wallet/seed.test.ts).
- **No signature material is logged anywhere.** Grep for `console.log/warn/error/debug/info` of `signature`, `seed`, `x`, `secret`, `priv`, `key`, `scalar`, `nonce`, `k`, `randomness` returned no matches in `offchain/src/crypto/` or `offchain/src/wallet/`.
- **No `Math.random` in any crypto path.** Fresh-CSPRNG draws use `crypto.getRandomValues` with rejection sampling at [offchain/src/tx/deposit.ts:206-214](../offchain/src/tx/deposit.ts).
- **No hardcoded secrets in source or in `.do/` configs.** All `type: SECRET` env vars in [.do/app.yaml](../.do/app.yaml) ship with `value: ""` and are dashboard-set at deploy time. `gh api repos/.../actions/secrets` shows no committed secrets.

## Re-run confirmation

After the fixes landed:

- `cd backend && pnpm test` → 62/62 passing.
- `cd backend && pnpm lint` → green (`tsc --noEmit && eslint .`).
- `cd contracts && aiken check` → 378/378 passing (unchanged; no validator code modified).
- `cd offchain && pnpm vitest run test/crypto/encoding-parity.test.ts` → 4/4 passing, 1000 vectors per N green.

## Disclosure posture

This PR makes the SECURITY.md disclosure address (`support@logicalmechanism.io` placeholder, `security@lovejo.in` once the domain is registered) credible: a reporter sending a P0/P1 finding gets a real triage process, not boilerplate. The commit history at the time of the v1.0.0 tag will include this review pass + the fixes; future external reports are evaluated against this same severity classification and will land as separate PRs with their own review docs.

For the v1.0.0 release we explicitly do NOT claim third-party audit. The "Unaudited / Preprod only" disclosure UX (issue [#45](https://github.com/logical-mechanism/Lovejoin/issues/45)) makes that clear in the product itself. Mainnet deployment is gated on independent audit (OQ-M, OQ-Y).
