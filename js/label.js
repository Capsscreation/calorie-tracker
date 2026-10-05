// Reads a nutrition information panel from a photo, on the device (Tesseract OCR).
// The result is only a starting point: the user checks every number before saving.
const LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;

function loadLib() {
  if (window.Tesseract) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIB;
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('Could not load the label reader. Are you offline?')); };
    document.head.append(s);
  });
  return loading;
}

// Greyscale + contrast stretch, capped at ~2400px so OCR stays quick on phones.
async function prepare(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  let lo = 255, hi = 0;
  const grey = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    grey[j] = g;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    px[i] = px[i + 1] = px[i + 2] = ((grey[j] - lo) / range) * 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// A smaller copy of the photo to show beside the form while checking.
export async function previewOf(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, 1100 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.8);
}

export async function readLabel(file, onProgress = () => {}) {
  onProgress('Loading the label reader…', 0);
  await loadLib();
  const canvas = await prepare(file);
  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') onProgress('Reading the label…', m.progress);
      else if (/load|initializ/i.test(m.status)) onProgress('Loading the label reader…', m.progress || 0);
    },
  });
  try {
    const { data } = await worker.recognize(canvas);
    return parseNutritionText(data.text || '');
  } finally {
    worker.terminate();
  }
}

// ---------- text → numbers ----------
//
// OCR on panels makes predictable mistakes: "g" read as "9" ("29.4g" → "29.49") and
// dropped decimal points ("54.3g" → "543g"). Each number therefore gets several
// candidate readings, and the parser picks the combination that is consistent with
// (a) the per-serve ↔ per-100 g ratio and (b) the stated energy.

const ROWS = [
  ['energy', /^(energy|energie|calories|cal)\b/],
  ['p', /^protein\b/],
  ['sat', /saturate/],
  ['f', /^(fat|total fat|fat,? total)\b/],
  ['sugar', /^(total )?sugars?\b/],
  ['c', /^(carbohydrates?|total carbohydrates?|carbs)\b/],
  ['fibre', /fib(re|er)\b/],
  ['sodium', /^sodium\b/],
];
const MACROS = ['p', 'f', 'sat', 'c', 'sugar', 'fibre'];

function toNumber(s) {
  s = String(s).replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');   // 17,500
  else s = s.replace(',', '.');                                        // 2,5 (European)
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Number tokens on a line, left to right, with their unit if one was read.
function tokensOn(line) {
  const out = [];
  const re = /(?<![a-z\d.,])(<\s*)?(\d[\d.,]*\d|\d)\s*(kj|kcal|cal|mg|µg|ug|mcg|g)?(?![a-z\d])(?!\s*%)/gi;
  let m;
  while ((m = re.exec(line))) out.push({ raw: m[2], unit: (m[3] || '').toLowerCase() });
  return out;
}

// Possible gram values for a macro token, each with a penalty (lower = more likely).
function gramCandidates(tok) {
  const out = [];
  const add = (v, pen) => { if (v != null && isFinite(v) && v <= 100) out.push({ v, pen }); };
  if (tok.unit === 'mg') { add(toNumber(tok.raw) / 1000, 0); return out; }
  if (tok.unit && tok.unit !== 'g') return out;
  const bases = [];
  if (tok.unit === 'g') bases.push([tok.raw, 0]);
  else {
    if (/\d9$/.test(tok.raw)) bases.push([tok.raw.slice(0, -1), 0.5]);   // trailing "9" was the "g"
    bases.push([tok.raw, 1.5]);
  }
  for (const [b, pen] of bases) {
    add(toNumber(b), pen);
    if (!/[.,]/.test(b) && b.length >= 2) {
      for (let i = 1; i < b.length; i++) add(parseFloat(b.slice(0, i) + '.' + b.slice(i)), pen + 2);
    }
  }
  return out;
}

export function parseNutritionText(text) {
  const lines = text.split(/\n/)
    .map(l => l.replace(/[|“”"‘’]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let servingG = null;
  const sv = text.match(/serving size[^\d\n]{0,12}(\d+(?:[.,]\d+)?)\s*(g|ml|grams?|millilitres?)\b/i)
    || text.match(/serving size[^\n]*?\((\d+(?:[.,]\d+)?)\s*(g|ml)\)/i);
  if (sv) servingG = toNumber(sv[1]);

  const rows = {};
  const kj = [], kcal = [];
  for (const raw of lines) {
    const label = raw.replace(/^[^a-z]+/i, '').toLowerCase();
    const toks = tokensOn(raw);
    if (!toks.length) continue;
    for (const [key, re] of ROWS) {
      if (!re.test(label)) continue;
      if (key === 'f' && /saturate|trans|mono|poly/.test(label)) continue;
      if (key === 'c' && /sugar/.test(label)) continue;
      if (key === 'energy') {
        for (const t of toks) {
          if (t.unit === 'kj') kj.push(toNumber(t.raw));
          if (t.unit === 'kcal' || t.unit === 'cal' || (!t.unit && /^calories/.test(label))) kcal.push(toNumber(t.raw));
        }
        break;
      }
      if (rows[key]) break;
      const useful = toks.filter(t => !['kj', 'kcal', 'cal', 'µg', 'ug', 'mcg'].includes(t.unit));
      if (useful.length) rows[key] = useful;
      break;
    }
  }

  // Energy and column order. Australian/NZ panels list per serve first, per 100 g last.
  const energy = kj.length ? { list: kj, unit: 'kj', toKcal: 1 / 4.184 } : kcal.length ? { list: kcal, unit: 'kcal', toKcal: 1 } : null;
  const twoCol = (energy && energy.list.length >= 2) || Object.values(rows).filter(r => r.length >= 2).length >= 2;
  let hundredFirst = false, ratio = null, e100 = null;
  if (energy && energy.list.length >= 2) {
    const [a, b] = [energy.list[0], energy.list[energy.list.length - 1]];
    if (servingG && Math.abs(b * 100 / servingG - a) / a < 0.08 && Math.abs(a * 100 / servingG - b) / b >= 0.08) hundredFirst = true;
    e100 = hundredFirst ? a : b;
    const eServe = hundredFirst ? b : a;
    ratio = eServe > 0 ? e100 / eServe : null;
  } else if (servingG) {
    ratio = 100 / servingG;
  }
  const per100Basis = twoCol || (/100\s*(g|ml)\b/i.test(text) && !servingG);
  if (energy && !e100 && energy.list.length === 1 && per100Basis) e100 = energy.list[0];
  const kcal100 = e100 != null ? e100 * energy.toKcal : null;

  // Candidate per-100 g values for each macro row.
  const options = {};
  for (const key of MACROS) {
    const toks = rows[key];
    if (!toks) continue;
    let opts = [];
    if (twoCol && toks.length >= 2) {
      const serveTok = hundredFirst ? toks[toks.length - 1] : toks[0];
      const hundredTok = hundredFirst ? toks[0] : toks[toks.length - 1];
      const cb = gramCandidates(hundredTok);
      if (ratio) {
        for (const a of gramCandidates(serveTok)) for (const b of cb) {
          const err = Math.abs(a.v * ratio - b.v) / Math.max(b.v, 1);
          if (err <= 0.15) opts.push({ v: b.v, pen: a.pen + b.pen + err * 4 });
        }
      }
      if (!opts.length) opts = cb.map(c => ({ v: c.v, pen: c.pen + 3 }));
    } else {
      // One readable number: per 100 g (if that's the basis) or per serve.
      opts = gramCandidates(toks[toks.length - 1]).map(c => ({ v: c.v, pen: c.pen + 1 }));
    }
    options[key] = opts.sort((x, y) => x.pen - y.pen).slice(0, 5);
  }

  // Pick protein/carbs/fat/fibre together so they add up to the stated energy.
  const pool = k => (options[k]?.length ? options[k] : [{ v: null, pen: 0 }]);
  let best = null;
  const target = per100Basis ? kcal100 : (energy ? energy.list[0] * energy.toKcal : null);
  for (const p of pool('p')) for (const c of pool('c')) for (const f of pool('f')) for (const fi of pool('fibre')) {
    let score = p.pen + c.pen + f.pen + fi.pen;
    if (target && p.v != null && c.v != null && f.v != null) {
      const est = 4 * p.v + 4 * c.v + 9 * f.v + 1.9 * (fi.v || 0);
      score += 12 * Math.abs(est - target) / target;
    }
    if (!best || score < best.score) best = { score, p: p.v, c: c.v, f: f.v, fibre: fi.v };
  }

  const vals = {};
  if (energy) {
    const e = per100Basis ? e100 : energy.list[0];
    if (e != null) { vals.energy = e; vals.energyUnit = energy.unit; }
  }
  for (const k of ['p', 'c', 'f', 'fibre']) if (best?.[k] != null) vals[k] = best[k];
  const under = (k, max) => pool(k).find(o => o.v != null && (max == null || o.v <= max + 0.05))?.v;
  const sat = under('sat', vals.f);
  const sugar = under('sugar', vals.c);
  if (sat != null) vals.sat = sat;
  if (sugar != null) vals.sugar = sugar;

  if (rows.sodium) {
    const toks = rows.sodium;
    const t = per100Basis && toks.length >= 2 ? (hundredFirst ? toks[0] : toks[toks.length - 1]) : toks[0];
    const n = toNumber(t.raw);
    if (n != null) vals.sodium = t.unit === 'g' ? n * 1000 : n;
  }

  return {
    basis: per100Basis ? '100' : 'serving',
    vals,
    servingG,
    found: Object.keys(vals).filter(k => k !== 'energyUnit'),
    text,
  };
}
