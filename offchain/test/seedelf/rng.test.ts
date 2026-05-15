import { describe, expect, it } from "vitest";

import { SCALAR_ORDER } from "../../src/crypto/bls.js";
import { drawRerandomizationScalar } from "../../src/seedelf/rng.js";

describe("seedelf/rng — re-randomization scalar draws", () => {
  it("returns a scalar in [1, r) for every draw", () => {
    for (let i = 0; i < 32; i++) {
      const s = drawRerandomizationScalar();
      expect(s).toBeGreaterThan(0n);
      expect(s).toBeLessThan(SCALAR_ORDER);
    }
  });

  it("produces fresh values on each call (overwhelmingly likely)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      seen.add(drawRerandomizationScalar().toString());
    }
    expect(seen.size).toBe(16);
  });
});
