// SeedelfPanel — stealth-wallet section mounted inside the unlocked Vault.
//
// Spec: issue #135 (read-only) + issue #155 (mint / send / spend flows).
// Owns the wallet-derived register scan and the three transactional
// surfaces: mint a fresh register, send into someone else's register,
// spend out of one of the user's own registers.
//
// Layout:
//   * Header: title + rescan.
//   * Stats: register count, fund count, total balance.
//   * Mint section: button + inline form (personal-tag input).
//   * Send section: form for recipient seedelf-id + ADA.
//   * Spend section: per-register row with "Rotate" and "Spend out" actions.
//
// The panel renders nothing when the active network has no Seedelf
// deployment (the hook returns `enabled: false`).

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deriveSeedelfSecret,
  mintSeedelfTx,
  resolveRecipientRegister,
  sendToSeedelfTx,
  spendFromSeedelfTx,
  type OwnedSeedelfUtxo,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { loadSeedelfAddresses } from "../lib/sdk.js";
import { useSeedelfState, SEEDELF_MAX_INDEX_SCAN } from "../lib/use-seedelf.js";
import { useToast } from "./Toaster.js";
import { friendlyErrorMessage } from "../lib/errors.js";
import { Eyebrow } from "./ui/Eyebrow.js";

function formatAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function truncate(hex: string, head = 8, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function parseAdaInput(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Round to lovelace; users enter ADA-with-decimals.
  return BigInt(Math.round(n * 1_000_000));
}

export function SeedelfPanel() {
  const { t } = useTranslation();
  const { config, provider, wallet, vault } = useAppState();
  const seedelfAddresses = loadSeedelfAddresses(config.network);
  const state = useSeedelfState(seedelfAddresses);
  const toast = useToast();

  // Three independent disclosures — only one busy at a time, but a user
  // could have all three open with drafts in place.
  const [mintOpen, setMintOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [spendOpen, setSpendOpen] = useState<string | null>(null); // ref key
  const [busy, setBusy] = useState(false);

  // Mint form.
  const [mintTag, setMintTag] = useState("");

  // Send form.
  const [sendRecipientId, setSendRecipientId] = useState("");
  const [sendAmountAda, setSendAmountAda] = useState("");

  // Spend form (driven by spendOpen ref key).
  const [spendDestination, setSpendDestination] = useState("");
  const [spendMode, setSpendMode] = useState<"external" | "internal">("external");

  // Pick the next-available derivation index for mint: smallest i in
  // [0, SEEDELF_MAX_INDEX_SCAN) that doesn't already back a register.
  const nextMintIndex = useMemo(() => {
    const used = new Set(state.registers.map((r) => r.index));
    for (let i = 0; i < SEEDELF_MAX_INDEX_SCAN; i++) {
      if (!used.has(i)) return i;
    }
    return -1;
  }, [state.registers]);

  if (!state.enabled) {
    return null;
  }

  const canTransact = !!provider && !!wallet && !!vault && !!seedelfAddresses;

  async function handleMint() {
    if (!canTransact || nextMintIndex < 0 || busy) return;
    setBusy(true);
    try {
      const secret = deriveSeedelfSecret(vault!.seed, nextMintIndex);
      const tag = mintTag.trim();
      const result = await mintSeedelfTx({
        network: config.network as "preprod" | "preview" | "test" | "mainnet",
        addresses: seedelfAddresses!,
        provider: provider!,
        wallet: wallet!,
        ownerSecret: secret,
        ...(tag ? { personalTag: tag } : {}),
      });
      toast.push({
        tone: "success",
        title: t("vault.seedelf.mint_submitted"),
        txHash: result.txId,
        network: config.network,
      });
      setMintTag("");
      setMintOpen(false);
      state.rescan();
    } catch (e) {
      toast.push({
        tone: "error",
        title: friendlyErrorMessage(e instanceof Error ? e.message : String(e), t),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!canTransact || busy) return;
    const lovelace = parseAdaInput(sendAmountAda);
    if (!lovelace) {
      toast.push({ tone: "error", title: t("vault.seedelf.error_invalid_amount") });
      return;
    }
    const idHex = sendRecipientId.trim().toLowerCase();
    if (!idHex) {
      toast.push({ tone: "error", title: t("vault.seedelf.error_missing_recipient") });
      return;
    }
    setBusy(true);
    try {
      const resolved = await resolveRecipientRegister({
        provider: provider!,
        addresses: seedelfAddresses!,
        seedelfIdHex: idHex,
      });
      if (!resolved) {
        toast.push({ tone: "error", title: t("vault.seedelf.error_unknown_recipient") });
        return;
      }
      const result = await sendToSeedelfTx({
        network: config.network as "preprod" | "preview" | "test" | "mainnet",
        addresses: seedelfAddresses!,
        provider: provider!,
        wallet: wallet!,
        recipientRegister: resolved.register,
        lovelace,
      });
      toast.push({
        tone: "success",
        title: t("vault.seedelf.send_submitted"),
        txHash: result.txId,
        network: config.network,
      });
      setSendRecipientId("");
      setSendAmountAda("");
      setSendOpen(false);
      state.rescan();
    } catch (e) {
      toast.push({
        tone: "error",
        title: friendlyErrorMessage(e instanceof Error ? e.message : String(e), t),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSpend(register: OwnedSeedelfUtxo) {
    if (!canTransact || busy) return;
    setBusy(true);
    try {
      const inputs = [
        {
          ref: register.utxo.ref,
          register: register.register,
          secret: register.secret,
          lovelace: register.utxo.lovelace,
        },
      ];
      const destination =
        spendMode === "internal"
          ? {
              kind: "internal" as const,
              change: { changeRegister: register.register },
            }
          : {
              kind: "external" as const,
              addressBech32: spendDestination.trim(),
            };
      if (spendMode === "external" && !spendDestination.trim()) {
        toast.push({ tone: "error", title: t("vault.seedelf.error_missing_destination") });
        return;
      }
      const result = await spendFromSeedelfTx({
        network: config.network as "preprod" | "preview" | "test" | "mainnet",
        addresses: seedelfAddresses!,
        provider: provider!,
        wallet: wallet!,
        inputs,
        destination,
      });
      toast.push({
        tone: "success",
        title: t("vault.seedelf.spend_submitted"),
        txHash: result.txId,
        network: config.network,
      });
      setSpendOpen(null);
      setSpendDestination("");
      setSpendMode("external");
      state.rescan();
    } catch (e) {
      toast.push({
        tone: "error",
        title: friendlyErrorMessage(e instanceof Error ? e.message : String(e), t),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="lj-card mt-8"
      aria-label={t("vault.seedelf.title")}
      data-testid="seedelf-panel"
    >
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("vault.seedelf.eyebrow")}</Eyebrow>
          <h3 className="lj-card__title">{t("vault.seedelf.title")}</h3>
        </div>
        <button
          type="button"
          className="lj-btn lj-btn--quiet"
          onClick={state.rescan}
          disabled={state.loading || busy}
        >
          {state.loading && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
          {state.loading ? t("vault.seedelf.scanning") : t("vault.seedelf.rescan")}
        </button>
      </header>

      <p className="text-sm text-muted leading-relaxed max-w-prose">{t("vault.seedelf.lede")}</p>

      {state.error && (
        <div className="lj-banner lj-banner--coral mt-4">
          <span className="lj-banner__title">
            {t("vault.seedelf.scan_failed", { message: state.error })}
          </span>
        </div>
      )}

      {(state.registers.length > 0 || state.funds.length > 0) && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="lj-stat">
            <p className="lj-stat__label">{t("vault.seedelf.registers_label")}</p>
            <p className="lj-stat__value">{state.registers.length}</p>
          </div>
          <div className="lj-stat">
            <p className="lj-stat__label">{t("vault.seedelf.funds_label")}</p>
            <p className="lj-stat__value">{state.funds.length}</p>
          </div>
          <div className="lj-stat">
            <p className="lj-stat__label">{t("vault.seedelf.balance_label")}</p>
            <p className="lj-stat__value">
              {t("vault.seedelf.balance_ada", { amount: formatAda(state.totalLovelace) })}
            </p>
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className="lj-btn lj-btn--primary"
          onClick={() => {
            setMintOpen((v) => !v);
            setSendOpen(false);
            setSpendOpen(null);
          }}
          disabled={!canTransact || nextMintIndex < 0 || busy}
        >
          {t("vault.seedelf.mint_button")}
        </button>
        <button
          type="button"
          className="lj-btn"
          onClick={() => {
            setSendOpen((v) => !v);
            setMintOpen(false);
            setSpendOpen(null);
          }}
          disabled={!canTransact || busy}
        >
          {t("vault.seedelf.send_button")}
        </button>
      </div>

      {mintOpen && (
        <div className="lj-form mt-4" data-testid="seedelf-mint-form">
          <label className="lj-label">
            {t("vault.seedelf.mint_tag_label")}
            <input
              type="text"
              className="lj-input"
              value={mintTag}
              onChange={(e) => setMintTag(e.target.value)}
              maxLength={15}
              placeholder={t("vault.seedelf.mint_tag_placeholder")}
              disabled={busy}
            />
          </label>
          <p className="text-xs text-muted mt-1">
            {t("vault.seedelf.mint_index_hint", { i: nextMintIndex })}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="lj-btn lj-btn--primary"
              onClick={handleMint}
              disabled={busy}
              data-testid="seedelf-mint-submit"
            >
              {busy && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
              {t("vault.seedelf.mint_submit")}
            </button>
            <button
              type="button"
              className="lj-btn lj-btn--quiet"
              onClick={() => setMintOpen(false)}
              disabled={busy}
            >
              {t("vault.seedelf.cancel")}
            </button>
          </div>
        </div>
      )}

      {sendOpen && (
        <div className="lj-form mt-4" data-testid="seedelf-send-form">
          <label className="lj-label">
            {t("vault.seedelf.send_recipient_label")}
            <input
              type="text"
              className="lj-input font-mono text-xs"
              value={sendRecipientId}
              onChange={(e) => setSendRecipientId(e.target.value)}
              placeholder={t("vault.seedelf.send_recipient_placeholder")}
              disabled={busy}
            />
          </label>
          <label className="lj-label mt-3">
            {t("vault.seedelf.send_amount_label")}
            <input
              type="number"
              step="any"
              min="0"
              className="lj-input"
              value={sendAmountAda}
              onChange={(e) => setSendAmountAda(e.target.value)}
              placeholder="5"
              disabled={busy}
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="lj-btn lj-btn--primary"
              onClick={handleSend}
              disabled={busy}
              data-testid="seedelf-send-submit"
            >
              {busy && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
              {t("vault.seedelf.send_submit")}
            </button>
            <button
              type="button"
              className="lj-btn lj-btn--quiet"
              onClick={() => setSendOpen(false)}
              disabled={busy}
            >
              {t("vault.seedelf.cancel")}
            </button>
          </div>
        </div>
      )}

      {state.registers.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-semibold mb-2">{t("vault.seedelf.registers_heading")}</h4>
          <ul className="lj-list">
            {state.registers.map((r) => {
              const refKey = `${r.utxo.ref.txId}#${r.utxo.ref.outputIndex}`;
              const isOpen = spendOpen === refKey;
              return (
                <li key={refKey} className="lj-list__item flex-col items-stretch gap-2">
                  <div className="flex items-center justify-between gap-3 w-full">
                    <code className="text-xs">
                      {r.seedelfTokenHex
                        ? `5eed0e1f…${truncate(r.seedelfTokenHex.slice(8), 6, 4)}`
                        : truncate(refKey)}
                    </code>
                    <span className="text-muted text-xs">
                      {t("vault.seedelf.index_label", { i: r.index })}
                    </span>
                    <span className="text-xs">
                      {t("vault.seedelf.balance_ada", { amount: formatAda(r.utxo.lovelace) })}
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="lj-btn lj-btn--sm"
                        onClick={() => copySeedelfId(r, toast, t)}
                        disabled={busy}
                      >
                        {t("vault.seedelf.copy_id")}
                      </button>
                      <button
                        type="button"
                        className="lj-btn lj-btn--sm"
                        onClick={() => {
                          setSpendOpen(isOpen ? null : refKey);
                          setMintOpen(false);
                          setSendOpen(false);
                          setSpendDestination("");
                          setSpendMode("external");
                        }}
                        disabled={busy || r.utxo.lovelace < 2_000_000n}
                      >
                        {t("vault.seedelf.spend_button")}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="lj-form" data-testid={`seedelf-spend-form-${refKey}`}>
                      <fieldset className="lj-fieldset">
                        <label className="lj-radio">
                          <input
                            type="radio"
                            name={`spend-mode-${refKey}`}
                            checked={spendMode === "external"}
                            onChange={() => setSpendMode("external")}
                            disabled={busy}
                          />
                          {t("vault.seedelf.spend_mode_external")}
                        </label>
                        <label className="lj-radio">
                          <input
                            type="radio"
                            name={`spend-mode-${refKey}`}
                            checked={spendMode === "internal"}
                            onChange={() => setSpendMode("internal")}
                            disabled={busy}
                          />
                          {t("vault.seedelf.spend_mode_internal")}
                        </label>
                      </fieldset>
                      {spendMode === "external" && (
                        <label className="lj-label mt-2">
                          {t("vault.seedelf.spend_destination_label")}
                          <input
                            type="text"
                            className="lj-input font-mono text-xs"
                            value={spendDestination}
                            onChange={(e) => setSpendDestination(e.target.value)}
                            placeholder={t("vault.seedelf.spend_destination_placeholder")}
                            disabled={busy}
                          />
                        </label>
                      )}
                      <p className="text-xs text-muted mt-2">
                        {spendMode === "external"
                          ? t("vault.seedelf.spend_external_hint", {
                              amount: formatAda(r.utxo.lovelace),
                            })
                          : t("vault.seedelf.spend_internal_hint", {
                              amount: formatAda(r.utxo.lovelace),
                            })}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          className="lj-btn lj-btn--primary"
                          onClick={() => handleSpend(r)}
                          disabled={busy}
                          data-testid={`seedelf-spend-submit-${refKey}`}
                        >
                          {busy && (
                            <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
                          )}
                          {t("vault.seedelf.spend_submit")}
                        </button>
                        <button
                          type="button"
                          className="lj-btn lj-btn--quiet"
                          onClick={() => setSpendOpen(null)}
                          disabled={busy}
                        >
                          {t("vault.seedelf.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!state.error && state.registers.length === 0 && state.funds.length === 0 && (
        <div className="lj-empty mt-6">
          <p className="lj-empty__title">{t("vault.seedelf.empty_title")}</p>
          <p>{t("vault.seedelf.empty_hint_mint")}</p>
        </div>
      )}
    </section>
  );
}

type ToastApi = ReturnType<typeof useToast>;
type TFn = ReturnType<typeof useTranslation>["t"];

function copySeedelfId(r: OwnedSeedelfUtxo, toast: ToastApi, t: TFn): void {
  const id = r.seedelfTokenHex;
  if (!id) {
    toast.push({ tone: "error", title: t("vault.seedelf.error_no_id_to_copy") });
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(id).then(
      () => toast.push({ tone: "success", title: t("vault.seedelf.id_copied") }),
      () => toast.push({ tone: "error", title: t("vault.seedelf.error_copy_failed") }),
    );
  }
}
