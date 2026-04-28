// Smoke tests for the dev-only ConfigPanel.
//
// Production users never see the panel — it's gated behind ?advanced=1
// in production. This test covers the pure form behavior (Save calls
// onChange + persists) without the gating, which lives in sdk.test.ts.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigPanel } from "../src/components/ConfigPanel.js";
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
