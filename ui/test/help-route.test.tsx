// Smoke tests for the /help route.
//
// Mirrors the Protocol page testing approach: render the component
// under the i18n harness and assert that translated copy reaches the
// DOM. No fetch, no markdown plumbing — every paragraph comes from
// `help.*` keys in `en.json`, same as `protocol.*` does for the
// Protocol page.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Help } from "../src/routes/Help.js";
import "../src/i18n/index.js";

function renderHelp(initialPath: string = "/help") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/help" element={<Help />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Help route", () => {
  it("renders the eyebrow, title, lede, and three tab buttons", () => {
    renderHelp();
    expect(screen.getByRole("heading", { name: "Help", level: 2 })).toBeInTheDocument();
    expect(
      screen.getByText(/Three short docs aimed at non-developers/),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "User guide" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "FAQ" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Glossary" })).toBeInTheDocument();
  });

  it("defaults to the user guide and shows its first section heading", () => {
    renderHelp();
    expect(
      screen.getByRole("tab", { name: "User guide", selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /What is Lovejoin/ }),
    ).toBeInTheDocument();
  });

  it("respects ?doc=faq deep-links", () => {
    renderHelp("/help?doc=faq");
    expect(
      screen.getByRole("tab", { name: "FAQ", selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Is my ADA safe/ }),
    ).toBeInTheDocument();
  });

  it("swaps the panel content when a tab is clicked", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    expect(
      screen.getByRole("heading", { name: "Box (mix-box)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Glossary", selected: true }),
    ).toBeInTheDocument();
  });

  it("renders the back-to-top button only after a scroll past the threshold", async () => {
    renderHelp();
    expect(
      screen.queryByRole("button", { name: /Back to top/i }),
    ).toBeNull();

    Object.defineProperty(window, "scrollY", { value: 600, configurable: true });
    window.dispatchEvent(new Event("scroll"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Back to top/i }),
      ).toBeInTheDocument(),
    );

    const scrollSpy = vi.fn();
    window.scrollTo = scrollSpy as unknown as typeof window.scrollTo;
    fireEvent.click(screen.getByRole("button", { name: /Back to top/i }));
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
