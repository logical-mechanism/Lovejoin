// "Mix N random boxes" button — the Pool screen's primary CTA.
//
// Spec: §"Pool" + M6.5 — picks N boxes uniformly at
// random from the pool, picks a fee shard, requests collateral, builds +
// submits the Mix tx. M6.5 restored the fee-payer toggle (shard | wallet)
// the M6 implementation hard-coded.
//
// Hard-disabled when the collateral provider is unreachable (Privacy UX
// rule 8). Cooldown of 5 s after each click prevents accidental
// double-submission while a tx is in flight.
//
// Wallet handling: shard-mode submission is wallet-anonymous by design —
// no wallet input, no wallet signature, collateral signed by giveme.my.
// The button is therefore reachable WITHOUT a connected wallet on the
// shard path: anyone can submit mix txs to the public pool, which
// improves linkage probability for everyone. Wallet-mode still requires
// a wallet (the wallet pays the fee + signs); the button disables
// itself with an inline hint when that combination is selected without
// a wallet present.
//
// Box-selection strategy (see pickMixInputs):
//   * Shard mode → uniform random over the whole pool. The whole point
//     of the shared path is "truly random" — submitter anonymity is
//     wasted if the on-chain shape of the inputs leaks who picked.
//   * Wallet mode + locked vault / no owned boxes / no owned in pool →
//     uniform random. We can't bias toward unknown owned boxes.
//   * Wallet mode + small pool (< POOL_BIAS_THRESHOLD) + at least one
//     owned box visible in the pool → force-include exactly one of the
//     submitter's own boxes, fill the rest from non-owned. The wallet's
//     pkh is already on the tx (it pays the fee), so an observer can
//     correlate submitter→inputs anyway; the privacy floor isn't moved
//     by force-inclusion. What it DOES buy is real progress for the
//     fee they're spending — an early-pool user paying for wallet-mode
//     wants to actively advance their own box's anonymity.
//   * Wallet mode + healthy pool (≥ POOL_BIAS_THRESHOLD) → uniform
//     random. In a healthy pool the natural-random hit rate on owned
//     boxes is high enough that biasing is unnecessary, and "wallet-fee
//     mix tx ALWAYS includes one of submitter's boxes" would leak a
//     correlatable pattern across many txs — which random selection
//     in a populated pool naturally avoids.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  buildMixTx,
  type ChainProvider,
  type LovejoinAddresses,
  type MixFeePayer,
  type MixInput,
  type Utxo,
} from "@lovejoin/sdk";

import { BackendClient } from "../lib/backend.js";
import { formatAda } from "../lib/format.js";
import type { Network } from "../lib/sdk.js";
import { useAppState } from "../lib/store.js";
import { useBackendStatus } from "./BackendStatus.js";
import { useCollateralStatus, useRefreshCollateralStatus } from "./CollateralProviderStatus.js";
import { Modal } from "./ui/Modal.js";

/** Pool-size cutoff for wallet-mode owned-box biasing. See header comment. */
const POOL_BIAS_THRESHOLD = 8;

const COOLDOWN_MS = 5000;

/**
 * How long a locally-submitted Mix's inputs stay in the in-flight set.
 * Mainnet/preprod block times are ~20 s, so 90 s comfortably covers a
 * tx that lands in the next 3–4 blocks. Beyond that the tx is either
 * confirmed (the indexer rebuilds the pool without it) or has been
 * dropped from the node mempool (in which case the user can retry
 * fresh). Tuned for the Blockfrost-only path where we can't read the
 * node's mempool directly.
 */
const LOCAL_INFLIGHT_TTL_MS = 90_000;

/**
 * Threshold above which we log a depth warning to the browser console.
 * NOT a hard cap — the natural stopping conditions are (a) fee-shard
 * depletion, which the SDK's `minLovelace` filter handles automatically,
 * (b) Cardano's mempool tx-graph limits, and (c) the backend's
 * 32-entry `additionalUtxoSet` cap on `/evaluate`. Orphan cascade is
 * not a "lost money" scenario for Mix txs (a rolled-back chain is just
 * "no progress"; no collateral is burned, no fees are paid for txs
 * that never confirmed), so a longer chain is fine in practice. The
 * warning helps spot runaway clicking in dev tools.
 */
const CHAIN_DEPTH_WARN_THRESHOLD = 5;

export interface MixButtonProps {
  network: Network;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  /**
   * Connected CIP-30 wallet, or null. Shard-mode submission works with
   * either; wallet-mode requires a non-null wallet (it pays the fee +
   * signs the tx).
   */
  wallet: BrowserWallet | null;
  /** Pool of boxes to pick from (already filtered to mix-script address). */
  poolEntries: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  n: number;
  /** Who pays the tx fee. "shard" pulls from the on-chain pool; "wallet" charges the submitter. */
  feePayer: MixFeePayer;
  onSubmitted: (txId: string) => void;
  onError: (message: string) => void;
  /**
   * Bubbled to the parent so it can wrap its section in a busy overlay
   * the moment the user confirms — the build/sign/submit takes 5–10 s
   * and the button alone is too small a feedback target for that wait.
   */
  onSubmittingChange?: (submitting: boolean) => void;
}

export function MixButton({
  network,
  provider,
  addresses,
  wallet,
  poolEntries,
  n,
  feePayer,
  onSubmitted,
  onError,
  onSubmittingChange,
}: MixButtonProps) {
  const { t } = useTranslation();
  const { config, ownedBoxes, markTxPending, pendingTxRefs, walletLovelace, refreshWalletBalance } =
    useAppState();
  const backend = useBackendStatus();
  const [submitting, setSubmitting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cooldownTimer = useRef<number | null>(null);
  const collateral = useCollateralStatus();
  const refreshCollateral = useRefreshCollateralStatus();

  // Locally-tracked refs the user has just spent in a Mix tx submitted
  // from THIS component. The backend mempool feed is the authoritative
  // source for in-flight inputs, but on Blockfrost-only deploys it
  // isn't available and Blockfrost's address-UTxO endpoint lags the
  // node's mempool by seconds-to-minutes. Without a local tracker a
  // rapid-fire click sequence picks the same in-flight mix-boxes
  // (`pickMixInputs` sees them in `poolEntries` because Blockfrost still
  // lists them as live) and the chain rejects the second tx with
  // `BadInputsUTxO`. Entries are pruned past `LOCAL_INFLIGHT_TTL_MS` so
  // the set doesn't grow without bound across a long session.
  const recentlySpentRefs = useRef<Map<string, number>>(new Map());

  // Locally-tracked outputs from Mix txs submitted via THIS component
  // that haven't confirmed yet — these become eligible inputs to the
  // NEXT chained Mix. Each entry carries:
  //   * PoolEntry: lets pickMixInputs treat the unconfirmed mix-box
  //     as a normal pool candidate.
  //   * Utxo: forwarded to SDK as chainFrom.utxos so every evaluator
  //     on the path (local mesh, giveme.my upstream) sees the in-flight
  //     output. Without this the SDK builds a tx that references a
  //     UTxO no evaluator can find, and aborts at `tx.complete()`.
  // Cleared after LOCAL_INFLIGHT_TTL_MS or when a refresh confirms the
  // parent (whichever comes first). The "submitted at" timestamp is
  // used for TTL pruning.
  const recentMixOutputs = useRef<
    Map<
      string,
      {
        poolEntry: { ref: { txId: string; outputIndex: number }; a: Uint8Array; b: Uint8Array };
        utxo: Utxo;
        submittedAt: number;
      }
    >
  >(new Map());

  // Locally-tracked post-state fee shards from in-flight Mix txs. The
  // next chained Mix can consume one of these via `feeShardExtras`
  // instead of waiting for confirmation. Tracked separately from
  // recentMixOutputs because the SDK's fee-shard picker has its own
  // include-polarity slot. Same TTL.
  const recentFeeShardOutputs = useRef<Map<string, { utxo: Utxo; submittedAt: number }>>(new Map());

  // Set of owned box refs for the wallet-mode bias strategy. Empty when
  // the vault is locked, when the user has no boxes, or when nothing
  // they own is currently in the pool — pickMixInputs falls back to
  // pure random in any of those cases. Memoized on `ownedBoxes` so it
  // doesn't churn each render of the Pool screen.
  const ownedRefSet = useMemo(
    () => new Set(ownedBoxes.map((b) => refKey(b.entry.ref))),
    [ownedBoxes],
  );

  useEffect(() => {
    return () => {
      if (cooldownTimer.current !== null) {
        window.clearInterval(cooldownTimer.current);
      }
    };
  }, []);

  const collateralOk = collateral?.status === "online";
  const enoughBoxes = poolEntries.length >= n && n >= 2;
  // Wallet-mode pays the fee from a wallet UTxO and needs a wallet
  // signature; without a connected wallet there's no path to build
  // that tx. Shard-mode has no such constraint.
  const walletModeNeedsWallet = feePayer === "wallet" && !wallet;
  // Soft balance hint for wallet-mode mix. ~3 ADA covers the tx fee
  // + change min-utxo with headroom; advisory only, no hard gate.
  const mixWalletRequiredLovelace = 3_000_000n;
  const walletModeBalanceShort =
    feePayer === "wallet" &&
    !!wallet &&
    walletLovelace !== null &&
    walletLovelace < mixWalletRequiredLovelace;
  const disabled =
    submitting || cooldown > 0 || !collateralOk || !enoughBoxes || walletModeNeedsWallet;

  const onRequestSubmit = () => {
    if (disabled) return;
    // Wallet-fee mode: the wallet's signTx prompt IS the confirmation
    // — showing a modal first is a redundant click. Shard-fee mode has
    // no signing prompt (the tx is submitter-anonymous), so the modal
    // is still the only surface where the user actually confirms.
    if (feePayer === "wallet") {
      void onConfirmSubmit();
      return;
    }
    setConfirmOpen(true);
  };

  const onConfirmSubmit = async () => {
    if (disabled) return;
    setConfirmOpen(false);
    setSubmitting(true);
    setRetryAttempt(null);
    onSubmittingChange?.(true);
    try {
      // In-flight refs come from two sources:
      //   1. Backend mempool snapshot — every input to every pending tx
      //      currently sitting in the node's mempool, regardless of who
      //      submitted it. Backend-only.
      //   2. Local `pendingTxRefs` — owned-box refs the user themselves
      //      just submitted (Withdraw or a previous Mix that picked one
      //      of their boxes). Surfaces locally-known spends that haven't
      //      hit the chain yet, and works on Blockfrost-only deploys
      //      where the mempool snapshot is unavailable.
      // We use the union for two filters:
      //   * Pool-box exclusion: drop any box already in flight.
      //   * Fee-shard exclusion: forwarded to the SDK so
      //     pickRandomFeeShard avoids in-flight shards (passed as
      //     excludeFeeShardRefs).
      const useBackend =
        !!config.backendUrl && (backend?.status === "synced" || backend?.status === "syncing");
      const inFlightRefs = new Set<string>(pendingTxRefs);
      if (useBackend) {
        try {
          const client = new BackendClient(config.backendUrl);
          const snap = await client.mempoolInputs();
          if (snap) {
            for (const r of snap.inputs) {
              inFlightRefs.add(`${r.txHash.toLowerCase()}#${r.outputIndex}`);
            }
          }
        } catch {
          /* mempool fetch failed; fall through to retry-only */
        }
      }
      // Splice in this session's locally-tracked spent refs. Prunes
      // anything older than LOCAL_INFLIGHT_TTL_MS so the set doesn't
      // accumulate across a long session — past that window either the
      // tx has confirmed (and Blockfrost's pool view caught up) or it
      // was dropped from the node mempool (in which case re-picking is
      // safe). Belt-and-braces against the rapid-click race when
      // backend mempool isn't available.
      const nowMs = Date.now();
      for (const [refStr, spentAt] of recentlySpentRefs.current.entries()) {
        if (nowMs - spentAt > LOCAL_INFLIGHT_TTL_MS) {
          recentlySpentRefs.current.delete(refStr);
        } else {
          inFlightRefs.add(refStr);
        }
      }
      // Prune the in-flight Mix-output trackers in lockstep. Also drop
      // any output whose ref already shows in `poolEntries` — that
      // means the parent Mix has confirmed and the output is a normal
      // pool candidate now, not "in-flight". This is how chain depth
      // naturally decreases as parents land.
      const poolRefSet = new Set(poolEntries.map((e) => refKey(e.ref)));
      for (const [refStr, entry] of recentMixOutputs.current.entries()) {
        if (nowMs - entry.submittedAt > LOCAL_INFLIGHT_TTL_MS || poolRefSet.has(refStr)) {
          recentMixOutputs.current.delete(refStr);
        }
      }
      for (const [refStr, entry] of recentFeeShardOutputs.current.entries()) {
        if (nowMs - entry.submittedAt > LOCAL_INFLIGHT_TTL_MS) {
          recentFeeShardOutputs.current.delete(refStr);
        }
      }

      // Count distinct parent txids carrying unconfirmed Mix outputs.
      // This is the chain depth — purely informational. The natural
      // upper bounds are fee-shard depletion (SDK's `minLovelace` filter
      // drops a shard below the 3-ADA floor), Cardano's mempool
      // tx-graph limit, and the backend's 32-entry additionalUtxoSet
      // cap. No hard UI cap: a rolled-back chain just means "no
      // progress", not "lost funds".
      const chainParents = new Set(
        [...recentMixOutputs.current.values()].map((e) => e.poolEntry.ref.txId),
      );
      const chainDepth = chainParents.size;
      const inFlightMixOutputs = [...recentMixOutputs.current.values()];
      const inFlightFeeShards = [...recentFeeShardOutputs.current.values()];
      if (chainDepth > 0) {
        const warn = chainDepth >= CHAIN_DEPTH_WARN_THRESHOLD ? " (heads up: long chain)" : "";
        console.log(
          `[lovejoin/ui] in-flight chain detected: depth=${chainDepth}, ` +
            `${inFlightMixOutputs.length} mix-box(es) + ${inFlightFeeShards.length} fee shard(s) ` +
            `available as chainFrom inputs${warn}`,
        );
      }

      const poolForPicking =
        inFlightRefs.size > 0
          ? poolEntries.filter((e) => !inFlightRefs.has(refKey(e.ref)))
          : poolEntries;
      // Splice in-flight Mix outputs into the picker pool so they are
      // eligible candidates (capped at MAX_CHAIN_DEPTH). Dedupe by ref
      // — if the parent confirmed between fetch and submit, the entry
      // is already in poolEntries.
      const pickPoolWithChain =
        inFlightMixOutputs.length > 0
          ? [
              ...poolForPicking,
              ...inFlightMixOutputs
                .filter(
                  (e) => !poolForPicking.some((p) => refKey(p.ref) === refKey(e.poolEntry.ref)),
                )
                .map((e) => e.poolEntry),
            ]
          : poolForPicking;
      // If filtering left too few boxes for the chosen N, fall back to
      // the full pool. The retry path will catch the resulting collision
      // if it happens; better than refusing to mix at all.
      const effectivePool = pickPoolWithChain.length >= n ? pickPoolWithChain : poolEntries;
      const picked = pickMixInputs({
        pool: effectivePool,
        n,
        feePayer,
        ownedRefs: ownedRefSet,
      });
      const excludeFeeShardRefs =
        feePayer === "shard" && inFlightRefs.size > 0
          ? Array.from(inFlightRefs).flatMap((key) => {
              const hash = key.indexOf("#");
              if (hash <= 0) return [];
              const idx = Number(key.slice(hash + 1));
              return Number.isInteger(idx) && idx >= 0
                ? [{ txId: key.slice(0, hash), outputIndex: idx }]
                : [];
            })
          : undefined;
      // Build MixInputs. When a picked entry corresponds to a tracked
      // in-flight Mix output, use the recorded Utxo (correct address +
      // inline-datum); for confirmed pool entries we substitute the
      // standard placeholder (the SDK only needs ref+a+b+lovelace for
      // confirmed inputs because mesh's evaluator can resolve them
      // from chain).
      const pickedRefSet = new Set(picked.map((e) => refKey(e.ref)));
      const inFlightInputsUtxos: Utxo[] = inFlightMixOutputs
        .filter((e) => pickedRefSet.has(refKey(e.poolEntry.ref)))
        .map((e) => e.utxo);
      const inFlightInputUtxoByRef = new Map(
        inFlightInputsUtxos.map((u) => [refKey(u.ref), u] as const),
      );
      const inputs = picked.map<MixInput>((e) => {
        const recorded = inFlightInputUtxoByRef.get(refKey(e.ref));
        const utxo: Utxo = recorded ?? {
          ref: e.ref,
          address: "",
          lovelace: BigInt(addresses.protocol.denom_lovelace),
          assets: {},
          inlineDatum: null,
          referenceScript: null,
        };
        return { ref: e.ref, a: e.a, b: e.b, utxo };
      });

      // chainFrom carries ALL surviving in-flight Mix outputs — not
      // just the ones we picked — because the upstream evaluator may
      // want to resolve neighbouring outputs (e.g. the fee shard) as
      // well. Empty array means "no chaining".
      const chainFromUtxos = [...inFlightInputsUtxos, ...inFlightFeeShards.map((e) => e.utxo)];
      const result = await buildMixTx({
        network: network as "preprod" | "preview" | "mainnet",
        inputs,
        // SDK accepts `wallet?` and validates per-mode internally —
        // shard mode + giveme.my succeeds with `undefined`, wallet
        // mode throws if it isn't here. The disabled calc above
        // already gates the wallet-mode-without-wallet case, so this
        // null→undefined coercion only ever runs for shard mode.
        ...(wallet ? { wallet } : {}),
        provider,
        addresses,
        feePayer,
        ...(excludeFeeShardRefs ? { excludeFeeShardRefs } : {}),
        ...(inFlightFeeShards.length > 0
          ? { feeShardExtras: inFlightFeeShards.map((e) => e.utxo) }
          : {}),
        ...(chainFromUtxos.length > 0
          ? { chainFrom: { utxos: chainFromUtxos, chainDepth: chainDepth + 1 } }
          : {}),
        retry: {
          maxAttempts: 3,
          delayBetweenAttemptsMs: 2_000,
          onRetry: (info) => setRetryAttempt(info.attempt),
        },
      });
      // Mark any of the user's own boxes that ended up as Mix inputs
      // as pending so the Vault row dims out until the rescan
      // confirms the spend. Only relevant when wallet-mode + bias hit
      // (or shard-mode pure-random happened to grab one), so most
      // submits write zero refs here.
      const ownedInputs = picked.map((e) => refKey(e.ref)).filter((key) => ownedRefSet.has(key));
      if (ownedInputs.length > 0) {
        markTxPending(ownedInputs);
      }
      // Record EVERY picked ref (mix-boxes + fee shard) so a rapid
      // re-click can't re-pick the same UTxOs while this tx is still
      // propagating. This is the unconditional companion to
      // markTxPending (which only fires for owned boxes for Vault UX).
      // Without this the chain rejects the second click with
      // `BadInputsUTxO` on Blockfrost-only deploys where the mempool
      // feed isn't available.
      const submittedAt = Date.now();
      for (const inp of picked) {
        recentlySpentRefs.current.set(refKey(inp.ref), submittedAt);
      }
      const submittedFeeShard = result.plan.feeShardInput;
      if (submittedFeeShard) {
        recentlySpentRefs.current.set(refKey(submittedFeeShard.ref), submittedAt);
      }
      // If any of the picked inputs were themselves in-flight Mix
      // outputs from a previous click, drop them from the tracker —
      // they've now been consumed by THIS tx and won't be available
      // for further chaining.
      for (const inp of picked) {
        recentMixOutputs.current.delete(refKey(inp.ref));
      }
      // Same for the in-flight fee shard, if we consumed one.
      if (submittedFeeShard) {
        recentFeeShardOutputs.current.delete(refKey(submittedFeeShard.ref));
      }

      // Capture THIS Mix's OUTPUTS as candidates for the next chained
      // click. Mix outputs live at positions 0..N-1 of result.txId;
      // the fee-shard output (shard mode only) lives at position N.
      // Both inherit the protocol's denom_lovelace + canonical mix-box
      // address; the inline datums come straight from the SDK plan.
      const newTxId = result.txId.toLowerCase();
      const denomLovelace = BigInt(addresses.protocol.denom_lovelace);
      for (let i = 0; i < result.plan.outputs.length; i++) {
        const planOutput = result.plan.outputs[i]!;
        const outRef = { txId: newTxId, outputIndex: i };
        const outKey = refKey(outRef);
        const childUtxo: Utxo = {
          ref: outRef,
          address: result.plan.mixBoxAddressBech32,
          lovelace: denomLovelace,
          assets: {},
          inlineDatum: planOutput.inlineDatumHex,
          referenceScript: null,
        };
        recentMixOutputs.current.set(outKey, {
          poolEntry: { ref: outRef, a: planOutput.a, b: planOutput.b },
          utxo: childUtxo,
          submittedAt,
        });
      }
      // Post-state fee shard output (shard mode only). Mesh emits it
      // immediately after the mix-boxes — index N. The SDK plan tells
      // us its bech32 + datum + lovelace.
      const newShardOutput = result.plan.feeShardOutput;
      if (newShardOutput && result.plan.feePayer === "shard") {
        const shardRef = { txId: newTxId, outputIndex: result.plan.n };
        recentFeeShardOutputs.current.set(refKey(shardRef), {
          utxo: {
            ref: shardRef,
            address: newShardOutput.addressBech32,
            lovelace: newShardOutput.lovelace,
            assets: {},
            inlineDatum: newShardOutput.inlineDatumHex,
            referenceScript: null,
          },
          submittedAt,
        });
      }
      onSubmitted(result.txId);
      startCooldown();
    } catch (e) {
      onError((e as Error).message);
      refreshCollateral();
    } finally {
      setSubmitting(false);
      setRetryAttempt(null);
      onSubmittingChange?.(false);
      void refreshWalletBalance();
    }
  };

  const startCooldown = () => {
    setCooldown(COOLDOWN_MS / 1000);
    if (cooldownTimer.current !== null) window.clearInterval(cooldownTimer.current);
    cooldownTimer.current = window.setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownTimer.current !== null) window.clearInterval(cooldownTimer.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onRequestSubmit}
        disabled={disabled}
        className="lj-btn lj-btn--primary lj-btn--lg"
      >
        {submitting && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
        {submitting
          ? t("pool.mix_submitting")
          : cooldown > 0
            ? t("pool.mix_cooldown", { s: cooldown })
            : t("pool.mix_n_random_boxes", { n })}
      </button>
      {!collateralOk && <p className="text-xs text-amber">{t("pool.mix_disabled_collateral")}</p>}
      {collateralOk && !enoughBoxes && (
        <p className="text-xs text-whisper">
          {t("pool.mix_disabled_pool", { have: poolEntries.length, need: n })}
        </p>
      )}
      {collateralOk && enoughBoxes && walletModeNeedsWallet && (
        <p className="text-xs text-whisper">{t("pool.mix_disabled_wallet_needed")}</p>
      )}
      {walletModeBalanceShort && walletLovelace !== null && (
        <p className="text-xs text-amber">
          {t("wallet.insufficient_balance", {
            have: formatAda(walletLovelace),
            need: formatAda(mixWalletRequiredLovelace),
          })}
        </p>
      )}
      {retryAttempt !== null && (
        <p className="text-xs text-amber">
          {t("tx.retrying_collision", { attempt: retryAttempt })}
        </p>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("pool.confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("pool.confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("pool.confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {feePayer === "shard" ? t("pool.confirm_lede_shard") : t("pool.confirm_lede_wallet")}
          </p>
        </header>
        <dl className="lj-banner lj-banner--signal flex-col items-stretch gap-3">
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_width")}</dt>
            <dd className="font-mono text-sm text-paper" data-num>
              {n}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_fee_path")}</dt>
            <dd className="text-sm text-paper">
              {feePayer === "shard"
                ? t("pool.review_fee_path_shard")
                : t("pool.review_fee_path_wallet")}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_collateral")}</dt>
            <dd className="text-sm text-muted">
              {feePayer === "shard"
                ? t("pool.review_collateral_value_shard")
                : t("pool.review_collateral_value_wallet")}
            </dd>
          </div>
        </dl>
        <footer className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setConfirmOpen(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            onClick={() => void onConfirmSubmit()}
          >
            {t("pool.confirm_submit")}
          </button>
        </footer>
      </Modal>
    </div>
  );
}

/** Stable Set key for a UTxO ref. Lowercase tx-hash to match indexer canon. */
function refKey(ref: { txId: string; outputIndex: number }): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

/**
 * Mix-input picker with the shard / wallet / owned-bias strategy spelled
 * out in the file header. Pure function — exported for unit tests so we
 * can pin every branch (random, biased, biased-fallback).
 *
 * Returns an array of length `n`. Caller is responsible for ensuring
 * `pool.length >= n` (the MixButton's `enoughBoxes` gate enforces it).
 *
 * Branch table:
 *   shard mode                              → uniform random
 *   wallet mode + owned set empty           → uniform random
 *   wallet mode + nothing owned in pool     → uniform random
 *   wallet mode + pool ≥ POOL_BIAS_THRESHOLD → uniform random
 *   wallet mode + small pool + owned in pool:
 *     - if non-owned has ≥ n-1 entries → 1 random owned + (n-1) random non-owned
 *     - else (owned dominates the pool) → uniform random over the whole pool
 */
export function pickMixInputs<T extends { ref: { txId: string; outputIndex: number } }>(args: {
  pool: ReadonlyArray<T>;
  n: number;
  feePayer: MixFeePayer;
  ownedRefs: ReadonlySet<string>;
}): T[] {
  const { pool, n, feePayer, ownedRefs } = args;

  const useBias = feePayer === "wallet" && ownedRefs.size > 0 && pool.length < POOL_BIAS_THRESHOLD;

  if (!useBias) {
    return pickRandomBoxes(pool, n);
  }

  const ownedInPool = pool.filter((e) => ownedRefs.has(refKey(e.ref)));
  if (ownedInPool.length === 0) {
    // Vault unlocked but none of the user's boxes are currently in the
    // pool — no bias possible, fall back to uniform random.
    return pickRandomBoxes(pool, n);
  }

  const notOwned = pool.filter((e) => !ownedRefs.has(refKey(e.ref)));
  if (notOwned.length < n - 1) {
    // The user owns most or all of the small pool — fall back to uniform
    // random. Forcing a 1-owned + (n-1)-non-owned shape isn't possible.
    return pickRandomBoxes(pool, n);
  }

  const ownedPick = ownedInPool[Math.floor(Math.random() * ownedInPool.length)]!;
  const others = pickRandomBoxes(notOwned, n - 1);
  return [ownedPick, ...others];
}

function pickRandomBoxes<T>(items: ReadonlyArray<T>, n: number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}
