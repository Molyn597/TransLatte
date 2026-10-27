import type { Store } from './store';

const CNB_URL = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt';

/** Kurz USD z denního kurzovního lístku ČNB („USA|dolar|1|USD|21,834“), přepočtený na 1 USD. */
export function parseCnbUsd(text: string): number | undefined {
  const line = text.split('\n').find((l) => l.split('|')[3] === 'USD');
  if (!line) return undefined;
  const [, , amount, , rate] = line.split('|');
  const value = Number(rate.replace(',', '.')) / Number(amount);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Kurz se stahuje nejvýš jednou denně; bez internetu zůstane poslední uložený. */
export async function usdCzk(store: Store): Promise<number | undefined> {
  const settings = await store.settings();
  if (settings.usdCzk?.date === today()) return settings.usdCzk.rate;
  try {
    const res = await fetch(CNB_URL, { signal: AbortSignal.timeout(5000) });
    const rate = res.ok ? parseCnbUsd(await res.text()) : undefined;
    if (rate) {
      await store.saveSettings({ ...(await store.settings()), usdCzk: { rate, date: today() } });
      return rate;
    }
  } catch {
    // Offline: použije se poslední známý kurz.
  }
  return settings.usdCzk?.rate;
}
