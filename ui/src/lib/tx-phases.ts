// Phase definitions for the in-flight tx progress indicator.
//
// Keeping the (label, estimateMs) tuples here means the three call sites
// (deposit / withdraw / mix) stay free of magic numbers and the timings
// can be re-tuned in one place against the live p50/p95.

import type { TFunction } from "i18next";

import type { TxBuildPhase } from "../components/TxBuildProgress.js";

type TFn = TFunction;

export function depositPhases(t: TFn): TxBuildPhase[] {
  return [
    { label: t("tx_progress.deposit.derive"), estimateMs: 300 },
    { label: t("tx_progress.deposit.shard"), estimateMs: 800 },
    { label: t("tx_progress.deposit.build"), estimateMs: 1500 },
    { label: t("tx_progress.deposit.sign"), estimateMs: 2500 },
    { label: t("tx_progress.deposit.submit"), estimateMs: 1500 },
  ];
}

export function donatePhases(t: TFn): TxBuildPhase[] {
  return [
    { label: t("tx_progress.donate.shard"), estimateMs: 600 },
    { label: t("tx_progress.donate.build"), estimateMs: 1500 },
    { label: t("tx_progress.donate.sign"), estimateMs: 2500 },
    { label: t("tx_progress.donate.submit"), estimateMs: 1500 },
  ];
}

export function withdrawPhases(t: TFn): TxBuildPhase[] {
  return [
    { label: t("tx_progress.withdraw.proof"), estimateMs: 800 },
    { label: t("tx_progress.withdraw.collateral"), estimateMs: 1500 },
    { label: t("tx_progress.withdraw.build"), estimateMs: 1500 },
    { label: t("tx_progress.withdraw.sign"), estimateMs: 2500 },
    { label: t("tx_progress.withdraw.submit"), estimateMs: 1500 },
  ];
}

export function mixPhases(t: TFn, n: number): TxBuildPhase[] {
  // Proof generation dominates; estimate scales with N (roughly N×1.5s in
  // the browser at the deployed validator). Floor at 2s so the bar isn't
  // already past the proof step on N=2 by the time the user reads it.
  const proofMs = Math.max(2000, n * 1500);
  return [
    { label: t("tx_progress.mix.select"), estimateMs: 400 },
    { label: t("tx_progress.mix.shard"), estimateMs: 800 },
    { label: t("tx_progress.mix.proof", { n }), estimateMs: proofMs },
    { label: t("tx_progress.mix.collateral"), estimateMs: 1500 },
    { label: t("tx_progress.mix.build"), estimateMs: 1500 },
    { label: t("tx_progress.mix.submit"), estimateMs: 1500 },
  ];
}
