// Open Food Facts lookups (free, no key). https://openfoodfacts.github.io/openfoodfacts-server/api/
const BASE = 'https://world.openfoodfacts.org';
const FIELDS = 'code,product_name,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments,image_front_small_url';

const num = v => (v === '' || v == null || isNaN(+v) ? null : +v);

export function mapProduct(p) {
  const n = p.nutriments || {};
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null) {
    const kj = num(n['energy-kj_100g']) ?? num(n['energy_100g']);
    if (kj != null) kcal = kj / 4.184;
  }
  const servingG = num(p.serving_quantity);
  let per100 = { kcal, p: num(n.proteins_100g), c: num(n.carbohydrates_100g), f: num(n.fat_100g) };

  // Some products only list per-serving values.
  if (kcal == null && servingG) {
    const sk = num(n['energy-kcal_serving']) ?? (num(n['energy-kj_serving']) != null ? n['energy-kj_serving'] / 4.184 : null);
    if (sk != null) {
      const k = 100 / servingG;
      per100 = {
        kcal: sk * k,
        p: (num(n.proteins_serving) ?? 0) * k,
        c: (num(n.carbohydrates_serving) ?? 0) * k,
        f: (num(n.fat_serving) ?? 0) * k,
      };
    }
  }
  // Extras are per 100 g; Open Food Facts gives sodium in grams.
  const extras = {};
  const k100 = kcal == null && servingG ? 100 / servingG : null;
  const extra = (key, field, mult = 1) => {
    let v = num(n[`${field}_100g`]);
    if (v == null && k100) { const s = num(n[`${field}_serving`]); if (s != null) v = s * k100; }
    if (v != null) extras[key] = Math.round(v * mult * 100) / 100;
  };
  extra('sat', 'saturated-fat');
  extra('sugar', 'sugars');
  extra('fibre', 'fiber');
  extra('sodium', 'sodium', 1000);

  return {
    name: (p.product_name_en || p.product_name || p.generic_name || '').trim() || 'Unnamed product',
    brand: (p.brands || '').split(',')[0].trim(),
    barcode: p.code || '',
    per100: {
      kcal: per100.kcal != null ? Math.round(per100.kcal * 10) / 10 : null,
      p: per100.p ?? 0, c: per100.c ?? 0, f: per100.f ?? 0,
      ...extras,
    },
    servingG: servingG || null,
    servingLabel: p.serving_size || '',
    unit: /\d\s*(ml|l)\b/i.test(p.quantity || '') ? 'ml' : 'g',
    image: p.image_front_small_url || '',
    source: 'off',
  };
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error("Couldn't reach Open Food Facts. Check your connection.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}. Try again in a minute.`);
  return res.json();
}

// Returns a mapped product, or null if the barcode isn't in the database.
export async function lookupBarcode(code) {
  const json = await getJson(`${BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`);
  if (!json || json.status !== 1 || !json.product) return null;
  return mapProduct({ code, ...json.product });
}

export async function searchProducts(query) {
  const url = `${BASE}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=20&fields=${FIELDS}`;
  const json = await getJson(url);
  return (json?.products || []).map(mapProduct).filter(p => p.per100.kcal != null);
}
