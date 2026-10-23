import type { RegionTranslation } from './types';

type Crop = RegionTranslation['crop'];

// Od této shody (průnik / sjednocení) se označení bere jako stejná oblast.
const SAME_REGION = 0.9;

export function overlap(a: Crop, b: Crop) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (c: Crop) => (c[2] - c[0]) * (c[3] - c[1]);
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
}

export function findRegion(regions: RegionTranslation[], page: number, crop: Crop) {
  return regions.find((r) => r.page === page && overlap(r.crop, crop) >= SAME_REGION);
}

/** Výřez seřazený (x0 < x1, y0 < y1) a oříznutý na stránku. */
export function normalizeCrop([x0, y0, x1, y1]: Crop): Crop {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(Math.min(x0, x1)), clamp(Math.min(y0, y1)), clamp(Math.max(x0, x1)), clamp(Math.max(y0, y1))];
}

/** Segmenty, které další běh přeloží: vybrané a dosud nepřeložené. */
export const pendingSegments = <T extends { skipped?: boolean; translation?: string }>(segments: T[]) =>
  segments.filter((s) => !s.skipped && s.translation === undefined);
