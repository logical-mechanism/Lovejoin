// "Mix this box" — shard-mode mix tx that force-includes a single
// owned box. Used by the per-row action button in the Vault table.
// The protocol's pure-random shared mix can take many rounds to
// actually move a specific box; this surfaces "advance THIS box" as
// an explicit user action. The remaining N-1 inputs are picked
// uniformly at random from the live pool (excluding in-flight refs
// and the box itself). Wallet anonymity is preserved: feePayer
// "shard" means no wallet input or signature, just like the Pool
// screen's shared-mix path.
//
// Extracted from routes/Vault.tsx during the issue #97 split so the
// route module stays under 350 lines and the workflow can be unit-
// tested independently of the JSX.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildMixTx,
  isInputCollisionError,
  pickRandomNTuple,
  type MixInput,
  type Utxo,
} from "@lovejoin/sdk";

import { useBackendStatus } from "../components/BackendStatus.js";
import { useCollateralStatus } from "../components/CollateralProviderStatus.js";
import { useToast } from "../components/Toaster.js";
import { BackendClient } from "./backend.js";
import { friendlyErrorMessage } from "./errors.js";
import { fetchPoolDirect, type DirectPoolEntry } from "./pool.js";
import { useAppState } from "./store.js";
import type { OwnedBox } from "./vault.js";

export interface UseMixThisBox {
  /** `${txId}#${outputIndex}` of the box currently being mixed, or null. */
  mixingRef: string | null;
  /** Run the workflow against `box`. Returns when the tx submits or fails. */
  runMix: (box: OwnedBox) => Promise<void>;
  /** True when the configured collateral provider is reachable. */
  collateralOk: boolean;
  /** N for the shard-mode tx, taken from the runtime cap. */
  maxNShard: number;
}

export function useMixThisBox(): UseMixThisBox {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    config,
    provider,
    addresses,
    wallet,
    ownedBoxes,
    pendingTxRefs,
    markTxPending,
    rescan,
    refreshWalletBalance,
  } = useAppState();
  const collateral = useCollateralStatus();
  const backend = useBackendStatus();
  const [mixingRef, setMixingRef] = useState<string | null>(null);
  const collateralOk = collateral?.status === "online";
  const maxNShard = addresses?.protocol.max_n_shard ?? addresses?.protocol.max_n ?? 2;

  const runMix = async (box: OwnedBox): Promise<void> => {
    if (!provider || !addresses) return;
    const refKey = `${box.entry.ref.txId.toLowerCase()}#${box.entry.ref.outputIndex}`;
    if (mixingRef) return;
    if (pendingTxRefs.has(refKey)) return;
    if (!collateralOk) {
      toast.push({
        tone: "error",
        title: t("vault.mix_disabled_collateral"),
      });
      return;
    }
    setMixingRef(refKey);
    try {
      // Fetch the live pool. Backend-first / Blockfrost-fallback,
      // mirroring the Pool screen — we want the freshest data here
      // since we're about to spend specific UTxOs.
      const useBackend =
        !!config.backendUrl && (backend?.status === "synced" || backend?.status === "syncing");
      let entries: DirectPoolEntry[] | null = null;
      if (useBackend) {
        try {
          const client = new BackendClient(config.backendUrl);
          const page = await client.pool({ limit: 500 });
          if (page) {
            const fromBackend = page.boxes.map((b) => ({
              ref: { txId: b.txHash.toLowerCase(), outputIndex: b.outputIndex },
              a: hexToBytes(b.a),
              b: hexToBytes(b.b),
            }));
            if (backend?.status === "synced" || fromBackend.length > 0) {
              entries = fromBackend;
            }
          }
        } catch {
          /* fall through to Blockfrost */
        }
      }
      if (!entries) {
        entries = await fetchPoolDirect({ provider, addresses });
      }

      // Mempool-aware in-flight set so we don't accidentally pick a
      // box that's already an input to another pending tx — same
      // union the Pool screen's MixButton uses.
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
          /* mempool fetch failed; rely on retry path */
        }
      }

      const otherEligible = entries.filter((e) => {
        const k = `${e.ref.txId.toLowerCase()}#${e.ref.outputIndex}`;
        return k !== refKey && !inFlightRefs.has(k);
      });
      if (otherEligible.length < maxNShard - 1) {
        toast.push({
          tone: "error",
          title: t("vault.mix_disabled_pool", {
            have: otherEligible.length + 1,
            need: maxNShard,
          }),
        });
        return;
      }
      // Re-shape entries into the SDK's PoolEntry-compatible form for
      // the random sampler (ref + a + b is enough — `pickRandomNTuple`
      // doesn't read the rest).
      const pickFrom = otherEligible.map((e) => ({
        ref: e.ref,
        a: e.a,
        b: e.b,
        utxo: {
          ref: e.ref,
          address: "",
          lovelace: BigInt(addresses.protocol.denom_lovelace),
          assets: {},
          inlineDatum: null,
          referenceScript: null,
        } satisfies Utxo,
      }));
      const fillers = pickRandomNTuple({ pool: pickFrom, n: maxNShard - 1 });
      const denom = BigInt(addresses.protocol.denom_lovelace);
      const ownerInput: MixInput = {
        ref: box.entry.ref,
        a: box.entry.a,
        b: box.entry.b,
        utxo: {
          ref: box.entry.ref,
          address: "",
          lovelace: denom,
          assets: {},
          inlineDatum: null,
          referenceScript: null,
        },
      };
      const inputs: MixInput[] = [
        ownerInput,
        ...fillers.map<MixInput>((e) => ({
          ref: e.ref,
          a: e.a,
          b: e.b,
          utxo: e.utxo,
        })),
      ];
      const excludeFeeShardRefs = inFlightRefs.size
        ? Array.from(inFlightRefs).flatMap((k) => {
            const hash = k.indexOf("#");
            if (hash <= 0) return [];
            const idx = Number(k.slice(hash + 1));
            return Number.isInteger(idx) && idx >= 0
              ? [{ txId: k.slice(0, hash), outputIndex: idx }]
              : [];
          })
        : undefined;
      const result = await buildMixTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        inputs,
        ...(wallet ? { wallet } : {}),
        provider,
        addresses,
        feePayer: "shard",
        ...(excludeFeeShardRefs ? { excludeFeeShardRefs } : {}),
        retry: { maxAttempts: 3, delayBetweenAttemptsMs: 2_000 },
      });
      // Mark every owned box that ended up on this tx as pending so
      // the rows dim out + lock until the rescan confirms the spend.
      // The clicked box is always one. In a small / test pool the
      // random fillers can also land on the user's own boxes (the
      // pool may even be mostly theirs); marking those too prevents
      // them from getting double-selected for a parallel mix or
      // withdraw before this tx confirms.
      const ownedRefSet = new Set(
        ownedBoxes.map((b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`),
      );
      const ownedFillerRefs = fillers
        .map((e) => `${e.ref.txId.toLowerCase()}#${e.ref.outputIndex}`)
        .filter((k) => ownedRefSet.has(k));
      markTxPending([refKey, ...ownedFillerRefs]);
      toast.push({
        tone: "success",
        title: t("toast.mix_success", { n: maxNShard }),
        txHash: result.txId,
        network: config.network,
      });
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      const busy = isInputCollisionError(err);
      toast.push({
        tone: "error",
        title: busy ? t("tx.busy_title") : t("toast.mix_failed"),
        detail: busy ? t("tx.busy_detail") : friendlyErrorMessage((err as Error).message, t),
      });
    } finally {
      setMixingRef(null);
      void refreshWalletBalance();
    }
  };

  return { mixingRef, runMix, collateralOk, maxNShard };
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
