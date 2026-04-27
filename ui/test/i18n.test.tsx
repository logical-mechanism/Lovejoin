import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import "../src/i18n/index.js";

describe("UI i18n harness", () => {
  it("renders the English app title from en.json", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Lovejoin" })).toBeInTheDocument();
  });

  it("renders the English tagline from en.json", () => {
    render(<App />);
    expect(
      screen.getByText("Sigmajoin privacy mixer on Cardano. Hyperstructure."),
    ).toBeInTheDocument();
  });
});
