import { FOODS } from './foods.js';

// ---------- numbers ----------

const UNICODE_FRACTIONS = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5',
  '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5, dozen: 12, quarter: 0.25,
};

export function normalizeText(s) {
  let out = String(s).replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, m => ' ' + UNICODE_FRACTIONS[m]);
  return out.replace(/⁄/g, '/').replace(/ /g, ' ').replace(/(\d)\s+(\d+\/\d+)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)`;

// Parses "1 1/2", "1/6", "0.25", "2,5" or a plain number. Returns NaN when it can't.
export function parseAmount(s) {
  s = normalizeText(s || '');
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) return m[2] > 0 ? m[1] / m[2] : NaN;
  m = s.match(/^\d+(?:[.,]\d+)?$/);
  if (m) return parseFloat(s.replace(',', '.'));
  return NaN;
}

// ---------- units ----------

// kind: mass (grams per unit), vol (ml per unit), count (one of the thing), pack (unknown size)
const UNIT_DEFS = [
  ['kg|kgs|kilo|kilos|kilogram|kilograms', 'mass', 1000],
  ['g|gm|gms|gr|gram|grams|gramme|grammes', 'mass', 1],
  ['mg', 'mass', 0.001],
  ['oz|ounce|ounces', 'mass', 28.35],
  ['lb|lbs|pound|pounds', 'mass', 453.6],
  ['ml|mls|millilitre|millilitres|milliliter|milliliters', 'vol', 1],
  ['l|litre|litres|liter|liters', 'vol', 1000],
  ['fl oz|fl\\. oz|fluid ounce|fluid ounces', 'vol', 29.6],
  ['cup|cups|c\\.', 'vol', 250],
  ['tbsp|tbsps|tbs|tbl|tblsp|tablespoon|tablespoons|tbsp\\.', 'vol', 'tbsp'],
  ['tsp|tsps|teaspoon|teaspoons|tsp\\.', 'vol', 5],
  ['dash|dashes|drizzle', 'vol', 1],
  ['splash|splashes', 'vol', 10],
  ['pinch|pinches', 'mass', 0.4],
  ['handful|handfuls', 'mass', 30],
  ['bunch|bunches', 'mass', 60],
  ['sprig|sprigs', 'mass', 1],
  ['can|cans|tin|tins', 'mass', 400],
  ['scoop|scoops|serve|serves|serving|servings', 'serving', 1],
  ['clove|cloves|slice|slices|piece|pieces|pcs|stalk|stalks|stick|sticks|head|heads|fillet|fillets|rasher|rashers|sheet|sheets|whole|leaf|leaves|cob|cobs|ball|balls|knob|thumb', 'count', 1],
  ['packet|packets|pkt|pkts|pack|packs|bag|bags|jar|jars|block|blocks|punnet|punnets|bottle|bottles|carton|cartons|tub|tubs', 'pack', null],
];

const UNIT_RES = UNIT_DEFS.map(([words, kind, factor]) => ({
  re: new RegExp(`^(${words})(?![a-z])\\.?\\s*`, 'i'),
  kind, factor,
}));

const SIZE_WORDS = /^(large|medium|small|big|heaped|heaping|level|generous|scant|rounded|good|extra large|x-large|jumbo|thin|thick|about|approx\.?|approximately|roughly|around)\s+/i;

function matchUnit(rest) {
  for (const u of UNIT_RES) {
    const m = rest.match(u.re);
    if (m) return { unit: m[1].toLowerCase().replace(/\.$/, ''), kind: u.kind, factor: u.factor, rest: rest.slice(m[0].length) };
  }
  return null;
}

// ---------- ingredient lines ----------

const PREP_WORDS = new Set(('fresh freshly chopped diced minced finely roughly coarsely thinly thickly sliced grated peeled ' +
  'crushed halved quartered trimmed drained rinsed cubed shredded torn cooked uncooked raw dried optional ' +
  'to taste serve serving for frying garnish extra plus more about approx approximately large medium small ' +
  'boneless skinless skin on room temperature softened melted cold warm hot packed lightly firmly ' +
  'of and or into cut pieces piece bite sized size inch cm mm the a an organic free range').split(' '));

export function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('oes')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

export function tokens(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ').replace(/-/g, ' ')
    .split(/\s+/).filter(Boolean).map(stem);
}

// Key used to remember which food the user picked for an ingredient name.
export function ingredientKey(name) {
  return tokens(name).filter(t => !PREP_WORDS.has(t) && !/^\d/.test(t)).join(' ');
}

export function parseIngredient(raw) {
  const line = normalizeText(raw).replace(/^[-–•*▢□☐✓✔·]+\s*/, '').trim();
  let rest = line;
  let qty = null, unit = '', kind = 'none', factor = null;

  let m = rest.match(new RegExp(`^(${NUM})(?:\\s*(?:-|–|—|to|or)\\s*(${NUM}))?\\s*`, 'i'));
  if (m) {
    const a = parseAmount(m[1]);
    const b = m[2] ? parseAmount(m[2]) : NaN;
    qty = isNaN(b) ? a : (a + b) / 2;
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|dozen|quarter)\s+(?:a\s+)?/i))) {
    qty = WORD_NUMBERS[m[1].toLowerCase()];
    rest = rest.slice(m[0].length);
  }

  // "2 x 400g cans" → 2 × 400 g
  let multiplier = 1;
  if (qty != null && (m = rest.match(new RegExp(`^x\\s*(${NUM})\\s*`, 'i')))) {
    multiplier = qty;
    qty = parseAmount(m[1]);
    rest = rest.slice(m[0].length);
  }

  if (qty != null) {
    while (SIZE_WORDS.test(rest)) rest = rest.replace(SIZE_WORDS, '');
    const u = matchUnit(rest);
    if (u) {
      ({ unit, kind, factor } = u);
      rest = u.rest;
      while (SIZE_WORDS.test(rest)) rest = rest.replace(SIZE_WORDS, '');
      // "1 can (400 g)" style sizes are handled below; a second unit like "1 large can" is caught here
      const u2 = kind === 'count' ? matchUnit(rest) : null;
      if (u2 && u2.kind !== 'count') { ({ unit, kind, factor } = u2); rest = u2.rest; }
    } else {
      kind = 'count';
    }
    qty *= multiplier;
  }
  rest = rest.replace(/^of\s+/i, '');

  // An explicit weight in brackets beats a vague unit: "1 can (400g) tomatoes", "2 fillets (about 300g)"
  const paren = line.match(/\((?:[^)]*?)(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b[^)]*\)/i);
  let explicitGrams = null;
  if (paren && kind !== 'mass' && kind !== 'vol') {
    const v = parseFloat(paren[1]) * (/^k|^l$/i.test(paren[2]) ? 1000 : 1);
    const each = /each|per/i.test(paren[0]) || kind === 'count' || kind === 'pack' || kind === 'mass';
    explicitGrams = v * (qty != null && each ? qty : 1);
  }
  // No leading amount but a weight elsewhere: "Chicken thighs - 500g"
  if (qty == null) {
    const w = line.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml)\b/i);
    if (w) explicitGrams = parseFloat(w[1]) * (/^k/i.test(w[2]) ? 1000 : 1);
  }

  const name = rest.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return { line, qty, unit, kind, factor, name, explicitGrams };
}

// Grams for a parsed line given the matched food. Returns null when the amount can't be worked out.
export function gramsFor(parsed, food, settings) {
  if (parsed.explicitGrams != null) return parsed.explicitGrams;
  if (parsed.qty == null) return 0;
  const d = food?.density || 1;
  switch (parsed.kind) {
    case 'mass': return parsed.qty * parsed.factor;
    case 'vol': return parsed.qty * (parsed.factor === 'tbsp' ? (settings.tbspMl || 20) : parsed.factor) * d;
    case 'count': return food?.each ? parsed.qty * food.each : null;
    case 'serving': return food?.each ? parsed.qty * food.each : null;
    default: return null;
  }
}

// ---------- matching ----------

const INDEX = [];
for (const f of FOODS) {
  for (const a of f.aliases) {
    const t = tokens(a);
    if (t.length) INDEX.push({ id: f.id, t, len: a.length });
  }
}

function containsSeq(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

// Best built-in match for an ingredient name, or null.
export function matchBuiltIn(name) {
  const hay = tokens(name);
  let best = null;
  for (const e of INDEX) {
    if (!containsSeq(hay, e.t)) continue;
    const score = e.t.length * 1000 + e.len;
    if (!best || score > best.score) best = { id: e.id, score };
  }
  return best ? { kind: 'db', id: best.id } : null;
}

// ---------- whole recipes ----------

const SECTION_END = /^(method|instructions?|directions?|steps?|preparation|prep|how to make|to make|notes?|tips?|nutrition|equipment)\b[:\s]*$/i;
const INGREDIENTS_HEAD = /^ingredients?\b[:\s]*$/i;
const META = /^(serves|servings?|yield|makes|prep time|cook time|total time|time|difficulty|course|cuisine|source|from|author|calories)\b/i;

export function parseRecipeText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => normalizeText(l)).filter(Boolean);
  let servings = null, url = null, title = '';
  for (const l of lines) {
    const s = l.match(/\b(?:serves|servings?|yield|makes)\b\s*:?\s*(\d+)/i) || l.match(/^(\d+)\s+(?:servings?|serves|portions?)\b/i);
    if (s && !servings) servings = parseInt(s[1], 10);
    const u = l.match(/https?:\/\/\S+/);
    if (u && !url) url = u[0];
  }

  const body = lines.filter(l => !/^https?:\/\/\S+$/.test(l));
  let start = body.findIndex(l => INGREDIENTS_HEAD.test(l));
  let picked;
  if (start >= 0) {
    title = body.slice(0, start).find(l => !META.test(l)) || '';
    picked = [];
    for (const l of body.slice(start + 1)) {
      if (SECTION_END.test(l)) break;
      picked.push(l);
    }
  } else {
    // No heading: first line is the title if it doesn't look like an ingredient.
    const looksLikeIngredient = l => /^[-–•*▢□☐\d]/.test(l) || /^(a|an|one|two|three|half)\s/i.test(l);
    let rest = body;
    if (rest.length > 1 && !looksLikeIngredient(rest[0])) { title = rest[0]; rest = rest.slice(1); }
    picked = [];
    for (const l of rest) {
      if (SECTION_END.test(l)) break;
      picked.push(l);
    }
  }

  const ingredients = picked
    .filter(l => !META.test(l))
    .filter(l => !(/:$/.test(l) && !/\d/.test(l)))   // sub-headings like "For the sauce:"
    .filter(l => !/^(\d+\.\s|step\s*\d)/i.test(l))    // numbered method steps that slipped in
    .filter(l => l.length < 160);

  return { title: title.replace(/^recipe:\s*/i, '').slice(0, 120), servings, url, ingredients };
}
