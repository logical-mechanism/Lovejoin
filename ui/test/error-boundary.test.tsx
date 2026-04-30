// Smoke test for the app-level error boundary. We can't fully verify
// the "Reload" / "Reset state" buttons in jsdom (window.location.reload
// is non-trivial to spy on without environment hacks), so we focus on
// the actual behavioural contract: a render error inside the boundary
// renders the fallback screen instead of propagating up.
//
// Console.error is silenced for the throwing test so the test output
// stays readable — React's default error logging is noisy and isn't
// the assertion target here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { ErrorBoundary } from "../src/components/ErrorBoundary.js";
import "../src/i18n/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function Throws({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

function Healthy(): JSX.Element {
  return <p>Healthy child rendered</p>;
}

describe("ErrorBoundary", () => {
  it("renders children unchanged when nothing throws", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Healthy />
      </ErrorBoundary>,
    );
    expect(getByText("Healthy child rendered")).toBeTruthy();
  });

  it("catches a render error and shows the fallback screen", () => {
    // Suppress React's error log for this branch only — the throw is
    // the test setup, not a real failure.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByRole, getByText } = render(
      <ErrorBoundary>
        <Throws message="kaboom" />
      </ErrorBoundary>,
    );
    // The fallback screen is announced as role=alert per the
    // ErrorBoundary's contract.
    expect(getByRole("alert")).toBeTruthy();
    // The message bubble surfaces the raw error text so the user can
    // report it.
    expect(getByText("kaboom")).toBeTruthy();
  });
});
