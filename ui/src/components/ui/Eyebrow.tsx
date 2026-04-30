// Small uppercase letter-spaced label rendered above sections — the
// editorial "eyebrow" device. One styling primitive used everywhere a
// section needs a category marker without competing for attention.
//
// Accepts `id` so callers can wire `aria-labelledby` from a form group
// or toggle to the eyebrow that visually labels it (e.g. Pool's
// fee-payer toggle group).

export interface EyebrowProps {
  id?: string;
  children: React.ReactNode;
}

export function Eyebrow({ id, children }: EyebrowProps) {
  return <span className="lj-eyebrow" id={id}>{children}</span>;
}
