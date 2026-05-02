// Unit tests for tx/retry.ts.

import { describe, expect, it, vi } from "vitest";

import { isInputCollisionError, withInputCollisionRetry } from "../../src/tx/retry.js";

describe("tx/retry isInputCollisionError", () => {
  it("matches BadInputsUTxO in a Blockfrost-shaped error body", () => {
    const err = new Error(
      'BlockfrostProvider.submitTx failed (400 Bad Request): {"error":"Bad Request","message":"transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError [UtxowFailure (UtxoFailure (BadInputsUTxO ...))])"}',
    );
    expect(isInputCollisionError(err)).toBe(true);
  });

  it("matches ValueNotConservedUTxO", () => {
    const err = new Error("submit failed: ValueNotConservedUTxO ...");
    expect(isInputCollisionError(err)).toBe(true);
  });

  it("matches loose `input not found` strings (mesh / ogmios shape)", () => {
    const err = new Error("submission rejected: input not found in UTxO set");
    expect(isInputCollisionError(err)).toBe(true);
  });

  it("matches `unknown input`", () => {
    expect(isInputCollisionError(new Error("Unknown input txid#0"))).toBe(true);
  });

  it("matches ogmios JSON-RPC error 3117 (unknown UTxO references)", () => {
    const err = new Error(
      "BackendChainProvider.submitTx (400): ogmios JSON-RPC error 3117: The transaction contains unknown UTxO references as inputs. This can happen if the inputs you're trying to spend have already been spent, or if you've simply referred to non-existing UTxO altogether. The field 'data.unknownOutputReferences' indicates all unknown inputs.",
    );
    expect(isInputCollisionError(err)).toBe(true);
  });

  it("matches the bare `unknownOutputReferences` token (ogmios data field)", () => {
    expect(isInputCollisionError(new Error('{"data":{"unknownOutputReferences":[...]}}'))).toBe(
      true,
    );
  });

  it("does not match unrelated errors", () => {
    expect(
      isInputCollisionError(new Error("ScriptEvaluationFailure: validator returned False")),
    ).toBe(false);
    expect(isInputCollisionError(new Error("FeeTooSmall: minimum fee 200000 lovelace"))).toBe(
      false,
    );
    expect(isInputCollisionError(new Error("network unreachable"))).toBe(false);
  });

  it("handles non-Error thrown values", () => {
    expect(isInputCollisionError("BadInputsUTxO at boot")).toBe(true);
    expect(isInputCollisionError("just a string")).toBe(false);
    expect(isInputCollisionError(undefined)).toBe(false);
    expect(isInputCollisionError(null)).toBe(false);
  });
});

describe("tx/retry withInputCollisionRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withInputCollisionRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on collision until success", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("BadInputsUTxO");
      return "finally";
    });
    const onRetry = vi.fn();
    const result = await withInputCollisionRetry(fn, {
      maxAttempts: 3,
      onRetry,
    });
    expect(result).toBe("finally");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 2 }));
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 3 }));
  });

  it("re-throws after maxAttempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("BadInputsUTxO permanent");
    });
    await expect(withInputCollisionRetry(fn, { maxAttempts: 2 })).rejects.toThrow(/BadInputsUTxO/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-collision errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ScriptEvaluationFailure");
    });
    await expect(withInputCollisionRetry(fn, { maxAttempts: 5 })).rejects.toThrow(
      /ScriptEvaluationFailure/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats maxAttempts undefined as no retry", async () => {
    const fn = vi.fn(async () => {
      throw new Error("BadInputsUTxO");
    });
    await expect(withInputCollisionRetry(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the 1-indexed attempt number to fn", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withInputCollisionRetry(
      async (attempt) => {
        seen.push(attempt);
        calls += 1;
        if (calls < 3) throw new Error("BadInputsUTxO");
        return null;
      },
      { maxAttempts: 5 },
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it("waits delayBetweenAttemptsMs between collision retries", async () => {
    let calls = 0;
    const t0 = Date.now();
    await withInputCollisionRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("BadInputsUTxO");
        return null;
      },
      { maxAttempts: 5, delayBetweenAttemptsMs: 30 },
    );
    const elapsed = Date.now() - t0;
    // Two retries × 30 ms = 60 ms minimum. Allow generous slack for
    // CI scheduler jitter; we just want to know the delay actually
    // ran (not a regression to no-delay).
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(calls).toBe(3);
  });

  it("does not delay on success or non-collision errors", async () => {
    const t0 = Date.now();
    const ok = await withInputCollisionRetry(async () => "fast", {
      maxAttempts: 3,
      delayBetweenAttemptsMs: 100,
    });
    expect(ok).toBe("fast");
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
