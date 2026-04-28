// M6 component smoke tests — pure render paths for the new components.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CollateralProviderBanner,
  CollateralProviderPill,
} from "../src/components/CollateralProviderStatus.js";
import { MixWidthSlider } from "../src/components/MixWidthSlider.js";
import { SeedelfHint } from "../src/components/SeedelfHint.js";
import { buildScriptAddress } from "@lovejoin/sdk";
import "../src/i18n/index.js";

describe("CollateralProviderPill", () => {
  it("renders the green pill when online", () => {
    render(<CollateralProviderPill status="online" />);
    expect(screen.getByText(/online/i)).toBeInTheDocument();
  });

  it("renders the amber pill when down", () => {
    render(<CollateralProviderPill status="down" />);
    expect(screen.getByText(/unreachable/i)).toBeInTheDocument();
  });
});

describe("CollateralProviderBanner", () => {
  it("renders nothing when status is online", () => {
    const { container } = render(<CollateralProviderBanner status="online" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner when status is down", () => {
    render(<CollateralProviderBanner status="down" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("MixWidthSlider", () => {
  it("clamps value into [2, maxN] and reports the right labels", () => {
    const onChange = vi.fn();
    render(<MixWidthSlider value={99} maxN={6} onChange={onChange} />);
    // The visible value is the clamped one.
    expect(screen.getByText(/N = 6/)).toBeInTheDocument();
    expect(screen.getByText(/max 6/)).toBeInTheDocument();
  });

  it("emits a numeric onChange when the slider moves", () => {
    const onChange = vi.fn();
    render(<MixWidthSlider value={2} maxN={6} onChange={onChange} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "4" } });
    expect(onChange).toHaveBeenCalledWith(4);
  });
});

describe("SeedelfHint", () => {
  const SCRIPT_HASH = "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2";
  it("renders the green stealth hint for a script address", () => {
    const addr = buildScriptAddress(SCRIPT_HASH, 0);
    render(<SeedelfHint address={addr} />);
    expect(screen.getByText(/Stealth address/i)).toBeInTheDocument();
  });

  it("renders nothing for an empty input", () => {
    const { container } = render(<SeedelfHint address="" />);
    expect(container.firstChild).toBeNull();
  });
});
