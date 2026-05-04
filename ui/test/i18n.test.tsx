// Smoke test: the App boots through the router shell + AppState provider
// and renders English copy from en.json.
//
// We mount the Layout directly under MemoryRouter + AppStateProvider with
// `skipAddressLoad` set so the test doesn't need a fetch shim for
// addresses.json. The asserts cover the header brand mark + the nav —
// enough to prove the i18n harness is wired correctly.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Layout } from "../src/routes/Layout.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

function renderShell() {
  render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true }}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<div>Home stub</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppStateProvider>,
  );
}

describe("UI i18n harness", () => {
  it("renders the brand mark from en.json", () => {
    renderShell();
    // The brand appears in the header brand link AND the footer mark; both
    // are valid hits.
    expect(screen.getAllByText("Lovejoin").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the network label in the footer", () => {
    renderShell();
    // Footer renders `config.network` (lowercase, e.g. "preprod"). The
    // test AppStateProvider defaults to "preprod" via skipAddressLoad.
    expect(screen.getAllByText("preprod").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the navigation links", () => {
    renderShell();
    // Brand link + 3 nav items (Deposit / Mix / Vault).
    expect(screen.getAllByRole("link").length).toBeGreaterThanOrEqual(4);
  });
});
