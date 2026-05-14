// Single-Mix submit machinery, lifted out of <MixButton> so the unified
// <MixPanel> can host both single-tx and fan-out flows behind one CTA.
//
// Responsibilities:
//   • Track refs the user has just spent in a Mix tx submitted from this
//     session (recentlySpentRefs). prevents rapid-fire re-clicks from
//     picking the same UTxOs while propagating.
//   • Track in-flight Mix outputs + post-state fee shards so the NEXT
//     chained Mix can consume them (recentMixOutputs / recentFeeShardOutputs).
//   • Union local + backend-mempool in-flight refs for both pool-box
//     exclusion AND fee-shard exclusion.
//   • Drive a 5 s cooldown timer after each successful submit.
//   • Surface a confirmOpen flag for shard-mode (wallet-mode skips the
//     modal because wallet.signTx IS the confirmation).
//
// The hook is the canonical home for these behaviours; the renderer is
// pure UI.

import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserWallet } from "@meshsdk/core";
import {
  buildMixTx,
  type ChainProvider,
  type LovejoinAddresses,
  type MixFeePayer,
  type MixInput,
  type Utxo,
} from "@lovejoin/sdk";

import { BackendClient } from "./backend.js";
import { useAppState } from "./store.js";
import { useBackendStatus } from "../components/BackendStatus.js";
import {
  useCollateralStatus,
  useRefreshCollateralStatus,
} from "../components/CollateralProviderStatus.js";
import { pickMixInputs } from "./pick-mix-inputs.js";
import type { Network } from "./sdk.js";

const COOLDOWN_MS = 5000;

/**
 * How long a locally-submitted Mix's inputs stay in the in-flight set.
 * Mainnet/preprod block times are ~20 s, so 90 s comfortably covers a
 * tx that lands in the next 3–4 blocks.
 */
const LOCAL_INFLIGHT_TTL_MS = 90_000;

/** Console-warning threshold for chain-depth; not a hard cap. */
const CHAIN_DEPTH_WARN_THRESHOLD = 5;

export interface UseSingleMixArgs {
  network: Network;
  provider: ChainProvider | null;
  addresses: LovejoinAddresses | null;
  wallet: BrowserWallet | null;
  poolEntries: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  n: number;
  feePayer: MixFeePayer;
  onSubmitted: (txId: string) => void;
  onError: (message: string) => void;
  onSubmittingChange?: (submitting: boolean) => void;
}

export interface UseSingleMixResult {
  submitting: boolean;
  cooldown: number;
  retryAttempt: number | null;
  confirmOpen: boolean;
  collateralOk: boolean;
  enoughBoxes: boolean;
  walletModeNeedsWallet: boolean;
  walletModeBalanceShort: boolean;
  walletLovelace: bigint | null;
  mixWalletRequiredLovelace: bigint;
  disabled: boolean;
  requestSubmit: () => void;
  confirmSubmit: () => Promise<void>;
  cancelConfirm: () => void;
}

export function useSingleMix(args: UseSingleMixArgs): UseSingleMixResult {
  const {
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
  } = args;

  const { config, ownedBoxes, markTxPending, pendingTxRefs, walletLovelace, refreshWalletBalance } =
    useAppState();
  const backend = useBackendStatus();
  const collateral = useCollateralStatus();
  const refreshCollateral = useRefreshCollateralStatus();

  const [submitting, setSubmitting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cooldownTimer = useRef<number | null>(null);

  const recentlySpentRefs = useRef<Map<string, number>>(new Map());
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
  const recentFeeShardOutputs = useRef<Map<string, { utxo: Utxo; submittedAt: number }>>(new Map());

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
  const providerReady = !!provider && !!addresses;
  const enoughBoxes = poolEntries.length >= n && n >= 2;
  const walletModeNeedsWallet = feePayer === "wallet" && !wallet;
  const mixWalletRequiredLovelace = 3_000_000n;
  const walletModeBalanceShort =
    feePayer === "wallet" &&
    !!wallet &&
    walletLovelace !== null &&
    walletLovelace < mixWalletRequiredLovelace;
  const disabled =
    !providerReady ||
    submitting ||
    cooldown > 0 ||
    !collateralOk ||
    !enoughBoxes ||
    walletModeNeedsWallet;

  const requestSubmit = () => {
    if (disabled) return;
    if (feePayer === "wallet") {
      void confirmSubmit();
      return;
    }
    setConfirmOpen(true);
  };

  const cancelConfirm = () => setConfirmOpen(false);

  const confirmSubmit = async () => {
    if (disabled || !provider || !addresses) return;
    setConfirmOpen(false);
    setSubmitting(true);
    setRetryAttempt(null);
    onSubmittingChange?.(true);
    try {
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

      const nowMs = Date.now();
      for (const [refStr, spentAt] of recentlySpentRefs.current.entries()) {
        if (nowMs - spentAt > LOCAL_INFLIGHT_TTL_MS) {
          recentlySpentRefs.current.delete(refStr);
        } else {
          inFlightRefs.add(refStr);
        }
      }
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

      const chainFromUtxos = [...inFlightInputsUtxos, ...inFlightFeeShards.map((e) => e.utxo)];
      const result = await buildMixTx({
        network: network as "preprod" | "preview" | "mainnet",
        inputs,
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
      const ownedInputs = picked.map((e) => refKey(e.ref)).filter((key) => ownedRefSet.has(key));
      if (ownedInputs.length > 0) {
        markTxPending(ownedInputs);
      }
      const submittedAt = Date.now();
      for (const inp of picked) {
        recentlySpentRefs.current.set(refKey(inp.ref), submittedAt);
      }
      const submittedFeeShard = result.plan.feeShardInput;
      if (submittedFeeShard) {
        recentlySpentRefs.current.set(refKey(submittedFeeShard.ref), submittedAt);
      }
      for (const inp of picked) {
        recentMixOutputs.current.delete(refKey(inp.ref));
      }
      if (submittedFeeShard) {
        recentFeeShardOutputs.current.delete(refKey(submittedFeeShard.ref));
      }

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
      const newShardOutput = result.plan.feeShardOutput;
      if (newShardOutput && result.plan.feePayer === "shard" && result.plan.feeShardInput) {
        const shardRef = { txId: newTxId, outputIndex: result.plan.n };
        const realFee =
          result.actualFeeLovelace ?? result.plan.txFeeLovelace ?? newShardOutput.lovelace;
        const realisticLovelace = result.plan.feeShardInput.lovelace - realFee;
        recentFeeShardOutputs.current.set(refKey(shardRef), {
          utxo: {
            ref: shardRef,
            address: newShardOutput.addressBech32,
            lovelace: realisticLovelace,
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

  return {
    submitting,
    cooldown,
    retryAttempt,
    confirmOpen,
    collateralOk,
    enoughBoxes,
    walletModeNeedsWallet,
    walletModeBalanceShort,
    walletLovelace,
    mixWalletRequiredLovelace,
    disabled,
    requestSubmit,
    confirmSubmit,
    cancelConfirm,
  };
}

function refKey(ref: { txId: string; outputIndex: number }): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}
