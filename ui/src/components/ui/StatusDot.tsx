// 6px status dot — the design system's only "icon".
//
// `tone` maps to a CSS modifier rather than a prop-driven inline style so
// the whole palette stays in tailwind.css. Filled dot for live states,
// hollow ring for disconnected.

export type StatusTone = "ok" | "warn" | "bad" | "neutral";

export function StatusDot({
  tone = "neutral",
  hollow = false,
  label,
}: {
  tone?: StatusTone;
  hollow?: boolean;
  label?: string;
}) {
  const cls = ["lj-dot"];
  if (tone === "ok") cls.push("lj-dot--ok");
  else if (tone === "warn") cls.push("lj-dot--warn");
  else if (tone === "bad") cls.push("lj-dot--bad");
  if (hollow) cls.push("lj-dot--hollow");
  return (
    <span
      className={cls.join(" ")}
      role={label ? "img" : undefined}
      aria-label={label}
    />
  );
}
