// Smoke tests for the M3.5 panel components.
//
// These cover the pure render paths and event handlers that don't need a
// real CIP-30 wallet or chain provider. The end-to-end behavior (real
// deposit / withdraw txs through mesh) is verified manually on Preprod —
// see docs/m3.5-verification.md for the steps and tx links.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigPanel } from "../src/components/ConfigPanel.js";
import { MyBoxesPanel } from "../src/components/MyBoxesPanel.js";
import { WalletPanel } from "../src/components/WalletPanel.js";
import type { DepositedBox } from "../src/components/DepositPanel.js";
import "../src/i18n/index.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConfigPanel", () => {
  it("calls onChange + persists when the user clicks Save", () => {
    const onChange = vi.fn();
    render(
      <ConfigPanel
        config={{
          network: "preprod",
          blockfrostProjectId: "",
          backendUrl: "",
          collateralProviderEndpoint: "https://giveme.my",
        }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(/Blockfrost project ID/i);
    fireEvent.change(input, { target: { value: "preprodAbc" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));
    expect(onChange).toHaveBeenCalledWith({
      network: "preprod",
      blockfrostProjectId: "preprodAbc",
      backendUrl: "",
      collateralProviderEndpoint: "https://giveme.my",
    });
    expect(window.localStorage.getItem("lovejoin.config.v1")).toContain(
      "preprodAbc",
    );
  });
});

describe("MyBoxesPanel", () => {
  it("shows the empty state when no boxes have been deposited", () => {
    render(<MyBoxesPanel boxes={[]} onSelect={() => {}} />);
    expect(
      screen.getByText(/Successful deposits will land here/i),
    ).toBeInTheDocument();
  });

  it("renders one row per deposited box and triggers onSelect", () => {
    const box: DepositedBox = {
      txId: "a".repeat(64),
      outputIndex: 0,
      ownerSecretHex: "1".repeat(64),
      aHex: "2".repeat(96),
      bHex: "3".repeat(96),
      label: "33333333".slice(0, 16),
      rounds: 30,
      createdAt: Date.now(),
    };
    const onSelect = vi.fn();
    render(<MyBoxesPanel boxes={[box]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));
    expect(onSelect).toHaveBeenCalledWith(box);
  });
});

describe("WalletPanel", () => {
  it("shows a connected state when a wallet handle is supplied", () => {
    const fakeWallet = {} as unknown as Parameters<
      typeof WalletPanel
    >[0]["wallet"];
    render(
      <WalletPanel
        wallet={fakeWallet}
        walletId="lace"
        changeAddress="addr_test1qxyz"
        onWalletConnected={() => {}}
        onWalletDisconnected={() => {}}
      />,
    );
    expect(screen.getByText(/Connected as lace/i)).toBeInTheDocument();
    expect(screen.getByText(/addr_test1qxyz/)).toBeInTheDocument();
  });
});
