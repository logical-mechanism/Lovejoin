// Pool — the user-as-mixer surface.
//
// Spec: docs/spec/06-ui.md §"Pool" + M6.5 design pass.
//
// Layout (top → bottom):
//   • Network status strip (pool size, fee balance, indexer lag, collateral).
//   • Mix width slider (clamps to runtime max_n surfaced via addresses.json).
//   • Fee-payer toggle (shard | wallet) with one-line tradeoff per option.
//   • Tx-preview line (Privacy UX rule 7) explicitly stating fee + collateral source.
//   • The primary CTA — "Mix N random boxes".

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MixFeePayer } from "@lovejoin/sdk";

import { MixButton } from "../components/MixButton.js";
import { MixWidthSlider } from "../components/MixWidthSlider.js";
import { PoolStatus } from "../components/PoolStatus.js";
import {
  CollateralProviderBanner,
  useCollateralStatus,
} from "../components/CollateralProviderStatus.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { BackendClient } from "../lib/backend.js";
import { fetchPoolDirect, type DirectPoolEntry } from "../lib/pool.js";
import { useAppState } from "../lib/store.js";

export function Pool() {
  const { t } = useTranslation();
  const { config, provider, addresses, wallet } = useAppState();
  const collateral = useCollateralStatus();
  const [poolEntries, setPoolEntries] = useState<DirectPoolEntry[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);

  // The slider's cap is whatever the deployed addresses bundle declares.
  // Falls back to N=2 if the field is absent (older bootstraps); the
  // slider clamps `value` into [2, max], so a cap of 2 just means "no
  // slider" — the user can still mix at N=2.
  const maxN = addresses?.protocol?.max_n ?? 2;
  const [n, setN] = useState<number>(maxN);
  const [feePayer, setFeePayer] = useState<MixFeePayer>("shard");
  const [submitTxId, setSubmitTxId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // If max_n changes (network swap), re-clamp current width.
  useMemo(() => {
    if (n > maxN) setN(maxN);
  }, [maxN, n]);

  useEffect(() => {
    if (!provider || !addresses) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        if (config.backendUrl) {
          const client = new BackendClient(config.backendUrl);
          const page = await client.pool({ limit: 500 });
          if (!page || cancelled) return;
          setPoolEntries(
            page.boxes.map((b) => ({
              ref: { txId: b.txHash.toLowerCase(), outputIndex: b.outputIndex },
              a: hexToBytes(b.a),
              b: hexToBytes(b.b),
            })),
          );
          setPoolError(null);
          return;
        }
        const direct = await fetchPoolDirect({ provider, addresses });
        if (cancelled) return;
        setPoolEntries(direct);
        setPoolError(null);
      } catch (e) {
        if (!cancelled) setPoolError((e as Error).message);
      }
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [provider, addresses, config.backendUrl]);

  return (
    <>
      <PoolStatus backendUrl={config.backendUrl} />

      {collateral?.status === "down" && (
        <CollateralProviderBanner status={collateral.status} />
      )}

      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("pool.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("pool.section_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("pool.lede")}
        </p>

        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <div>
            <MixWidthSlider value={n} maxN={maxN} onChange={setN} />
          </div>

          <div className="flex flex-col gap-3">
            <Eyebrow>{t("pool.fee_payer_label")}</Eyebrow>
            <div className="lj-toggle" role="group">
              <button
                type="button"
                aria-pressed={feePayer === "shard"}
                onClick={() => setFeePayer("shard")}
              >
                {t("pool.fee_payer_shard")}
              </button>
              <button
                type="button"
                aria-pressed={feePayer === "wallet"}
                onClick={() => setFeePayer("wallet")}
              >
                {t("pool.fee_payer_wallet")}
              </button>
            </div>
            <p className="text-xs text-whisper leading-relaxed">
              {feePayer === "shard"
                ? t("pool.fee_payer_shard_hint")
                : t("pool.fee_payer_wallet_hint")}
            </p>
          </div>
        </div>

        <div className="lj-banner lj-banner--signal mt-8">
          <span className="lj-eyebrow">{t("pool.tx_preview_title")}</span>
          <span className="lj-banner__detail">
            {feePayer === "shard"
              ? t("pool.tx_preview_fee_shard")
              : t("pool.tx_preview_fee_wallet")}
          </span>
        </div>

        <div className="mt-8 flex flex-wrap items-end gap-6">
          {!wallet ? (
            <p className="text-sm text-whisper">{t("pool.connect_to_mix")}</p>
          ) : provider && addresses ? (
            <MixButton
              network={config.network}
              provider={provider}
              addresses={addresses}
              wallet={wallet}
              poolEntries={poolEntries}
              n={n}
              feePayer={feePayer}
              onSubmitted={(txId) => {
                setSubmitTxId(txId);
                setSubmitError(null);
              }}
              onError={(msg) => {
                setSubmitError(t("pool.mix_failed", { message: msg }));
                setSubmitTxId(null);
              }}
            />
          ) : null}
          <span className="text-xs text-whisper">
            {t("pool.pool_loaded", { count: poolEntries.length })}
          </span>
        </div>

        {submitTxId && (
          <div className="lj-banner lj-banner--signal mt-6">
            <span className="lj-banner__title">
              {t("pool.mix_submitted", { txId: "" })}
            </span>
            <span className="lj-banner__detail">
              <Hash value={submitTxId} edge={8} />
            </span>
          </div>
        )}
        {submitError && (
          <div role="alert" className="lj-banner lj-banner--coral mt-6">
            <span className="lj-banner__title">{submitError}</span>
          </div>
        )}
        {poolError && (
          <div className="lj-banner lj-banner--amber mt-6">
            <span className="lj-banner__title">
              {t("pool.scan_failed", { message: poolError })}
            </span>
          </div>
        )}
      </section>
    </>
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
