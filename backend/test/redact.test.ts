// Unit coverage for `redactUpstreamMessage`. The function lives at
// `backend/src/api/redact.ts` and is the only thing standing between
// an upstream stack trace (postgres URL, ogmios endpoint, Blockfrost
// project id, internal IP) and the wire response a public client
// sees on `/health`, `/submit`, `/evaluate`, `/protocol-params`,
// etc. Security review v1, finding H3.

import { describe, expect, it } from "vitest";

import { redactUpstreamMessage } from "../src/api/redact.js";

describe("redactUpstreamMessage", () => {
  it("returns the literal 'upstream error' for empty / null / undefined input", () => {
    expect(redactUpstreamMessage(undefined)).toBe("upstream error");
    expect(redactUpstreamMessage(null)).toBe("upstream error");
    expect(redactUpstreamMessage("")).toBe("upstream error");
  });

  it("strips postgres connection strings (postgres:// + postgresql://)", () => {
    const a = redactUpstreamMessage(
      "connect ECONNREFUSED postgres://user:pass@db.internal:5432/lovejoin",
    );
    expect(a).not.toMatch(/db\.internal/);
    expect(a).not.toMatch(/user:pass/);
    expect(a).toMatch(/postgres:\/\/\*\*\*/);

    const b = redactUpstreamMessage(
      "postgresql://user@10.0.0.5/db?sslmode=require connection failed",
    );
    expect(b).not.toMatch(/10\.0\.0\.5/);
    expect(b).not.toMatch(/sslmode=require/);
    expect(b).toMatch(/postgres:\/\/\*\*\*/i);
  });

  it("masks Blockfrost project ids on every supported network", () => {
    expect(redactUpstreamMessage("preprod9aabbccddeeff00112233445566778899")).toMatch(
      /preprod\*\*\*/,
    );
    expect(redactUpstreamMessage("mainnetdeadbeefdeadbeefdeadbeefdeadbeef")).toMatch(
      /mainnet\*\*\*/,
    );
    expect(redactUpstreamMessage("preview1234567890abcdef1234567890abcdef")).toMatch(
      /preview\*\*\*/,
    );

    const kv = redactUpstreamMessage(
      "upstream rejected with project_id=preprod9aabbccddeeff00112233445566778899",
    );
    expect(kv).toMatch(/project_id=\*\*\*/);
  });

  it("does not redact short tokens that happen to start with a network prefix", () => {
    // 19-char body — below the 20-char tail threshold of the
    // `\bpreprod[a-z0-9]{20,}\b` rule. Real project ids are 32 chars,
    // so this guards against false-positive redactions on legitimate
    // English (e.g. the word 'preprod' in a user-facing message).
    const out = redactUpstreamMessage("preprod1234567890abcde upstream said hello");
    expect(out).not.toMatch(/preprod\*\*\*/);
  });

  it("strips bare URLs across http, https, ws, wss schemes", () => {
    expect(redactUpstreamMessage("connect failed: ws://ogmios.internal:1337")).toMatch(
      /ws:\/\/\*\*\*/,
    );
    expect(redactUpstreamMessage("HEAD https://blockfrost.io/api/v0/health 401")).toMatch(
      /https:\/\/\*\*\*/,
    );
    expect(redactUpstreamMessage("upstream wss://node.local:1338 closed")).toMatch(
      /wss:\/\/\*\*\*/,
    );
    expect(redactUpstreamMessage("http://api.example.com/x failed")).toMatch(/http:\/\/\*\*\*/);
  });

  it("masks IPv4 addresses with and without ports", () => {
    expect(redactUpstreamMessage("ECONNREFUSED 10.0.0.5:1337")).not.toMatch(/10\.0\.0\.5/);
    expect(redactUpstreamMessage("dial 192.168.1.42 timed out")).not.toMatch(/192\.168\.1\.42/);
    // The port itself is part of the redacted block.
    expect(redactUpstreamMessage("connect to 172.16.0.1:5432 failed")).not.toMatch(/172\.16\.0\.1/);
  });

  it("caps the result at 256 chars with an ellipsis suffix", () => {
    const long = "x".repeat(1000);
    const out = redactUpstreamMessage(long);
    expect(out.length).toBe(256);
    expect(out.endsWith("...")).toBe(true);

    // A short, redactable input does not get truncated.
    const short = redactUpstreamMessage("ECONNREFUSED 10.0.0.1");
    expect(short.length).toBeLessThan(256);
    expect(short.endsWith("...")).toBe(false);
  });

  it("composes redactions: a single message can contain every category", () => {
    const out = redactUpstreamMessage(
      "submit failed: postgres://u:p@10.0.0.5:5432/db then https://blockfrost.io/api?project_id=preprod9aabbccddeeff00112233445566778899 then ws://ogmios.internal:1337",
    );
    expect(out).not.toMatch(/postgres:\/\/u:p/);
    expect(out).not.toMatch(/blockfrost\.io/);
    expect(out).not.toMatch(/ogmios\.internal/);
    expect(out).not.toMatch(/10\.0\.0\.5/);
    expect(out).not.toMatch(/preprod9aabbccddeeff/);
  });

  it("coerces non-string upstreams to a redacted string", () => {
    const numeric = redactUpstreamMessage(42 as unknown as string);
    expect(numeric).toBe("42");
  });
});
