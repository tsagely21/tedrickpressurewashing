// Estimate calculation shared by browser (live summary) and server (stored estimate).
// Rates live in config/site.config.json -> pricing.services. No rates configured => no dollar total.

export function areaOf(item) {
  if (item.unsure) return null;
  const a = Number(item.areaSqft);
  return a > 0 ? a : null;
}

export function quantityOf(service, item) {
  if (item.unsure) return null;
  const n = Number(service.measure === 'fence' ? item.linearFt : item.areaSqft);
  return n > 0 ? n : null;
}

/** @returns {{available:true,total:number,lines:object[]}|{available:false,reason:string}} */
export function estimate(config, items) {
  const lines = [];
  for (const item of items) {
    const service = config.services.find((s) => s.id === item.id);
    const rule = config.pricing.services[item.id];
    if (!service || !rule || typeof rule.rate !== 'number') return { available: false, reason: 'rates-not-configured' };
    let qty = 1;
    if (rule.method !== 'flat') {
      qty = quantityOf(service, item);
      if (!qty) return { available: false, reason: 'needs-assessment' };
    }
    const mult = config.pricing.conditionMultipliers?.[item.condition] ?? 1;
    const raw = rule.method === 'flat' ? rule.rate * mult : rule.rate * qty * mult;
    const amount = Math.round(Math.max(raw, rule.minimum || 0) * 100) / 100;
    lines.push({ id: item.id, label: service.label, amount });
  }
  if (!lines.length) return { available: false, reason: 'no-services' };
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { available: true, total, lines };
}

export const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
