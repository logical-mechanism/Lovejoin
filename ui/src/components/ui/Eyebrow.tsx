// Small uppercase letter-spaced label rendered above sections — the
// editorial "eyebrow" device. One styling primitive used everywhere a
// section needs a category marker without competing for attention.

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="lj-eyebrow">{children}</span>;
}
