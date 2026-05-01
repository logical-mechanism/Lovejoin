// Vault — wallet-derived owned-boxes view + lock + tier-2 BIP-39 fallback +
// inline (single + bulk) withdraw form.
//
// Spec: docs/spec/06-ui.md M6.5 — "wallet-derived vault (default flow) —
// zero new keys for the user to manage. On first 'unlock' the connected
// CIP-30 wallet does a single signData(stakeAddr, 'lovejoin/owner/v1');
// ... seed = blake2b_256(signature_bytes); per-deposit owner secret x_i =
// scalar_from_hkdf(seed, 'lovejoin/owner/v1', counter=i) reduced mod r.
// The seed is held in memory for the session only — IndexedDB stores
// nothing. Locking the vault drops the seed; unlocking re-prompts the
// wallet for one signature."
//
// The Withdraw screen used to live at `/withdraw` as a parallel flow with
// the same owned-box list, and the Vault row had a per-box "Withdraw"
// link to a single-box drill-in. Two screens with the same list confused
// users. We folded both single + bulk withdraw into Vault: a checkbox per
// row plus one destination input drives `buildBulkWithdrawTx` for any
// number of selected boxes (1..N). The Box detail route still exists for
// direct linking but isn't reachable from the table any more.
//
// External collateral via giveme.my so a fresh wallet can withdraw
// without holding a 5-ADA collateral UTxO of its own.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GivemeMyProvider,
  buildBulkWithdrawTx,
  buildMixTx,
  isInputCollisionError,
  pickRandomNTuple,
  type BulkWithdrawEntry,
  type MixInput,
  type Utxo,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { useCollateralStatus } from "../components/CollateralProviderStatus.js";
import { useBackendStatus } from "../components/BackendStatus.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { Modal } from "../components/ui/Modal.js";
import { RecoverPasswordPanel } from "../components/RecoverPasswordPanel.js";
import { TxBuildProgress } from "../components/TxBuildProgress.js";
import { useToast } from "../components/Toaster.js";
import { WithdrawReview } from "../components/WithdrawReview.js";
import { BackendClient } from "../lib/backend.js";
import { friendlyErrorMessage } from "../lib/errors.js";
import { formatAda } from "../lib/format.js";
import { fetchPoolDirect, type DirectPoolEntry } from "../lib/pool.js";
import { validateDestination } from "../lib/seedelf.js";
import { mixPhases, withdrawPhases } from "../lib/tx-phases.js";
import { useVisibleRefresh } from "../lib/use-visible-refresh.js";
import type { OwnedBox } from "../lib/vault.js";

export function Vault() {
  const { t } = useTranslation();
  const { wallet, vault, vaultBusy, vaultError, unlockWithWallet } =
    useAppState();
  const [showFallback, setShowFallback] = useState(false);

  if (!vault) {
    if (showFallback) {
      return (
        <RecoverPasswordPanel onClose={() => setShowFallback(false)} />
      );
    }
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("vault.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("vault.locked_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("vault.locked_lede")}
        </p>
        <div className="mt-6">
          <button
            type="button"
            className="lj-btn lj-btn--primary lj-btn--lg"
            disabled={!wallet || vaultBusy}
            onClick={() => void unlockWithWallet()}
          >
            {vaultBusy && (
              <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
            )}
            {vaultBusy ? t("vault.unlocking") : t("vault.unlock_with_wallet")}
          </button>
        </div>
        {!wallet && (
          <p className="mt-4 text-sm text-whisper">{t("vault.no_wallet")}</p>
        )}
        <div className="mt-6 border-t border-rule pt-4">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setShowFallback(true)}
            disabled={!wallet}
            title={!wallet ? t("vault.no_wallet") : undefined}
          >
            {t("vault.recover_link")}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        {vaultError && (
          <div className="lj-banner lj-banner--coral mt-6">
            <span className="lj-banner__title">
              {t("vault.unlock_failed", { message: vaultError })}
            </span>
          </div>
        )}
      </section>
    );
  }

  return <UnlockedVault />;
}

function UnlockedVault() {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    ownedBoxes,
    poolSize,
    scanError,
    lockVault,
    rescan,
    pendingTxRefs,
    markTxPending,
    walletLovelace,
    refreshWalletBalance,
  } = useAppState();
  const collateral = useCollateralStatus();
  const backend = useBackendStatus();
  // Per-row "Mix this box" — the active ref while a build is in flight,
  // so the row can show a spinner without lighting up every other Mix
  // button at the same time. `mixError` surfaces inline next to the
  // button on failure (the success path is already handled by the
  // toast + pending-row dim). N is taken from the runtime
  // max_n_shard cap so the user gets the strongest privacy gain the
  // deployed validator allows.
  const [rowMixingRef, setRowMixingRef] = useState<string | null>(null);
  const [confirmMixRef, setConfirmMixRef] = useState<string | null>(null);
  const maxNShard =
    addresses?.protocol.max_n_shard ?? addresses?.protocol.max_n ?? 2;

  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() => new Set());
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Pagination keeps the destination input + Withdraw button in view when
  // the vault holds more than one page of boxes. Selection state is keyed
  // by ref, so it survives page changes without extra plumbing.
  const PAGE_SIZE = 10;
  const [boxPage, setBoxPage] = useState(0);
  // Track rescan-in-flight locally so the "Scan again" button can
  // disable + show a spinner. The initial unlock-time scan is already
  // awaited inside `unlockWithWallet`, so by the time we render here
  // the box list is hydrated — no need to seed this `true`. The
  // useVisibleRefresh hook below silently fires `runRescan()` on tab
  // focus (after staleness) and on a 60 s timer while visible, so the
  // box list stays current without the user having to click anything;
  // when it does fire silently we still show the spinner so the user
  // sees that something refreshed.
  const [rescanning, setRescanning] = useState(false);
  const runRescan = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      await rescan();
    } finally {
      setRescanning(false);
    }
  };
  // 60 s background refresh while visible. The deposit / withdraw /
  // mix flows all schedule their own 12 s rescan after submit, so this
  // is purely a "tab away for a while, come back to fresh data" tell —
  // not the primary mechanism for updating after a tx the user just
  // submitted themselves. `enabled` flips off the moment the vault
  // locks; useAppState's vault is null until unlock, and re-enables
  // once the user unlocks again.
  useVisibleRefresh(() => runRescan(), {
    intervalMs: 60_000,
    enabled: !!vault,
  });

  // Default-select the first owned box on initial load so single-box
  // users don't have to think about the new multi-select UI. Once the
  // user touches the checkboxes the auto-default doesn't reapply.
  // Skip pending boxes so we don't auto-select something already in
  // flight (the user can still see the row, dimmed, with the spinner).
  const [autoSelected, setAutoSelected] = useState(false);
  useEffect(() => {
    if (autoSelected) return;
    if (selectedRefs.size > 0) {
      setAutoSelected(true);
      return;
    }
    const first = ownedBoxes.find(
      (b) =>
        !pendingTxRefs.has(
          `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`,
        ),
    );
    if (!first) return;
    setSelectedRefs(
      new Set([`${first.entry.ref.txId.toLowerCase()}#${first.entry.ref.outputIndex}`]),
    );
    setAutoSelected(true);
  }, [ownedBoxes, selectedRefs, autoSelected, pendingTxRefs]);

  const toggleRef = (ref: string) => {
    if (pendingTxRefs.has(ref)) return; // can't toggle a pending row
    setSelectedRefs((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };
  const clearAll = () => setSelectedRefs(new Set());
  const selectAll = () =>
    setSelectedRefs(
      new Set(
        ownedBoxes
          .map((b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`)
          .filter((ref) => !pendingTxRefs.has(ref)),
      ),
    );

  // "Mix this box" — shard-mode Mix tx that force-includes the selected
  // owned box. The protocol's pure-random shared path can take many
  // rounds to actually move a specific box; this surfaces "advance THIS
  // box" as an explicit user action. We pick the remaining N-1 inputs
  // uniformly at random from the live pool (excluding in-flight refs and
  // the box itself). Wallet anonymity is preserved — feePayer="shard"
  // means no wallet input or signature, just like the Pool screen's
  // shared-mix path.
  const collateralOk = collateral?.status === "online";
  const mixThisBox = async (box: OwnedBox) => {
    if (!provider || !addresses) return;
    const refKey = `${box.entry.ref.txId.toLowerCase()}#${box.entry.ref.outputIndex}`;
    if (rowMixingRef) return;
    if (pendingTxRefs.has(refKey)) return;
    if (!collateralOk) {
      toast.push({
        tone: "error",
        title: t("vault.mix_disabled_collateral"),
      });
      return;
    }
    setRowMixingRef(refKey);
    try {
      // Fetch the live pool. Same backend-first / Blockfrost-fallback
      // pattern the Pool screen uses; we want the freshest data here
      // since we're about to spend specific UTxOs.
      const useBackend =
        !!config.backendUrl &&
        (backend?.status === "synced" || backend?.status === "syncing");
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

      // Mempool-aware in-flight set so we don't accidentally pick a box
      // that's already an input to another pending tx — same union the
      // Pool screen's MixButton uses.
      const inFlightRefs = new Set<string>(pendingTxRefs);
      if (useBackend) {
        try {
          const client = new BackendClient(config.backendUrl);
          const snap = await client.mempoolInputs();
          if (snap) {
            for (const r of snap.inputs) {
              inFlightRefs.add(
                `${r.txHash.toLowerCase()}#${r.outputIndex}`,
              );
            }
          }
        } catch {
          /* mempool fetch failed; rely on retry path */
        }
      }

      // Eligible "fillers" = pool minus the chosen box minus in-flight.
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
        ownedBoxes.map(
          (b) =>
            `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`,
        ),
      );
      const ownedFillerRefs = fillers
        .map(
          (e) => `${e.ref.txId.toLowerCase()}#${e.ref.outputIndex}`,
        )
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
        detail: busy
          ? t("tx.busy_detail")
          : friendlyErrorMessage((err as Error).message, t),
      });
    } finally {
      setRowMixingRef(null);
      void refreshWalletBalance();
    }
  };

  const selectedBoxes: OwnedBox[] = useMemo(
    () =>
      ownedBoxes.filter((b) =>
        selectedRefs.has(
          `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`,
        ),
      ),
    [ownedBoxes, selectedRefs],
  );

  const totalLovelace = useMemo(
    () => selectedBoxes.reduce((acc, b) => acc + b.entry.utxo.lovelace, 0n),
    [selectedBoxes],
  );

  // Clamp the page index when the vault shrinks (withdraw confirmed,
  // rescan removed a box) so we don't render a blank page past the end.
  const totalPages = Math.max(1, Math.ceil(ownedBoxes.length / PAGE_SIZE));
  const safeBoxPage = Math.min(boxPage, totalPages - 1);
  const visibleBoxes = ownedBoxes.slice(
    safeBoxPage * PAGE_SIZE,
    (safeBoxPage + 1) * PAGE_SIZE,
  );

  const validation = useMemo(
    () => validateDestination(destination, config.network),
    [destination, config.network],
  );

  const preconditionsOk = !!provider && !!addresses && !!wallet && !!vault;
  const canSubmit =
    preconditionsOk &&
    selectedBoxes.length > 0 &&
    validation.status === "ok" &&
    !submitting;

  // Soft balance hint. Withdraw fees are paid by the connected wallet
  // (collateral comes from giveme.my); 3 ADA covers tx fee + min-utxo
  // overhead with headroom across N up to bulk_withdraw's cap. We
  // don't gate the submit button on this — the wallet may have a
  // pending UTxO the SDK will end up using even though our cached
  // balance can't see it. Surface as advisory copy under the button.
  const withdrawRequiredLovelace = 3_000_000n;
  const balanceShort =
    !!wallet &&
    walletLovelace !== null &&
    walletLovelace < withdrawRequiredLovelace;

  const onRequestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setConfirmOpen(true);
  };

  const onConfirmSubmit = async () => {
    if (!preconditionsOk || selectedBoxes.length === 0 || submitting) return;
    if (validation.status !== "ok") return;
    setConfirmOpen(false);
    setSubmitting(true);
    setRetryAttempt(null);
    try {
      const entries: BulkWithdrawEntry[] = selectedBoxes.map((b) => ({
        mixBox: { ref: b.entry.ref, a: b.entry.a, b: b.entry.b },
        ownerSecret: b.secret,
      }));
      // Empty config endpoint = let the SDK use its pinned host URL.
      const collateralProvider = new GivemeMyProvider({
        network: config.network,
        ...(config.collateralProviderEndpoint
          ? { endpoint: config.collateralProviderEndpoint }
          : {}),
      });
      const result = await buildBulkWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        entries,
        destinationAddressBech32: destination.trim(),
        wallet: wallet!,
        provider: provider!,
        addresses: addresses!,
        collateralProvider,
        retry: {
          maxAttempts: 3,
          delayBetweenAttemptsMs: 2_000,
          onRetry: (info) => setRetryAttempt(info.attempt),
        },
      });
      toast.push({
        tone: "success",
        title: t("toast.withdraw_success"),
        txHash: result.txId,
        network: config.network,
      });
      // Mark the just-submitted boxes as pending so the rows render
      // dimmed + locked until the rescan confirms the spend (or the
      // 90 s safety timer expires). Closes the perceptual gap between
      // "submitted" toast and the boxes actually leaving the table.
      markTxPending(
        selectedBoxes.map(
          (b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`,
        ),
      );
      // Clear the picker so the row visibly drains as the chain confirms;
      // schedule a rescan so the boxes drop out of `ownedBoxes` once the
      // withdraw tx lands on chain.
      setSelectedRefs(new Set());
      setDestination("");
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      const busy = isInputCollisionError(err);
      toast.push({
        tone: "error",
        title: busy ? t("tx.busy_title") : t("toast.withdraw_failed"),
        detail: busy ? t("tx.busy_detail") : friendlyErrorMessage((err as Error).message, t),
      });
    } finally {
      setSubmitting(false);
      setRetryAttempt(null);
      void refreshWalletBalance();
    }
  };

  return (
    <section
      className={`lj-card lj-overlay ${
        submitting || rowMixingRef !== null ? "lj-overlay--busy" : ""
      }`}
    >
      <header className="lj-card__head">
        <div>
          <Eyebrow>
            {vault!.kind === "wallet"
              ? t("vault.eyebrow")
              : t("vault.eyebrow_recovery")}
          </Eyebrow>
          <h2 className="lj-card__title">{t("vault.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => void runRescan()}
            disabled={submitting || rescanning}
          >
            {rescanning && (
              <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
            )}
            {rescanning ? t("vault.scanning_pool") : t("vault.scan_again")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={lockVault}
            disabled={submitting}
          >
            {t("vault.lock")}
          </button>
        </div>
      </header>

      <p className="text-sm text-muted">
        {t("vault.scan_summary", { count: ownedBoxes.length, pool: poolSize })}
      </p>

      {scanError && (
        <div className="lj-banner lj-banner--coral mt-4">
          <span className="lj-banner__title">
            {t("vault.scan_failed", { message: scanError })}
          </span>
        </div>
      )}

      {ownedBoxes.length === 0 ? (
        <div className="lj-empty mt-8">
          <p className="lj-empty__title">{t("vault.empty")}</p>
          <p>{t("vault.empty_hint")}</p>
        </div>
      ) : (
        <form
          className="mt-6 space-y-6"
          onSubmit={onRequestSubmit}
          aria-busy={submitting}
        >
          <fieldset disabled={submitting} className="contents">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="lj-field__label">
                  {t("withdraw.select_boxes")}
                </span>
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-muted underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={selectedBoxes.length === ownedBoxes.length}
                  >
                    {t("withdraw.select_all")}
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-muted underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={selectedBoxes.length === 0}
                  >
                    {t("withdraw.clear_selection")}
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="lj-table">
                  <caption className="sr-only">
                    {t("withdraw.table_caption")}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="w-8">
                        <span className="sr-only">
                          {t("withdraw.column_select")}
                        </span>
                      </th>
                      <th scope="col">
                        <abbr title={t("withdraw.column_index_long")}>i</abbr>
                      </th>
                      <th scope="col">{t("common.tx_hash")}</th>
                      <th scope="col" className="lj-table__num">
                        <abbr title={t("vault.column_rounds_long")}>
                          {t("vault.column_rounds")}
                        </abbr>
                      </th>
                      <th scope="col" className="lj-table__num">
                        <span className="sr-only">
                          {t("vault.column_action")}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBoxes.map((box) => {
                      const ref = `${box.entry.ref.txId.toLowerCase()}#${box.entry.ref.outputIndex}`;
                      const checked = selectedRefs.has(ref);
                      // Pending = in flight from a Withdraw or owned-input
                      // Mix this session. We dim the row, lock the
                      // checkbox, and surface a small "in flight" eyebrow
                      // so the user can see the box is on its way out.
                      const pending = pendingTxRefs.has(ref);
                      const rowClasses = [
                        pending ? "" : "cursor-pointer",
                        checked && !pending ? "bg-rise" : "",
                        pending ? "opacity-50" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <tr
                          key={ref}
                          className={rowClasses}
                          onClick={pending ? undefined : () => toggleRef(ref)}
                          aria-busy={pending}
                        >
                          <td className="text-center">
                            <input
                              type="checkbox"
                              name="box-select"
                              checked={checked}
                              onChange={() => toggleRef(ref)}
                              onClick={(e) => e.stopPropagation()}
                              disabled={pending}
                              className="accent-paper disabled:cursor-not-allowed"
                              aria-label={t("withdraw.select_boxes")}
                            />
                          </td>
                          <td className="lj-table__num">
                            {pending ? (
                              <span className="inline-flex items-center gap-2">
                                <span
                                  className="lj-spinner lj-spinner--sm"
                                  aria-hidden="true"
                                />
                                <span className="text-whisper text-xs uppercase tracking-wider">
                                  {t("vault.box_pending")}
                                </span>
                              </span>
                            ) : (
                              box.index
                            )}
                          </td>
                          <td>
                            <Hash value={box.entry.ref.txId} edge={6} />
                            <span className="text-whisper text-xs">
                              #{box.entry.ref.outputIndex}
                            </span>
                          </td>
                          <td className="lj-table__num">
                            {typeof box.generation === "number"
                              ? box.generation
                              : "—"}
                          </td>
                          <td className="lj-table__num">
                            <button
                              type="button"
                              className="lj-btn lj-btn--quiet lj-btn--sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmMixRef(ref);
                              }}
                              disabled={
                                pending ||
                                submitting ||
                                rowMixingRef !== null ||
                                !provider ||
                                !addresses ||
                                !collateralOk
                              }
                              title={
                                !collateralOk
                                  ? t("vault.mix_disabled_collateral")
                                  : undefined
                              }
                            >
                              {rowMixingRef === ref && (
                                <span
                                  className="lj-spinner lj-spinner--sm"
                                  aria-hidden="true"
                                />
                              )}
                              {rowMixingRef === ref
                                ? t("vault.mix_row_submitting")
                                : t("vault.mix_row")}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <nav
                  className="mt-3 flex items-center justify-between gap-3"
                  aria-label={t("vault.pagination_aria")}
                >
                  <button
                    type="button"
                    className="lj-btn lj-btn--quiet"
                    onClick={() => setBoxPage((p) => Math.max(0, p - 1))}
                    disabled={safeBoxPage === 0}
                  >
                    ← {t("vault.prev_page")}
                  </button>
                  <span className="text-xs text-muted" aria-live="polite">
                    {t("vault.page_indicator", {
                      current: safeBoxPage + 1,
                      total: totalPages,
                    })}
                  </span>
                  <button
                    type="button"
                    className="lj-btn lj-btn--quiet"
                    onClick={() =>
                      setBoxPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={safeBoxPage >= totalPages - 1}
                  >
                    {t("vault.next_page")} →
                  </button>
                </nav>
              )}
              {selectedBoxes.length > 0 && (
                <p className="text-xs text-muted">
                  {t("withdraw.selection_summary", {
                    count: selectedBoxes.length,
                    total: formatAda(totalLovelace),
                  })}
                </p>
              )}
            </div>

            <div className="mt-4 mb-6 border-t border-b border-rule py-6">
              <p className="lj-eyebrow mb-3">
                {t("withdraw.destination_section")}
              </p>
              <div className="lj-field">
                <label className="lj-field__label" htmlFor="vault-destination">
                  {t("withdraw.destination_label")}
                </label>
                <input
                  id="vault-destination"
                  type="text"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("withdraw.destination_placeholder")}
                  className={`lj-input${
                    validation.status === "invalid" ||
                    validation.status === "wrong-network"
                      ? " lj-input--error"
                      : ""
                  }`}
                  aria-invalid={
                    validation.status === "invalid" ||
                    validation.status === "wrong-network"
                  }
                  aria-describedby="vault-destination-help"
                />
                <div id="vault-destination-help">
                  {validation.status === "invalid" && (
                    <p className="lj-field__error" role="alert">
                      {t("withdraw.dest_invalid")}
                    </p>
                  )}
                  {validation.status === "wrong-network" && (
                    <p className="lj-field__warn" role="alert">
                      {t("withdraw.dest_wrong_network", {
                        addressNet:
                          validation.addressNetwork === "testnet"
                            ? t("withdraw.net_testnet")
                            : t("withdraw.net_mainnet"),
                        expected: config.network,
                      })}
                    </p>
                  )}
                  {validation.status === "ok" &&
                    validation.kind.kind === "regular-key" && (
                      <p className="lj-field__hint">
                        {t("withdraw.dest_regular_key")}
                      </p>
                    )}
                  {validation.status === "ok" &&
                    validation.kind.kind === "stealth" && (
                      <p className="lj-field__hint">
                        {t("withdraw.dest_stealth")}
                      </p>
                    )}
                </div>
              </div>
            </div>

            {selectedBoxes.length > 0 && (
              <WithdrawReview
                lovelace={totalLovelace}
                destination={destination}
                validation={validation}
              />
            )}

            <div className="lj-banner lj-banner--signal">
              <span className="lj-eyebrow">{t("withdraw.tx_preview_title")}</span>
              <span className="lj-banner__detail">
                {t("withdraw.tx_preview_copy")}
              </span>
            </div>

            <div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="lj-btn lj-btn--primary lj-btn--lg"
              >
                {submitting && (
                  <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
                )}
                {submitting ? t("withdraw.submitting") : t("withdraw.submit")}
              </button>
              {!preconditionsOk && (
                <p className="mt-3 text-sm text-muted">
                  {t("withdraw.preconditions_missing")}
                </p>
              )}
              {preconditionsOk &&
                selectedBoxes.length === 0 &&
                ownedBoxes.length > 0 &&
                !submitting && (
                  <p className="mt-3 text-xs text-whisper">
                    {t("withdraw.no_box_selected")}
                  </p>
                )}
              {balanceShort && walletLovelace !== null && !submitting && (
                <p className="mt-3 text-xs text-amber">
                  {t("wallet.insufficient_balance", {
                    have: formatAda(walletLovelace),
                    need: formatAda(withdrawRequiredLovelace),
                  })}
                </p>
              )}
              {retryAttempt !== null && (
                <p className="mt-3 text-xs text-amber">
                  {t("tx.retrying_collision", { attempt: retryAttempt })}
                </p>
              )}
            </div>
          </fieldset>
        </form>
      )}

      <div className="lj-overlay__indicator">
        <TxBuildProgress
          active={submitting}
          phases={withdrawPhases(t)}
          ariaLabel={t("withdraw.submitting")}
        />
        <TxBuildProgress
          active={rowMixingRef !== null}
          phases={mixPhases(t, maxNShard)}
          ariaLabel={t("vault.mix_row_submitting")}
        />
      </div>

      <Modal
        open={confirmMixRef !== null}
        onClose={() => setConfirmMixRef(null)}
        title={t("vault.mix_row_confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("vault.mix_row_confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("vault.mix_row_confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {t("vault.mix_row_confirm_lede", { n: maxNShard })}
          </p>
        </header>
        <footer className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setConfirmMixRef(null)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            onClick={() => {
              const ref = confirmMixRef;
              setConfirmMixRef(null);
              if (!ref) return;
              const target = ownedBoxes.find(
                (b) =>
                  `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}` ===
                  ref,
              );
              if (target) void mixThisBox(target);
            }}
          >
            {t("vault.mix_row_confirm_submit")}
          </button>
        </footer>
      </Modal>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("withdraw.confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("withdraw.confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("withdraw.confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {t("withdraw.confirm_lede")}
          </p>
        </header>
        <dl className="lj-banner lj-banner--signal flex-col items-stretch gap-3">
          <div>
            <dt className="lj-eyebrow">{t("withdraw.confirm_summary_label")}</dt>
            <dd className="lj-banner__detail mt-1">
              {t("withdraw.selection_summary", {
                count: selectedBoxes.length,
                total: formatAda(totalLovelace),
              })}
            </dd>
          </div>
          <div>
            <dt className="lj-eyebrow">{t("withdraw.destination_label")}</dt>
            <dd className="mt-1 break-all font-mono text-xs text-paper">
              {destination.trim()}
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
            {t("withdraw.confirm_submit")}
          </button>
        </footer>
      </Modal>
    </section>
  );
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
