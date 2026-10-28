const parts = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);

/** Je verze `a` novější než `b`? (prosté porovnání X.Y.Z, předvydání se ignoruje) */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
