// Rozsah stránek ve tvaru „1-8“, „1-3, 5, 9-10“. Prázdný = všechny.
const RANGE = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

export const isValidPageRange = (range: string) => !range.trim() || RANGE.test(range);

/** Vybrané stránky (1…total) ve vzestupném pořadí; stránky mimo dokument se ignorují. */
export function selectPages(range: string | undefined, total: number): number[] {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (!range?.trim()) return all;
  if (!RANGE.test(range)) throw new Error(`Neplatný rozsah stránek „${range}“. Použij např. 1-8 nebo 1-3, 5.`);
  const chosen = new Set<number>();
  for (const part of range.split(',')) {
    const [a, b = a] = part.split('-').map((n) => Number(n.trim()));
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) if (p >= 1 && p <= total) chosen.add(p);
  }
  if (!chosen.size) throw new Error(`Rozsah „${range}“ neobsahuje žádnou stránku dokumentu (má ${total} str.).`);
  return all.filter((p) => chosen.has(p));
}
