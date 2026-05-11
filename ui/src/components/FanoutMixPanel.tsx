// Fan-out Mix panel — issue #137.
//
// "Privacy boost" CTA that runs a depth-k tree of Mix txs against the
// user's most recent owned box. The single-tx MixButton above this
// panel mixes ONE pool slice; this panel chains several such mixes so
// every box the user touched in the previous wave is re-mixed in the
// next. After k waves the user's branch is one of 3^k indistinguishable
// branches (linkage (1/3)^k).
//
// Hidden when:
//   * vault is locked (no owned boxes) — surfaces a hint pointing to
//     /vault, and the panel stays inert.
//   * pool is too small to fan out at minimum depth 2 — surfaces a hint
//     listing the pool size and the needed count.
//
// The user PAYS for the privacy of boxes they don't own; the disclosure
// copy is the load-bearing piece of UI here. Issue #137:
//   "You are paying fees to mix boxes you don't own. This is what makes
//    your branch indistinguishable from theirs."

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  collectFanoutResults,
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

import { friendlyErrorMessage } from "../lib/errors.js";
import { formatAda } from "../lib/format.js";
import type { Network } from "../lib/sdk.js";
import type { OwnedBox } from "../lib/vault.js";
import { useToast } from "./Toaster.js";
import { Modal } from "./ui/Modal.js";

// Default depth the slider lands on for first-time users. Linkage
// (1/3)^2 ≈ 11% — meaningful boost over a single mix at minimal cost
// (4 txs total).
const DEFAULT_DEPTH = 2;

// Depths visible in the slider without `?advanced=1`. Issue #137 says
// "1–3 to start; 4 gated behind ?advanced=1 until empirically
// validated". We don't offer depth 1 because a depth-1 fan-out IS a
// single Mix tx — that's what MixButton above this panel already does.
const VISIBLE_DEPTHS = [2, 3] as const;
const ADVANCED_DEPTHS = [2, 3, 4] as const;

export interface FanoutMixPanelProps {
  network: Network;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  wallet: BrowserWallet | null;
  /** The unlocked vault's owned boxes; first entry is used as the root. */
  ownedBoxes: ReadonlyArray<OwnedBox>;
  /** The current public pool (already filtered to mix-script address). */
  poolEntries: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  /** When true, the depth-4 option becomes selectable. */
  advanced: boolean;
}

type ProgressState = {
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

export function FanoutMixPanel(props: FanoutMixPanelProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [depth, setDepth] = useState<number>(DEFAULT_DEPTH);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const cancelToken = useRef<{ cancelled: boolean }>({ cancelled: false });

  const allowedDepths = props.advanced ? ADVANCED_DEPTHS : VISIBLE_DEPTHS;
  const denomLovelace = BigInt(props.addresses.protocol.denom_lovelace);
  const maxFeePerMixLovelace = BigInt(props.addresses.protocol.max_fee_per_mix_lovelace);

  // Derived stats for the current depth. The pool size + owned-box gate
  // both feed in — disabled state and the disclosure-row copy depend on
  // these. We don't actually `planFanout` here (it allocates and runs
  // RNG); the math helpers cover the user-visible numbers.
  const stats = useMemo(() => {
    const totalMixes = fanoutTotalMixes(depth);
    const boxesTouched = fanoutBoxesTouched(depth);
    // Fresh pool boxes needed = boxesTouched - 1 (the root is owned).
    const freshNeeded = boxesTouched - 1;
    const linkage = fanoutLinkageProbability(depth);
    // Pessimistic fee = max_fee_per_mix × totalMixes (real fee is
    // typically half this once the evaluator runs, but we surface the
    // worst case so the user isn't surprised).
    const totalFeeLovelace = maxFeePerMixLovelace * BigInt(totalMixes);
    return { totalMixes, boxesTouched, freshNeeded, linkage, totalFeeLovelace };
  }, [depth, maxFeePerMixLovelace]);

  // Eligible pool = every entry except the root the planner is going to
  // pin to wave 0. `planFanout` auto-excludes the root from its
  // sampler, so we trust that here and just subtract 1 for the
  // pre-flight count. Other owned boxes ARE eligible as fresh inputs;
  // re-mixing them through the tree still amplifies anonymity (the
  // user keeps the secret since `b' = [y]·b = [x]·a'`), and excluding
  // them would block solo testing on a pool the user dominates.
  const rootRefKey = useMemo(
    () => (props.ownedBoxes[0] ? refKey(props.ownedBoxes[0].entry.ref) : null),
    [props.ownedBoxes],
  );
  const eligiblePoolCount = useMemo(() => {
    if (!rootRefKey) return props.poolEntries.length;
    return props.poolEntries.filter((e) => refKey(e.ref) !== rootRefKey).length;
  }, [props.poolEntries, rootRefKey]);

  const hasOwned = props.ownedBoxes.length > 0;
  const poolBigEnough = eligiblePoolCount >= stats.freshNeeded;
  const disabled = running || !hasOwned || !poolBigEnough;

  const onConfirm = async () => {
    if (disabled) return;
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
    try {
      const root = props.ownedBoxes[0]!.entry;
      // Pass the full pool (minus the root, which planFanout
      // auto-excludes) — including other owned boxes. The planner's
      // exclude-set ensures no box is reused inside the plan.
      const pool: PoolEntry[] = props.poolEntries.map((e) => ({
        ref: e.ref,
        a: e.a,
        b: e.b,
        utxo: synthPoolUtxo(e.ref, denomLovelace),
      }));
      const plan: FanoutPlan = planFanout({ rootBox: root, pool, depth });
      const events = submitFanout({
        plan,
        network: props.network,
        provider: props.provider,
        addresses: props.addresses,
        ...(props.wallet ? { wallet: props.wallet } : {}),
        retry: { maxAttempts: 3, delayBetweenAttemptsMs: 2_000 },
      });
      const summary = await consumeEvents(events, (evt) => {
        if (cancelToken.current.cancelled) return;
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
    }
  };

  const onCancel = () => {
    // The orchestrator's iterator doesn't expose a true cancel today
    // (issue #137 follow-up). Toggling cancelled stops UI mutations and
    // marks the run as orphaned in the user's view; any in-flight mix
    // already with giveme.my will still land. Visible button is gated
    // so the user understands.
    cancelToken.current.cancelled = true;
    setRunning(false);
  };

  return (
    <>
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <span className="lj-eyebrow">{t("fanout.eyebrow")}</span>
            <h2 className="lj-card__title">{t("fanout.section_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">{t("fanout.lede")}</p>

        <div className="mt-6 flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="lj-eyebrow" id="fanout-depth-label">
              {t("fanout.depth_label")}
            </span>
            <div className="lj-toggle" role="group" aria-labelledby="fanout-depth-label">
              {allowedDepths.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={depth === d}
                  onClick={() => setDepth(d)}
                  disabled={running}
                >
                  {t("fanout.depth_option", { d })}
                </button>
              ))}
            </div>
            <p className="text-xs text-whisper basis-full leading-relaxed">
              {t("fanout.depth_hint", {
                d: depth,
                percent: (stats.linkage * 100).toFixed(1),
              })}
            </p>
          </div>
        </div>

        <div className="lj-review mt-8" role="group" aria-label={t("fanout.review_title")}>
          <span className="lj-eyebrow">{t("fanout.review_title")}</span>
          <dl className="lj-review__rows">
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("fanout.review_total_mixes")}</dt>
              <dd className="lj-review__value lj-review__value--num" data-num>
                {stats.totalMixes}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("fanout.review_boxes_touched")}</dt>
              <dd className="lj-review__value lj-review__value--num" data-num>
                {stats.boxesTouched}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("fanout.review_linkage")}</dt>
              <dd className="lj-review__value">{t("fanout.review_linkage_value", { d: depth })}</dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("fanout.review_total_fee")}</dt>
              <dd className="lj-review__value">
                {t("fanout.review_total_fee_value", {
                  ada: formatAda(stats.totalFeeLovelace),
                })}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("fanout.review_pool")}</dt>
              <dd className="lj-review__value lj-review__value--muted">
                {t("fanout.review_pool_value", {
                  have: eligiblePoolCount,
                  need: stats.freshNeeded,
                })}
              </dd>
            </div>
          </dl>
        </div>

        <div className="lj-banner lj-banner--signal mt-6 flex-col items-stretch">
          <p className="lj-banner__title">{t("fanout.disclosure_title")}</p>
          <p className="lj-banner__detail">{t("fanout.disclosure_body")}</p>
        </div>

        {!hasOwned && <p className="mt-6 text-xs text-amber">{t("fanout.gate_no_owned_boxes")}</p>}
        {hasOwned && !poolBigEnough && (
          <p className="mt-6 text-xs text-amber">
            {t("fanout.gate_pool_too_small", {
              have: eligiblePoolCount,
              need: stats.freshNeeded,
            })}
          </p>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="lj-btn lj-btn--primary lj-btn--lg"
            onClick={() => setConfirmOpen(true)}
            disabled={disabled}
          >
            {running && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
            {running ? t("fanout.running", { d: depth }) : t("fanout.run_button", { d: depth })}
          </button>
          {running && (
            <button type="button" className="lj-btn lj-btn--quiet" onClick={onCancel}>
              {t("fanout.cancel_button")}
            </button>
          )}
        </div>

        {progress && <FanoutProgressDisplay progress={progress} />}
      </section>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("fanout.confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("fanout.confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("fanout.confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {t("fanout.confirm_lede", {
              count: stats.totalMixes,
              boxes: stats.boxesTouched,
              ada: formatAda(stats.totalFeeLovelace),
            })}
          </p>
        </header>
        <dl className="lj-banner lj-banner--signal flex-col items-stretch gap-3">
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("fanout.review_total_mixes")}</dt>
            <dd className="font-mono text-sm text-paper" data-num>
              {stats.totalMixes}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("fanout.review_linkage")}</dt>
            <dd className="text-sm text-paper">{t("fanout.review_linkage_value", { d: depth })}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("fanout.review_total_fee")}</dt>
            <dd className="text-sm text-paper">
              {t("fanout.review_total_fee_value", {
                ada: formatAda(stats.totalFeeLovelace),
              })}
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
          <button type="button" className="lj-btn lj-btn--primary" onClick={() => void onConfirm()}>
            {t("fanout.confirm_submit")}
          </button>
        </footer>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Progress display
// ---------------------------------------------------------------------------

function FanoutProgressDisplay({ progress }: { progress: ProgressState }) {
  const { t } = useTranslation();
  const done = progress.submitted + progress.failed;
  const pct = progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
  return (
    <div className="mt-6 flex flex-col gap-3">
      <p className="lj-eyebrow">{t("fanout.progress_title")}</p>
      <p className="text-sm text-muted">
        {t("fanout.progress_summary", {
          done,
          total: progress.total,
          submitted: progress.submitted,
          failed: progress.failed,
        })}
      </p>
      <div className="lj-progress" aria-label={t("fanout.progress_title")}>
        <div
          className="lj-progress__bar"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {progress.currentWave !== null && (
        <p className="text-xs text-whisper">
          {t("fanout.progress_current_wave", { wave: progress.currentWave + 1 })}
        </p>
      )}
      {progress.droppedIds.size > 0 && (
        <p className="text-xs text-amber">
          {t("fanout.progress_dropped", { count: progress.droppedIds.size })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event → state reducer
// ---------------------------------------------------------------------------

function applyEventToProgress(prev: ProgressState, evt: FanoutEvent): ProgressState {
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
): Promise<Awaited<ReturnType<typeof collectFanoutResults>>> {
  // Re-implement collectFanoutResults inline so we get a hook for live
  // event observation. Kept tiny — UI just wants the final tally + a
  // streaming callback.
  const summary = {
    submittedSlots: new Map<
      FanoutSlotId,
      FanoutEvent extends { kind: "slot-submitted"; result: infer R } ? R : never
    >(),
    failedSlots: new Map<FanoutSlotId, Error>(),
    droppedSlots: new Set<FanoutSlotId>(),
    completed: null as { submittedSlots: number; failedSlots: number } | null,
  };
  for await (const evt of iter) {
    onEvent(evt);
    if (evt.kind === "slot-submitted") {
      summary.submittedSlots.set(evt.slotId, evt.result as never);
    } else if (evt.kind === "slot-failed") {
      summary.failedSlots.set(evt.slotId, evt.error);
      for (const id of evt.droppedDescendants) summary.droppedSlots.add(id);
    } else if (evt.kind === "plan-completed") {
      summary.completed = { submittedSlots: evt.submittedSlots, failedSlots: evt.failedSlots };
    }
  }
  return summary as Awaited<ReturnType<typeof collectFanoutResults>>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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
