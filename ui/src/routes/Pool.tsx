// Pool screen — the user-as-mixer surface.
//
// Spec: docs/spec/06-ui.md §"Pool" — pool size + fee balance + collateral
// status, MixWidthSlider, "Mix N random boxes" button, recent mix activity
// (anonymized).
//
// The pool of mix-able boxes is read from the M5 backend if configured;
// otherwise we fall back to direct chain queries via the BlockfrostProvider.
// `selectedNetwork` doesn't matter for the slider semantics — max_n is
// network-wide.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MixButton } from "../components/MixButton.js";
import { MixWidthSlider } from "../components/MixWidthSlider.js";
import { PoolStatus } from "../components/PoolStatus.js";
import {
  CollateralProviderBanner,
  useCollateralStatus,
} from "../components/CollateralProviderStatus.js";
import { BackendClient } from "../lib/backend.js";
import { fetchPoolDirect, type DirectPoolEntry } from "../lib/pool.js";
import { useAppState } from "../lib/store.js";

const DEFAULT_MAX_N = 6;

export function Pool() {
  const { t } = useTranslation();
  const { config, provider, addresses, wallet } = useAppState();
  const collateral = useCollateralStatus();
  const [poolEntries, setPoolEntries] = useState<DirectPoolEntry[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [n, setN] = useState<number>(DEFAULT_MAX_N);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const maxN = useMemo<number>(() => {
    // We don't have on-chain max_n in the addresses bundle — it lives in
    // network.<net>.json. The M2 calibration result on Preprod is 6; the
    // slider clamps to that until we surface a richer config asset.
    return DEFAULT_MAX_N;
  }, []);

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

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold">{t("pool.section_title")}</h2>
        <div className="mt-3">
          <MixWidthSlider value={n} maxN={maxN} onChange={setN} />
        </div>
        {!wallet && (
          <p className="mt-3 text-xs text-gray-600">{t("pool.connect_to_mix")}</p>
        )}
        {wallet && provider && addresses && (
          <div className="mt-3">
            <MixButton
              network={config.network}
              provider={provider}
              addresses={addresses}
              wallet={wallet}
              poolEntries={poolEntries}
              n={n}
              onSubmitted={(txId) => {
                setSubmitMessage(t("pool.mix_submitted", { txId }));
                setSubmitError(null);
              }}
              onError={(msg) => {
                setSubmitError(t("pool.mix_failed", { message: msg }));
                setSubmitMessage(null);
              }}
            />
          </div>
        )}
        {submitMessage && (
          <p className="mt-3 break-all rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">
            {submitMessage}
          </p>
        )}
        {submitError && (
          <p
            role="alert"
            className="mt-3 break-all rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800"
          >
            {submitError}
          </p>
        )}
        {poolError && (
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            {t("pool.scan_failed", { message: poolError })}
          </p>
        )}
        <p className="mt-3 text-xs text-gray-500">
          {t("pool.pool_loaded", { count: poolEntries.length })}
        </p>
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
