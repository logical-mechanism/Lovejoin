// M3.5 vertical-slice page.
//
// One scrollable column with: config panel, wallet picker, deposit form,
// my-boxes list, withdraw form. State is intentionally local — the M3.5
// scope rules out persistence, routing, and global stores. M6 will swap in
// a real router + encrypted IndexedDB.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import type { LovejoinAddresses, BlockfrostProvider } from "@lovejoin/sdk";

import { ConfigPanel } from "./components/ConfigPanel.js";
import {
  DepositPanel,
  type DepositedBox,
} from "./components/DepositPanel.js";
import { MixPanel } from "./components/MixPanel.js";
import { MyBoxesPanel } from "./components/MyBoxesPanel.js";
import { WalletPanel } from "./components/WalletPanel.js";
import { WithdrawPanel } from "./components/WithdrawPanel.js";
import {
  loadAddresses,
  loadConfig,
  makeProvider,
  type RuntimeConfig,
} from "./lib/sdk.js";

export function App() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<RuntimeConfig>(loadConfig);
  const [addresses, setAddresses] = useState<LovejoinAddresses | null>(null);
  const [addressesError, setAddressesError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<BrowserWallet | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [changeAddress, setChangeAddress] = useState<string | null>(null);

  const [boxes, setBoxes] = useState<DepositedBox[]>([]);
  const [withdrawPrefill, setWithdrawPrefill] = useState<DepositedBox | null>(
    null,
  );

  // Provider depends only on the config — memoize so deposit/withdraw
  // panels don't see a new instance on every render. We swallow the
  // "missing project id" error here because the user can fix it in the
  // ConfigPanel without seeing a console-level red flash.
  const provider = useMemo<BlockfrostProvider | null>(() => {
    try {
      return makeProvider(config);
    } catch {
      return null;
    }
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    setAddresses(null);
    setAddressesError(null);
    loadAddresses(config.network)
      .then((a) => {
        if (!cancelled) setAddresses(a);
      })
      .catch((e: Error) => {
        if (!cancelled) setAddressesError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [config.network]);

  const ready = provider !== null && addresses !== null && wallet !== null;

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-1 px-6 py-5">
          <h1 className="text-2xl font-bold tracking-tight">{t("app.title")}</h1>
          <p className="text-sm text-gray-600">{t("app.tagline")}</p>
          <p className="text-xs text-amber-700">
            {t("app.vertical_slice_banner")}
          </p>
        </div>
      </header>

      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <ConfigPanel config={config} onChange={setConfig} />
        {addressesError && (
          <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            {t("config.missing_addresses", { network: config.network })}
            <span className="ml-2 text-amber-700">({addressesError})</span>
          </p>
        )}
        <WalletPanel
          wallet={wallet}
          walletId={walletId}
          changeAddress={changeAddress}
          onWalletConnected={({ wallet, walletId, changeAddress }) => {
            setWallet(wallet);
            setWalletId(walletId);
            setChangeAddress(changeAddress);
          }}
          onWalletDisconnected={() => {
            setWallet(null);
            setWalletId(null);
            setChangeAddress(null);
          }}
        />
        {ready && (
          <DepositPanel
            network={config.network}
            provider={provider}
            addresses={addresses}
            wallet={wallet}
            onDeposited={(box) => setBoxes((prev) => [box, ...prev])}
          />
        )}
        <MyBoxesPanel
          boxes={boxes}
          onSelect={(box) => setWithdrawPrefill(box)}
        />
        {ready && (
          <MixPanel
            network={config.network}
            provider={provider}
            addresses={addresses}
            wallet={wallet}
            myBoxes={boxes}
            onMixed={({ txId, spent, newOutputs }) => {
              // M4 vertical-slice handling: drop the spent boxes from
              // the in-memory list and append placeholders for the new
              // ones. We don't know which output (a', b') belongs to
              // which input — the SDK's planMixTx applies a random
              // permutation that the UI doesn't surface yet — so we
              // keep the user's secret on every new entry. A future
              // fetchPool call (M5/M6) will use ownsBox to confirm
              // which entries actually unlock under the secret.
              setBoxes((prev) => {
                const spentRefs = new Set(
                  spent.map((b) => `${b.txId}#${b.outputIndex}`),
                );
                const remaining = prev.filter(
                  (b) => !spentRefs.has(`${b.txId}#${b.outputIndex}`),
                );
                const seedSecret = spent[0]!.ownerSecretHex;
                const seedRounds = spent[0]!.rounds;
                const refreshed = newOutputs.map((o) => ({
                  txId,
                  outputIndex: o.outputIndex as 0,
                  ownerSecretHex: seedSecret,
                  aHex: bytesToHex(o.a),
                  bHex: bytesToHex(o.b),
                  label: bytesToHex(o.b).slice(0, 16),
                  rounds: seedRounds,
                  createdAt: Date.now(),
                }));
                return [...refreshed, ...remaining];
              });
            }}
          />
        )}
        {ready && (
          <WithdrawPanel
            network={config.network}
            provider={provider}
            addresses={addresses}
            wallet={wallet}
            prefill={withdrawPrefill}
            onWithdrawn={(spent) => {
              setBoxes((prev) =>
                prev.filter(
                  (b) =>
                    !(
                      b.txId === spent.txId &&
                      b.outputIndex === spent.outputIndex
                    ),
                ),
              );
              setWithdrawPrefill(null);
            }}
          />
        )}
      </div>
    </main>
  );
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
