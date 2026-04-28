// Smoke test: the App boots through the router shell + AppState provider
// and renders English copy from en.json.
//
// We can't render the full App here without a fetch shim for addresses.json,
// so we mount the Layout directly under MemoryRouter + AppStateProvider
// with `skipAddressLoad` set. The asserts cover the header copy + the nav
// — enough to prove the i18n harness is wired correctly under the new
// router topology.

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
  it("renders the English app title from en.json", () => {
    renderShell();
    expect(screen.getByRole("heading", { name: "Lovejoin" })).toBeInTheDocument();
  });

  it("renders the English tagline from en.json", () => {
    renderShell();
    expect(
      screen.getByText("Sigmajoin privacy mixer on Cardano. Hyperstructure."),
    ).toBeInTheDocument();
  });

  it("renders the navigation links", () => {
    renderShell();
    expect(screen.getAllByRole("link").length).toBeGreaterThanOrEqual(5);
  });
});
