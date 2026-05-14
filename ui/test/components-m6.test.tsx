// M6 component smoke tests — pure render paths for the new components.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CollateralProviderBanner,
  CollateralProviderPill,
} from "../src/components/CollateralProviderStatus.js";
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
