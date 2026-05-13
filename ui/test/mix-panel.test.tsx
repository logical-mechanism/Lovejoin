// MixPanel — branching coverage for the unified Mix interface.
//
// What we pin here is the BRANCHING LOGIC the user-facing UX depends
// on, not the submit machinery (which lives in useSingleMix and
// useFanoutSubmit and is exercised indirectly through E2E + the
// pickMixInputs unit tests). The branches are:
//
//   • Intensity dial offers k=1, k=2, k=3 by default; k=4 only when
//     `advanced` is true.
//   • At k=1 the fee-payer toggle is visible.
//   • At k≥2 the fee-payer toggle is HIDDEN (wallet mode would publish
//     the user's identity across every leaf).
//   • When the vault is locked, picking k≥2 surfaces the
//     vault-locked-at-depth hint and the CTA stays disabled.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ChainProvider, LovejoinAddresses } from "@lovejoin/sdk";

import { MixPanel } from "../src/components/MixPanel.js";
import { BackendStatusProvider } from "../src/components/BackendStatus.js";
import { CollateralStatusProvider } from "../src/components/CollateralProviderStatus.js";
import { ToasterProvider } from "../src/components/Toaster.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

const FAKE_ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: {
    denom_lovelace: 10_000_000,
    max_fee_per_mix_lovelace: 2_000_000,
    fee_shard_target: 10,
    max_n_shard: 3,
    max_n_wallet: 4,
  },
  // The rest of the address fields aren't read by MixPanel's render
  // path; we cast through `unknown` so TS doesn't insist on full shape.
} as unknown as LovejoinAddresses;

const FAKE_PROVIDER = {} as ChainProvider;

function makePoolEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ref: { txId: `${i.toString(16).padStart(64, "0")}`, outputIndex: 0 },
    a: new Uint8Array(48),
    b: new Uint8Array(48),
  }));
}

function renderPanel(opts: { advanced?: boolean; initialIntensity?: number } = {}) {
  return render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true, addresses: FAKE_ADDRESSES }}>
      <ToasterProvider>
        <CollateralStatusProvider endpoint={null} testOverrides={{ skipPolling: true }}>
          <BackendStatusProvider backendUrl={null} testOverrides={{ skipPolling: true }}>
            <MemoryRouter>
              <MixPanel
                network="preprod"
                provider={FAKE_PROVIDER}
                addresses={FAKE_ADDRESSES}
                wallet={null}
                poolEntries={makePoolEntries(5)}
                advanced={opts.advanced ?? false}
                {...(opts.initialIntensity !== undefined
                  ? { initialIntensity: opts.initialIntensity }
                  : {})}
                onSingleMixSubmitted={() => {}}
                onSingleMixError={() => {}}
              />
            </MemoryRouter>
          </BackendStatusProvider>
        </CollateralStatusProvider>
      </ToasterProvider>
    </AppStateProvider>,
  );
}

describe("MixPanel", () => {
  it("offers k=1, k=2, k=3 on the intensity dial by default", () => {
    renderPanel();
    const group = screen.getByRole("group", { name: /Intensity/i });
    const buttons = group.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    expect(buttons[0]!.textContent).toMatch(/Random/i);
    expect(buttons[1]!.textContent).toMatch(/Depth 2/i);
    expect(buttons[2]!.textContent).toMatch(/Depth 3/i);
  });

  it("exposes k=4 only when advanced=true", () => {
    renderPanel({ advanced: true });
    const group = screen.getByRole("group", { name: /Intensity/i });
    const buttons = group.querySelectorAll("button");
    expect(buttons.length).toBe(4);
    expect(buttons[3]!.textContent).toMatch(/Depth 4/i);
  });

  it("renders the fee-payer toggle at k=1 (default)", () => {
    renderPanel();
    expect(screen.getByRole("group", { name: "Fee payer" })).toBeInTheDocument();
  });

  it("hides the fee-payer toggle at k≥2", () => {
    renderPanel();
    // Wallet mode at every leaf of a fan-out would publish the
    // submitter's identity across N txs, so we force shard and drop
    // the toggle entirely once intensity goes above 1.
    fireEvent.click(screen.getByRole("button", { name: /Depth 2/i }));
    expect(screen.queryByRole("group", { name: "Fee payer" })).toBeNull();
  });

  it("surfaces an inline Connect wallet CTA at k≥2 when no wallet is connected", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Depth 2/i }));
    // The depth-gate hint mentions connecting a wallet, and the inline
    // button uses the app-wide "Connect wallet" label.
    expect(screen.getByText(/Connect a wallet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect wallet/i })).toBeInTheDocument();
  });

  it("honours initialIntensity from the URL on mount", () => {
    renderPanel({ initialIntensity: 3 });
    // The Depth 3 button is pressed without any user interaction.
    const btn = screen.getByRole("button", { name: /Depth 3/i });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // And the fee-payer toggle is gone (k≥2 forces shard).
    expect(screen.queryByRole("group", { name: "Fee payer" })).toBeNull();
  });
});
