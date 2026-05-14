// Unified Mix surface. issue #137 / PR #146 / issue #147.
//
// One panel, one dial, one CTA. Depth k = 1 is a single Mix tx (the
// canonical hyperstructure path, reachable without a connected wallet);
// k ≥ 2 chains k waves of Mix txs into a fan-out tree rooted at one of
// the user's own boxes. Same concept, varying intensity.
//
// Visibility rules:
//   • Fee-payer toggle (shard | wallet) at k = 1 is always available.
//   • Fee-payer toggle at k ≥ 2 (wallet-funded fan-out) is gated on
//     two conditions, both of which must be true:
//       1. A CIP-30 wallet is connected (it has to sign every leaf).
//       2. The wallet is on the chained-tx allowlist
//          (`walletSupportsChainedFanout`). Wallets that don't accept
//          mempool-only inputs at sign time would crash the tree
//          mid-run with no clean recovery; default-deny.
//     Default stays `"shard"` even when the toggle is visible; the user
//     has to opt in via the load-bearing disclosure.
//   • k ≥ 2 needs an unlocked vault (it picks the user's first non-
//     in-flight owned box as the tree's root). k = 1 does not.
//
// Default intensity:
//   • Vault unlocked: k = 2 (the user landed here from /vault or has
//     boxes to fan out; they probably want the boost).
//   • Vault locked: k = 1 (anyone-can-mix flow).
//   • `?intensity=N` query param overrides both.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  walletSupportsChainedFanout,
  type ChainProvider,
  type LovejoinAddresses,
  type MixFeePayer,
} from "@lovejoin/sdk";

import { formatAda } from "../lib/format.js";
import type { Network } from "../lib/sdk.js";
import { useAppState } from "../lib/store.js";
import { useFanoutSubmit } from "../lib/use-fanout-mix.js";
import { useSingleMix } from "../lib/use-single-mix.js";
import { Eyebrow } from "./ui/Eyebrow.js";
import { Modal } from "./ui/Modal.js";
import { WalletModal } from "./WalletModal.js";

const FANOUT_VISIBLE_DEPTHS = [2, 3] as const;
const FANOUT_ADVANCED_DEPTHS = [2, 3, 4] as const;

export interface MixPanelProps {
  network: Network;
  provider: ChainProvider | null;
  addresses: LovejoinAddresses | null;
  wallet: BrowserWallet | null;
  poolEntries: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  /** When true, depth-4 fan-out becomes selectable. */
  advanced: boolean;
  /**
   * Bubbled to the parent so it can wrap its section in a busy overlay
   * the moment the user confirms. The button alone is too small a
   * feedback target for the 5–10 s build/sign/submit wait.
   */
  onSubmittingChange?: (submitting: boolean) => void;
  /** Toast on successful single-Mix submission. */
  onSingleMixSubmitted: (txId: string) => void;
  /** Toast on single-Mix failure. */
  onSingleMixError: (message: string) => void;
  /**
   * Initial intensity (1..max). Clamped to the allowed range. Honored
   * once on mount; user toggles override afterwards. Typically supplied
   * from a `?intensity=N` query param on the Pool route.
   */
  initialIntensity?: number;
}

export function MixPanel(props: MixPanelProps) {
  const { t } = useTranslation();
  const {
    network,
    provider,
    addresses,
    wallet,
    poolEntries,
    advanced,
    onSubmittingChange,
    onSingleMixSubmitted,
    onSingleMixError,
    initialIntensity,
  } = props;
  const { vault, ownedBoxes, unlockWithWallet, vaultBusy, vaultError, setWallet, walletId } =
    useAppState();
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const protocol = addresses?.protocol;
  const legacyMaxN = protocol?.max_n ?? 2;
  const maxNShard = protocol?.max_n_shard ?? legacyMaxN;
  const maxNWallet = protocol?.max_n_wallet ?? legacyMaxN;
  const maxFeePerMixAda = protocol?.max_fee_per_mix_lovelace
    ? formatAda(BigInt(protocol.max_fee_per_mix_lovelace))
    : "?";

  const fanoutDepths = advanced ? FANOUT_ADVANCED_DEPTHS : FANOUT_VISIBLE_DEPTHS;
  const allowedIntensities: number[] = [1, ...fanoutDepths];

  const vaultUnlocked = vault !== null;
  const [intensity, setIntensity] = useState<number>(() => {
    if (initialIntensity && allowedIntensities.includes(initialIntensity)) return initialIntensity;
    return vaultUnlocked ? 2 : 1;
  });

  const [feePayer, setFeePayer] = useState<MixFeePayer>(() => {
    try {
      const stored = window.localStorage.getItem("lovejoin.pool.feePayer");
      if (stored === "shard" || stored === "wallet") return stored;
    } catch {
      /* localStorage unavailable; fall back to default. */
    }
    return "shard";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("lovejoin.pool.feePayer", feePayer);
    } catch {
      /* persistence is nice-to-have, not load-bearing. */
    }
  }, [feePayer]);

  const isFanout = intensity >= 2;

  // Wallet-funded fan-out (issue #147). Default-deny: hidden unless a
  // wallet is connected and the wallet is on the allowlist. Even when
  // visible the default stays "shard"; the user has to deliberately
  // switch via the load-bearing disclosure to opt out of wallet
  // anonymity.
  const fanoutWalletPayerAllowed =
    isFanout && wallet !== null && walletSupportsChainedFanout(walletId);
  const showFeePayerToggle = !isFanout || fanoutWalletPayerAllowed;
  const effectiveFeePayer: MixFeePayer = isFanout
    ? fanoutWalletPayerAllowed
      ? feePayer
      : "shard"
    : feePayer;
  const n = effectiveFeePayer === "shard" ? maxNShard : maxNWallet;

  const single = useSingleMix({
    network,
    provider,
    addresses,
    wallet,
    poolEntries,
    n,
    feePayer: effectiveFeePayer,
    onSubmitted: onSingleMixSubmitted,
    onError: onSingleMixError,
    ...(onSubmittingChange ? { onSubmittingChange } : {}),
  });

  const fanout = useFanoutSubmit({
    network,
    provider,
    addresses,
    wallet,
    ownedBoxes,
    poolEntries,
    depth: isFanout ? intensity : 2,
    feePayer: effectiveFeePayer,
  });

  return (
    <>
      <div className="mt-6 flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Eyebrow id="mix-intensity-label">{t("pool.intensity_eyebrow")}</Eyebrow>
          <div
            className="lj-toggle"
            role="group"
            aria-labelledby="mix-intensity-label"
            aria-describedby="mix-intensity-hint"
          >
            {allowedIntensities.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={intensity === k}
                onClick={() => setIntensity(k)}
                disabled={single.submitting || fanout.running}
              >
                {k === 1
                  ? t("pool.intensity_option_random")
                  : t("pool.intensity_option_fanout", { k })}
              </button>
            ))}
          </div>
          <p id="mix-intensity-hint" className="text-xs text-whisper basis-full leading-relaxed">
            {isFanout
              ? t("pool.intensity_hint_fanout", {
                  k: intensity,
                  mixes: fanout.stats.totalMixes,
                })
              : t("pool.intensity_hint_random")}
          </p>
          {isFanout && (!wallet || !vaultUnlocked) && (
            <div className="basis-full mt-2 flex flex-col items-start gap-2">
              <p className="text-xs text-amber leading-relaxed" role="status">
                {!wallet ? t("pool.depth_needs_wallet") : t("pool.vault_locked_at_depth")}
              </p>
              {!wallet ? (
                <button
                  type="button"
                  className="lj-btn lj-btn--primary"
                  onClick={() => setWalletModalOpen(true)}
                >
                  {t("app.connect_wallet")}
                </button>
              ) : (
                <button
                  type="button"
                  className="lj-btn lj-btn--primary"
                  disabled={vaultBusy}
                  onClick={() => void unlockWithWallet()}
                >
                  {vaultBusy && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
                  {vaultBusy ? t("vault.unlocking") : t("vault.unlock_with_wallet")}
                </button>
              )}
            </div>
          )}
          {isFanout && vaultError && (
            <p className="basis-full text-xs text-coral" role="alert">
              {t("vault.unlock_failed", { message: vaultError })}
            </p>
          )}
        </div>

        {showFeePayerToggle && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Eyebrow id="fee-payer-label">{t("pool.fee_payer_label")}</Eyebrow>
            <div
              className="lj-toggle"
              role="group"
              aria-labelledby="fee-payer-label"
              aria-describedby="fee-payer-hint"
            >
              <button
                type="button"
                aria-pressed={feePayer === "shard"}
                onClick={() => setFeePayer("shard")}
                disabled={single.submitting || fanout.running}
              >
                {t("pool.fee_payer_shard")}
              </button>
              <button
                type="button"
                aria-pressed={feePayer === "wallet"}
                onClick={() => setFeePayer("wallet")}
                disabled={single.submitting || fanout.running}
              >
                {t("pool.fee_payer_wallet")}
              </button>
            </div>
            <p id="fee-payer-hint" className="text-xs text-whisper basis-full leading-relaxed">
              {feePayer === "shard"
                ? t("pool.fee_payer_shard_hint", { cap: maxFeePerMixAda })
                : isFanout
                  ? t("pool.fee_payer_wallet_hint_fanout", { count: fanout.stats.totalMixes })
                  : t("pool.fee_payer_wallet_hint")}
            </p>
          </div>
        )}

        {/* Load-bearing disclosure (issue #147). Wallet-funded fan-out
         *  publishes the user's wallet identity on every leaf in the
         *  tree and asks them to sign N times — both costs the user is
         *  opting INTO when they leave shard mode. The banner is
         *  intentionally above the review block so the user can't miss
         *  it before the confirm modal. */}
        {isFanout && fanoutWalletPayerAllowed && effectiveFeePayer === "wallet" && (
          <div className="lj-banner lj-banner--coral" role="alert">
            <span className="lj-banner__title">{t("pool.fanout_wallet_disclosure_title")}</span>
            <p className="text-xs text-paper leading-relaxed">
              {t("pool.fanout_wallet_disclosure_body", {
                count: fanout.stats.totalMixes,
              })}
            </p>
          </div>
        )}
      </div>

      {isFanout ? (
        <FanoutReviewBlock
          totalMixes={fanout.stats.totalMixes}
          boxesTouched={fanout.stats.boxesTouched}
          depth={intensity}
          totalFeeLovelace={fanout.stats.totalFeeLovelace}
          freshAvailable={fanout.eligiblePool.length}
          freshNeeded={fanout.stats.freshNeeded}
        />
      ) : (
        <SingleReviewBlock
          n={n}
          feePayer={feePayer}
          poolSize={poolEntries.length}
          poolLoading={!addresses || !provider}
        />
      )}

      <ActionArea
        isFanout={isFanout}
        intensity={intensity}
        single={single}
        fanout={fanout}
        n={n}
        poolSize={poolEntries.length}
        ownedBoxCount={ownedBoxes.length}
        upperGateShown={isFanout && (!wallet || !vaultUnlocked)}
      />

      {isFanout && fanout.progress && (
        <FanoutProgressDisplay progress={fanout.progress} slowHint={fanout.showSlowHint} />
      )}

      {/* Single-mix confirmation modal (shard mode only. wallet mode
       *  uses the wallet.signTx prompt as its confirmation). */}
      <Modal
        open={!isFanout && single.confirmOpen}
        onClose={single.cancelConfirm}
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
          <button type="button" className="lj-btn lj-btn--quiet" onClick={single.cancelConfirm}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            onClick={() => void single.confirmSubmit()}
          >
            {t("pool.confirm_submit")}
          </button>
        </footer>
      </Modal>

      {/* Fan-out confirmation modal. every depth ≥ 2 path goes through
       *  this gate so the user can re-read the disclosure-style numbers
       *  before submitting the multi-tx run. */}
      <Modal
        open={isFanout && fanout.confirmOpen}
        onClose={fanout.cancelConfirm}
        title={t("fanout.confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("fanout.confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("fanout.confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {effectiveFeePayer === "wallet"
              ? t("fanout.confirm_lede_wallet", {
                  count: fanout.stats.totalMixes,
                  boxes: fanout.stats.boxesTouched,
                  ada: formatAda(fanout.stats.totalFeeLovelace),
                })
              : t("fanout.confirm_lede", {
                  count: fanout.stats.totalMixes,
                  boxes: fanout.stats.boxesTouched,
                  ada: formatAda(fanout.stats.totalFeeLovelace),
                })}
          </p>
        </header>
        <dl className="lj-banner lj-banner--signal flex-col items-stretch gap-3">
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("fanout.review_total_mixes")}</dt>
            <dd className="font-mono text-sm text-paper" data-num>
              {fanout.stats.totalMixes}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("fanout.review_linkage")}</dt>
            <dd className="text-sm text-paper">
              {t("fanout.review_linkage_value", { d: intensity })}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("fanout.review_total_fee")}</dt>
            <dd className="text-sm text-paper">
              {t("fanout.review_total_fee_value", {
                ada: formatAda(fanout.stats.totalFeeLovelace),
              })}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_fee_path")}</dt>
            <dd className="text-sm text-paper">
              {effectiveFeePayer === "shard"
                ? t("pool.review_fee_path_shard")
                : t("pool.review_fee_path_wallet")}
            </dd>
          </div>
        </dl>
        <footer className="mt-6 flex justify-end gap-2">
          <button type="button" className="lj-btn lj-btn--quiet" onClick={fanout.cancelConfirm}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            onClick={() => void fanout.confirmSubmit()}
          >
            {t("fanout.confirm_submit")}
          </button>
        </footer>
      </Modal>

      {/* Wallet picker, mounted here so the depth-gate inline button can
       *  open it without bouncing the user up to the header. */}
      <WalletModal
        open={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
        onConnected={(args) => {
          setWallet(args);
          setWalletModalOpen(false);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Review blocks
// ---------------------------------------------------------------------------

function SingleReviewBlock({
  n,
  feePayer,
  poolSize,
  poolLoading,
}: {
  n: number;
  feePayer: MixFeePayer;
  poolSize: number;
  poolLoading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="lj-review mt-8" role="group" aria-label={t("pool.review_title")}>
      <span className="lj-eyebrow">{t("pool.review_title")}</span>
      <dl className="lj-review__rows">
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("pool.review_width")}</dt>
          <dd className="lj-review__value lj-review__value--num" data-num>
            {n}
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("pool.review_linkage")}</dt>
          <dd className="lj-review__value">{t("pool.review_linkage_value", { n })}</dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("pool.review_selection")}</dt>
          <dd className="lj-review__value">
            {poolLoading
              ? t("pool.review_selection_loading")
              : t("pool.review_selection_value", { n, pool: poolSize })}
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("pool.review_fee_path")}</dt>
          <dd className="lj-review__value">
            {feePayer === "shard"
              ? t("pool.review_fee_path_shard")
              : t("pool.review_fee_path_wallet")}
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("pool.review_collateral")}</dt>
          <dd className="lj-review__value lj-review__value--muted">
            {feePayer === "shard"
              ? t("pool.review_collateral_value_shard")
              : t("pool.review_collateral_value_wallet")}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function FanoutReviewBlock({
  totalMixes,
  boxesTouched,
  depth,
  totalFeeLovelace,
  freshAvailable,
  freshNeeded,
}: {
  totalMixes: number;
  boxesTouched: number;
  depth: number;
  totalFeeLovelace: bigint;
  freshAvailable: number;
  freshNeeded: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="lj-review mt-8" role="group" aria-label={t("fanout.review_title")}>
      <span className="lj-eyebrow">{t("fanout.review_title")}</span>
      <dl className="lj-review__rows">
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("fanout.review_total_mixes")}</dt>
          <dd className="lj-review__value lj-review__value--num" data-num>
            {totalMixes}
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("fanout.review_boxes_touched")}</dt>
          <dd className="lj-review__value lj-review__value--num" data-num>
            {boxesTouched}
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("fanout.review_linkage")}</dt>
          <dd className="lj-review__value">{t("fanout.review_linkage_value", { d: depth })}</dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("fanout.review_total_fee")}</dt>
          <dd className="lj-review__value">
            {t("fanout.review_total_fee_value", { ada: formatAda(totalFeeLovelace) })}
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("fanout.review_pool")}</dt>
          <dd className="lj-review__value lj-review__value--muted">
            {t("fanout.review_pool_value", { have: freshAvailable, need: freshNeeded })}
          </dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action area. the single CTA + gate hints + (k ≥ 2) cancel button
// ---------------------------------------------------------------------------

function ActionArea({
  isFanout,
  intensity,
  single,
  fanout,
  n,
  poolSize,
  ownedBoxCount,
  upperGateShown,
}: {
  isFanout: boolean;
  intensity: number;
  single: ReturnType<typeof useSingleMix>;
  fanout: ReturnType<typeof useFanoutSubmit>;
  n: number;
  poolSize: number;
  ownedBoxCount: number;
  /**
   * True when the intensity row is already rendering a wallet/vault gate
   * hint (no wallet, or vault locked). The "no owned boxes" gate below
   * the CTA repeats the same actionable advice in those states; suppress
   * it so the user only sees one message.
   */
  upperGateShown: boolean;
}) {
  const { t } = useTranslation();

  // k ≥ 2. fan-out branch.
  if (isFanout) {
    return (
      <>
        {!upperGateShown && !fanout.hasOwned && (
          <p className="mt-6 text-xs text-amber">
            {ownedBoxCount > 0 ? t("fanout.gate_owned_in_flight") : t("fanout.gate_no_owned_boxes")}
          </p>
        )}
        {fanout.hasOwned && !fanout.poolBigEnough && (
          <p className="mt-6 text-xs text-amber">
            {t("fanout.gate_pool_too_small", {
              have: fanout.eligiblePool.length,
              need: fanout.stats.freshNeeded,
            })}
          </p>
        )}
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="lj-btn lj-btn--primary lj-btn--lg"
            onClick={fanout.requestSubmit}
            disabled={fanout.disabled}
          >
            {fanout.running && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
            {fanout.running
              ? t("fanout.running", { d: intensity })
              : t("fanout.run_button", { d: intensity })}
          </button>
          {fanout.running && (
            <button type="button" className="lj-btn lj-btn--quiet" onClick={fanout.cancelRun}>
              {t("fanout.cancel_button")}
            </button>
          )}
        </div>
      </>
    );
  }

  // k = 1. single Mix branch.
  return (
    <div className="mt-8 flex flex-col gap-2">
      <button
        type="button"
        onClick={single.requestSubmit}
        disabled={single.disabled}
        className="lj-btn lj-btn--primary lj-btn--lg"
      >
        {single.submitting && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
        {single.submitting
          ? t("pool.mix_submitting")
          : single.cooldown > 0
            ? t("pool.mix_cooldown", { s: single.cooldown })
            : t("pool.mix_n_random_boxes", { n })}
      </button>
      {!single.collateralOk && (
        <p className="text-xs text-amber">{t("pool.mix_disabled_collateral")}</p>
      )}
      {single.collateralOk && !single.enoughBoxes && (
        <p className="text-xs text-whisper">
          {t("pool.mix_disabled_pool", { have: poolSize, need: n })}
        </p>
      )}
      {single.collateralOk && single.enoughBoxes && single.walletModeNeedsWallet && (
        <p className="text-xs text-whisper">{t("pool.mix_disabled_wallet_needed")}</p>
      )}
      {single.walletModeBalanceShort && single.walletLovelace !== null && (
        <p className="text-xs text-amber">
          {t("wallet.insufficient_balance", {
            have: formatAda(single.walletLovelace),
            need: formatAda(single.mixWalletRequiredLovelace),
          })}
        </p>
      )}
      {single.retryAttempt !== null && (
        <p className="text-xs text-amber">
          {t("tx.retrying_collision", { attempt: single.retryAttempt })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress display (k ≥ 2)
// ---------------------------------------------------------------------------

function FanoutProgressDisplay({
  progress,
  slowHint,
}: {
  progress: NonNullable<ReturnType<typeof useFanoutSubmit>["progress"]>;
  slowHint: boolean;
}) {
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
      {slowHint && (
        <p className="text-xs text-amber" role="status" aria-live="polite">
          {t("fanout.progress_slow_hint")}
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
