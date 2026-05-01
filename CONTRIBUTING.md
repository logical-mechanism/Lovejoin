# Contributing to lovejoin

Thanks for thinking about contributing. Lovejoin is a Cardano-native privacy mixer (Sigmajoin) and a hyperstructure: the on-chain protocol is permissionless and immutable. The off-chain SDK, backend, and UI are all open for contribution.

This guide covers what you need to know to get a change landed.

## Before you start

- Read [README.md](README.md) for the 5-minute summary.
- Read [CLAUDE.md](CLAUDE.md) for the architectural pillars and conventions baked into the codebase.
- For anything non-trivial, skim the relevant spec file under [docs/spec/](docs/spec/). The spec is canonical; the README is a summary.
- Check open issues to see whether someone is already on it: `gh issue list --state open`.
- For larger changes, open an issue first to align on scope. We would rather discuss for 10 minutes than ask you to rewrite a 500-line PR.

If you are reporting a security issue, **do not open a public issue**. See [SECURITY.md](SECURITY.md).

## Dev setup

Requirements:

- node >= 20 (nvm recommended; see the node-binary note in the README)
- pnpm 10
- aiken 1.1.21 (pinned in [contracts/aiken.toml](contracts/aiken.toml))

Bootstrap the workspace:

```sh
make install
```

The Makefile is the canonical entry point. `make help` lists everything. The most useful targets day-to-day:

```sh
make build          # aiken check + tsc + vite build
make test           # aiken check + vitest in offchain, backend, ui
make lint           # tsc --noEmit + eslint + prettier --check + aiken fmt --check
make format         # prettier --write + eslint --fix
make contracts      # just `aiken check`
make ui-dev         # vite dev server on http://localhost:5173
make backend-dev    # fastify backend in watch mode
make clean          # remove dist/, build/, target/
```

A husky `pre-commit` hook runs `lint-staged` (prettier + eslint --fix on staged files). Fix locally rather than reaching for `--no-verify`.

## Branch and PR model

- Default integration branch: **`dev`**. PRs target `dev`, then `dev` rolls up to `main` periodically.
- Never commit directly to `main` or `dev`.
- Branch naming:
  - GitHub issues: `issue/<n>-<short-slug>` (e.g. `issue/39-repo-governance`).
  - Spec milestones (M0 through M7): `milestone/<id>-<slug>` (e.g. `milestone/m1-cryptography-variable-n`).
  - Standalone fixes / features: `feat/<short-slug>` or `fix/<short-slug>`.
- One scope per branch and PR. If you discover an unrelated fix, file a follow-up issue and land it separately.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `chore(scope): ...`, `docs(scope): ...`. Reference the issue in a trailer (`Refs #N` or `Closes #N`).
- Many small green commits beat one giant squash. Push periodically.

When opening a PR (`gh pr create --base dev`), the PR template will prompt for what changed, how it was tested, and which spec section is affected. Fill it out; reviewers rely on it.

## Changelog

User-visible changes get an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), in the same PR as the change. Add it under the appropriate `### Added` / `### Changed` / `### Fixed` / `### Removed` heading.

Pre-v1.0.0 we use date-based sections, not SemVer. **On `dev → main` rollup day**, whoever opens the rollup PR renames the `## [Unreleased]` section to `## [YYYY-MM-DD]` and opens a fresh empty `## [Unreleased]` block above it. We will switch to SemVer at v1.0.0; until then, dated entries match the actual cadence.

## Tests

- Every new file with logic gets a test file. Minimum: one happy-path and at least one failure mode.
- Crypto, serialization, and on-chain validators target byte-exact KAT vectors. The Rust reference impl in [crypto/](crypto/) is the cross-language ground truth; vectors live in [crypto/test-vectors/](crypto/test-vectors/).
- Validator tests in [contracts/](contracts/) target 100% spec-rule coverage. CI fails if a rule from [docs/spec/03-contracts.md](docs/spec/03-contracts.md) sections 1 through 3 lacks a positive and a negative test.
- UI strings: lovejoin ships in 20 locales. When you add or change a string, update the canonical English file (`ui/src/i18n/locales/en.json`) and the 19 non-English locale files in the same change. The lint rule rejects raw English in JSX.
- For Cardano-touching code, prefer real Preprod via env-var URLs over mocks. If Preprod is unreachable, ask in the issue rather than mocking.
- `aiken simulate` is not a faithful chain emulator for `serialise_data` round-trips. Build parity tests from record literals; see [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md).

## Code style

- TypeScript / JavaScript / JSON / Markdown: prettier + eslint, configured at the repo root. `make format` runs them.
- Aiken: `aiken fmt`. `make lint` checks both.
- Indentation, EOL, charset: enforced by [.editorconfig](.editorconfig).
- Avoid em-dashes in user-facing copy. Use periods, semicolons, colons, or commas instead. En-dashes in proper nouns (Fiat-Shamir) are fine.
- No emojis in committed source unless explicitly part of the design.
- No internal milestone references (M-numbers) in user-facing UI strings.

## Privacy and security guardrails

- **Never** add analytics, telemetry, or cookies to the UI or backend. Backend logs IPs only for rate limiting, retention under 24 hours.
- **Never** weaken the wallet-anonymity properties of Mix txs. The collateral provider abstraction in [offchain/src/tx/collateral.ts](offchain/src/tx/collateral.ts) exists for this reason; do not fall back to wallet collateral for Mix.
- **Never** call Blockfrost directly from new code. Add capabilities to `ChainProvider` ([offchain/src/chain/provider.ts](offchain/src/chain/provider.ts)) and let both implementations grow.
- TS / Aiken byte-encoding parity is a silent killer. Before writing or changing any sigma-protocol code, run the parity tests; see [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md) section "Risk 1".

## Where to ask questions

- Open a GitHub issue with the `question` label.
- For private or security-sensitive questions, email **support@logicalmechanism.io**. See [SECURITY.md](SECURITY.md) for the disclosure policy.

## Code of conduct

By participating in this project you agree to abide by the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
