import { describe, expect, it } from "vitest";
import { BACKEND_VERSION } from "../src/index.js";

describe("@lovejoin/backend smoke", () => {
  it("exposes a version", () => {
    expect(BACKEND_VERSION).toBe("0.2.0");
  });
});
