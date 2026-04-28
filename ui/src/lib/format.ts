// Display formatting helpers.
//
// Currently just `formatAda` — the SDK speaks lovelace (1 ADA = 1e6),
// every UI surface speaks ADA, and the conversion happened ad-hoc with
// `(Number(lovelace) / 1_000_000).toFixed(2)` at four call sites. That
// produces `1234.00 ₳` which is hard to scan. Centralising here gives
// us thousands grouping for free + one place to revisit precision.

const ADA_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatAda(lovelace: bigint | number): string {
  const n = typeof lovelace === "bigint" ? Number(lovelace) : lovelace;
  return ADA_FORMAT.format(n / 1_000_000);
}
