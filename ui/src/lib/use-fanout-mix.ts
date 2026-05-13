// Fan-out submit orchestration, lifted out of <FanoutMixPanel> so the
// unified <MixPanel> can render the same progress UI for k≥2 without
// owning the wave-event reducer or the slow-hint timer.
//
// Responsibilities:
//   • Memoize the root box (first non-in-flight owned box) and the
//     eligible-pool slice (everything except the root and in-flight refs).
//   • Compute live stats. totalMixes / boxesTouched / linkage /
//     freshNeeded / worst-case fee. for the review block.
//   • Drive the submitFanout async iterator, fold events into a progress
//     reducer, surface a "slow slot" amber hint after 5 s of silence,
//     and schedule a post-run rescan.
//
// The hook is the canonical home for these behaviours; the renderer is
// pure UI.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  fanoutBoxesTouched,
  fanoutLinkageProbability,
  fanoutTotalMixes,
  planFanout,
  submitFanout,
  type ChainProvider,
  type FanoutEvent,
  type FanoutPlan,
  type FanoutSlotId,
  type LovejoinAddresses,
  type PoolEntry,
  type Utxo,
} from "@lovejoin/sdk";

import { useToast } from "../components/Toaster.js";
import { friendlyErrorMessage } from "./errors.js";
import type { Network } from "./sdk.js";
import { useAppState } from "./store.js";
import type { OwnedBox } from "./vault.js";

export type ProgressState = {
  /** Total slots in the running plan. */
  total: number;
  /** Slots that have been submitted to giveme.my so far. */
  submitted: number;
  /** Slots that failed at build/submit time. */
  failed: number;
  /** The most recent wave the orchestrator entered. */
  currentWave: number | null;
  /** Submitted slot IDs in order. */
  submittedIds: FanoutSlotId[];
  /** Dropped slot IDs (failed parents + their cascaded descendants). */
  droppedIds: Set<FanoutSlotId>;
};

export interface FanoutStats {
  totalMixes: number;
  boxesTouched: number;
  freshNeeded: number;
  linkage: number;
  totalFeeLovelace: bigint;
}

export interface UseFanoutSubmitArgs {
  network: Network;
  provider: ChainProvider | null;
  addresses: LovejoinAddresses | null;
  wallet: BrowserWallet | null;
  ownedBoxes: ReadonlyArray<OwnedBox>;
  poolEntries: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  depth: number;
}

export interface UseFanoutSubmitResult {
  running: boolean;
  progress: ProgressState | null;
  showSlowHint: boolean;
  confirmOpen: boolean;
  rootBox: OwnedBox | null;
  eligiblePool: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  stats: FanoutStats;
  hasOwned: boolean;
  poolBigEnough: boolean;
  disabled: boolean;
  requestSubmit: () => void;
  confirmSubmit: () => Promise<void>;
  cancelConfirm: () => void;
  cancelRun: () => void;
}

export function useFanoutSubmit(args: UseFanoutSubmitArgs): UseFanoutSubmitResult {
  const { network, provider, addresses, wallet, ownedBoxes, poolEntries, depth } = args;
  const { t } = useTranslation();
  const toast = useToast();
  const { pendingTxRefs, markTxPending, rescan, refreshWalletBalance } = useAppState();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const cancelToken = useRef<{ cancelled: boolean }>({ cancelled: false });

  useEffect(() => {
    if (!running || lastProgressAt === null) {
      setShowSlowHint(false);
      return;
    }
    const id = window.setInterval(() => {
      const elapsed = Date.now() - lastProgressAt;
      setShowSlowHint(elapsed > 5000);
    }, 1000);
    return () => window.clearInterval(id);
  }, [running, lastProgressAt]);

  const denomLovelace = addresses ? BigInt(addresses.protocol.denom_lovelace) : 0n;
  const maxFeePerMixLovelace = addresses ? BigInt(addresses.protocol.max_fee_per_mix_lovelace) : 0n;

  const rootBox = useMemo<OwnedBox | null>(() => {
    for (const ob of ownedBoxes) {
      if (!pendingTxRefs.has(refKey(ob.entry.ref))) return ob;
    }
    return null;
  }, [ownedBoxes, pendingTxRefs]);

  const stats = useMemo<FanoutStats>(() => {
    const totalMixes = fanoutTotalMixes(depth);
    const boxesTouched = fanoutBoxesTouched(depth);
    const freshNeeded = boxesTouched - 1;
    const linkage = fanoutLinkageProbability(depth);
    const totalFeeLovelace = maxFeePerMixLovelace * BigInt(totalMixes);
    return { totalMixes, boxesTouched, freshNeeded, linkage, totalFeeLovelace };
  }, [depth, maxFeePerMixLovelace]);

  const eligiblePool = useMemo(() => {
    const rootRef = rootBox ? refKey(rootBox.entry.ref) : null;
    return poolEntries.filter((e) => {
      const k = refKey(e.ref);
      if (k === rootRef) return false;
      if (pendingTxRefs.has(k)) return false;
      return true;
    });
  }, [poolEntries, rootBox, pendingTxRefs]);

  const hasOwned = rootBox !== null;
  const poolBigEnough = eligiblePool.length >= stats.freshNeeded;
  const providerReady = !!provider && !!addresses;
  const disabled = !providerReady || running || !hasOwned || !poolBigEnough;

  const requestSubmit = () => {
    if (disabled) return;
    setConfirmOpen(true);
  };

  const cancelConfirm = () => setConfirmOpen(false);

  const cancelRun = () => {
    cancelToken.current.cancelled = true;
    setRunning(false);
  };

  const confirmSubmit = async () => {
    if (disabled || !rootBox || !provider || !addresses) return;
    setConfirmOpen(false);
    setRunning(true);
    cancelToken.current = { cancelled: false };
    const total = stats.totalMixes;
    setProgress({
      total,
      submitted: 0,
      failed: 0,
      currentWave: null,
      submittedIds: [],
      droppedIds: new Set(),
    });
    const rootRef = rootBox.entry.ref;
    markTxPending([refKey(rootRef)]);
    try {
      const pool: PoolEntry[] = eligiblePool.map((e) => ({
        ref: e.ref,
        a: e.a,
        b: e.b,
        utxo: synthPoolUtxo(e.ref, denomLovelace),
      }));
      const plan: FanoutPlan = planFanout({ rootBox: rootBox.entry, pool, depth });
      markTxPending(plan.poolRefsUsed.map((r) => refKey(r)));
      const events = submitFanout({
        plan,
        network,
        provider,
        addresses,
        ...(wallet ? { wallet } : {}),
        retry: { maxAttempts: 3, delayBetweenAttemptsMs: 2_000 },
      });
      setLastProgressAt(Date.now());
      const summary = await consumeEvents(events, (evt) => {
        if (cancelToken.current.cancelled) return;
        if (evt.kind === "slot-failed") {
          console.warn(
            `[lovejoin/fanout] slot ${evt.slotId} (wave ${evt.waveIndex + 1}) failed: ` +
              `${evt.error.message}`,
          );
        }
        setLastProgressAt(Date.now());
        setProgress((prev) => (prev ? applyEventToProgress(prev, evt) : null));
      });
      if (summary.failedSlots.size === 0) {
        toast.push({
          tone: "success",
          title: t("fanout.toast_success", {
            count: summary.submittedSlots.size,
          }),
        });
      } else {
        toast.push({
          tone: "error",
          title: t("fanout.toast_partial", {
            submitted: summary.submittedSlots.size,
            failed: summary.failedSlots.size,
          }),
        });
      }
    } catch (err) {
      toast.push({
        tone: "error",
        title: t("fanout.toast_failed"),
        detail: friendlyErrorMessage((err as Error).message, t),
      });
    } finally {
      setRunning(false);
      window.setTimeout(() => void rescan(), 15_000);
      void refreshWalletBalance();
    }
  };

  return {
    running,
    progress,
    showSlowHint,
    confirmOpen,
    rootBox,
    eligiblePool,
    stats,
    hasOwned,
    poolBigEnough,
    disabled,
    requestSubmit,
    confirmSubmit,
    cancelConfirm,
    cancelRun,
  };
}

export function applyEventToProgress(prev: ProgressState, evt: FanoutEvent): ProgressState {
  switch (evt.kind) {
    case "wave-started":
      return { ...prev, currentWave: evt.waveIndex };
    case "slot-submitted":
      return {
        ...prev,
        submitted: prev.submitted + 1,
        submittedIds: [...prev.submittedIds, evt.slotId],
      };
    case "slot-failed": {
      const droppedIds = new Set(prev.droppedIds);
      for (const id of evt.droppedDescendants) droppedIds.add(id);
      return {
        ...prev,
        failed: prev.failed + evt.droppedDescendants.length,
        droppedIds,
      };
    }
    case "plan-completed":
    case "wave-completed":
      return prev;
    default: {
      const exhaustive: never = evt;
      void exhaustive;
      return prev;
    }
  }
}

async function consumeEvents(
  iter: AsyncIterable<FanoutEvent>,
  onEvent: (evt: FanoutEvent) => void,
): Promise<{
  submittedSlots: Map<FanoutSlotId, unknown>;
  failedSlots: Map<FanoutSlotId, Error>;
  droppedSlots: Set<FanoutSlotId>;
  completed: { submittedSlots: number; failedSlots: number } | null;
}> {
  const summary = {
    submittedSlots: new Map<FanoutSlotId, unknown>(),
    failedSlots: new Map<FanoutSlotId, Error>(),
    droppedSlots: new Set<FanoutSlotId>(),
    completed: null as { submittedSlots: number; failedSlots: number } | null,
  };
  for await (const evt of iter) {
    onEvent(evt);
    if (evt.kind === "slot-submitted") {
      summary.submittedSlots.set(evt.slotId, evt.result);
    } else if (evt.kind === "slot-failed") {
      summary.failedSlots.set(evt.slotId, evt.error);
      for (const id of evt.droppedDescendants) summary.droppedSlots.add(id);
    } else if (evt.kind === "plan-completed") {
      summary.completed = { submittedSlots: evt.submittedSlots, failedSlots: evt.failedSlots };
    }
  }
  return summary;
}

function refKey(ref: { txId: string; outputIndex: number }): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

function synthPoolUtxo(ref: { txId: string; outputIndex: number }, denomLovelace: bigint): Utxo {
  return {
    ref,
    address: "",
    lovelace: denomLovelace,
    assets: {},
    inlineDatum: null,
    referenceScript: null,
  };
}
