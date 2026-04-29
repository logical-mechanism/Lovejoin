import { describe, expect, it } from "vitest";
import { DOMAIN_TAG_V1, SDK_VERSION } from "../src/index.js";

describe("@lovejoin/sdk smoke", () => {
  it("exposes a version", () => {
    expect(SDK_VERSION).toBe("0.2.0");
  });

  it("declares the canonical FS domain tag", () => {
    expect(DOMAIN_TAG_V1).toBe("lovejoin/sigmajoin/v1/");
  });
});
