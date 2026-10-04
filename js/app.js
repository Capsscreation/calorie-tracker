import { FOODS, dbFood } from './foods.js';
import { parseIngredient, parseRecipeText, matchBuiltIn, gramsFor, ingredientKey, parseAmount, tokens } from './parse.js';
import { lookupBarcode, searchProducts } from './off.js';
import { startLiveScan, scanImageFile } from './scanner.js';
import { fileToThumb, cacheRemoteImage } from './images.js';
import { state, save, replaceState, uid } from './store.js';

const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const FRACTIONS = [[1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 8]];
const main = document.getElementById('main');
const sheet = document.getElementById('sheet');

const ui = {
  day: todayISO(),
  meal: mealForNow(),
  draftFood: null,     // product being created/edited in the food form
  formNote: '',
  shareText: '',
  addQuery: '',
  foodsQuery: '',
  portion: null,       // { recipeId, q, grams }
  pickIng: null,       // { recipeId, ingId } while choosing a match
  onSheetClose: null,
};

// ---------- small helpers ----------

function todayISO(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return todayISO(d);
}
function dayLabel(iso) {
  const t = todayISO();
  if (iso === t) return 'Today';
  if (iso === addDays(t, -1)) return 'Yesterday';
  if (iso === addDays(t, 1)) return 'Tomorrow';
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function mealForNow() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 11) return 'Breakfast';
  if (h < 15) return 'Lunch';
  if (h < 17) return 'Snacks';
  if (h < 21.5) return 'Dinner';
  return 'Snacks';
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r0 = n => Math.round(n || 0);
const r1 = n => { n = n || 0; return Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n); };
const kcalStr = n => r0(n).toLocaleString();
const ZERO = { kcal: 0, p: 0, c: 0, f: 0 };
const scale = (n, k) => ({ kcal: (n.kcal || 0) * k, p: (n.p || 0) * k, c: (n.c || 0) * k, f: (n.f || 0) * k });
const sumN = list => list.reduce((a, n) => ({ kcal: a.kcal + n.kcal, p: a.p + n.p, c: a.c + n.c, f: a.f + n.f }), { ...ZERO });
const macros = n => `<span class="m p">P ${r1(n.p)}g</span><span class="m c">C ${r1(n.c)}g</span><span class="m f">F ${r1(n.f)}g</span>`;
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isNaN(x) ? null : x; };

function fracLabel(q) {
  if (Math.abs(q - 1) < 0.001) return 'whole dish';
  for (let d = 1; d <= 12; d++) {
    const n = Math.round(q * d);
    if (n > 0 && Math.abs(q * d - n) < 0.01) return d === 1 ? `${n}× dish` : `${n}/${d} of dish`;
  }
  return `${Math.round(q * 100)}% of dish`;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function persist() {
  if (!save()) toast("Couldn't save. Is storage full or blocked?");
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- foods ----------

// One shape for built-in foods and the user's own products.
function foodLike(ref) {
  if (!ref) return null;
  if (ref.kind === 'db') {
    const f = dbFood(ref.id);
    return f && { kind: 'db', id: f.id, name: f.name, brand: '', per100: f.per100, density: f.density, each: f.each, unit: 'g', servingLabel: f.each ? 'each' : '' };
  }
  if (ref.kind === 'food') {
    const f = state.foods.find(x => x.id === ref.id);
    return f && { kind: 'food', id: f.id, name: f.name, brand: f.brand, per100: f.per100, density: 1, each: f.servingG || null, unit: f.unit || 'g', servingLabel: f.servingLabel || 'serve', image: f.image, barcode: f.barcode };
  }
  return null;
}

function searchFoods(q, limit = 40) {
  const qt = tokens(q);
  if (!qt.length) return [];
  const hit = hay => qt.every(t => hay.some(h => h.startsWith(t)));
  const out = [];
  for (const f of state.foods) {
    if (hit(tokens(`${f.name} ${f.brand || ''}`))) out.push({ kind: 'food', id: f.id });
  }
  const db = [];
  for (const f of FOODS) {
    const nameHit = hit(tokens(f.name));
    if (nameHit || hit(tokens(f.aliases.join(' ')))) db.push({ kind: 'db', id: f.id, rank: nameHit ? 0 : 1 });
  }
  db.sort((a, b) => a.rank - b.rank);
  return [...out, ...db].slice(0, limit);
}

// Small square photo, or a placeholder with an emoji / first letter.
function thumb(src, fallback, cls = 'sm') {
  if (src) return `<img class="thumb ${cls}" src="${esc(src)}" alt="" loading="lazy">`;
  const ch = /^\p{Extended_Pictographic}/u.test(fallback || '') ? fallback : (fallback || '?').trim().charAt(0).toUpperCase();
  return `<span class="thumb ${cls} ph" aria-hidden="true">${esc(ch)}</span>`;
}

function entryThumb(e) {
  if (e.ref?.kind === 'recipe') return thumb(getRecipe(e.ref.id)?.image, '🍲');
  if (e.ref) return thumb(foodLike(e.ref)?.image, e.name);
  return thumb(null, e.unit === 'item' ? '⚡' : e.name);
}

function setPhotoPreview(src) {
  const box = document.getElementById('photo-preview');
  if (box) box.innerHTML = thumb(src, '📷', 'big');
  const label = document.getElementById('photo-label');
  if (label) label.firstChild.textContent = src ? 'Change photo' : 'Add photo of pack';
  document.getElementById('photo-remove')?.toggleAttribute('hidden', !src);
}

function foodRow(ref, href, extraAttrs = '') {
  const f = foodLike(ref);
  if (!f) return '';
  const sub = [f.brand, f.kind === 'db' ? 'Generic' : f.barcode ? 'Scanned' : 'My food'].filter(Boolean).join(' · ');
  const tag = href ? `a href="${href}"` : `button type="button" ${extraAttrs}`;
  return `<${tag} class="row">
    ${thumb(f.image, f.name)}
    <div class="row-main"><b>${esc(f.name)}</b><small>${esc(sub)}</small></div>
    <div class="row-side">${kcalStr(f.per100.kcal)}<small>kcal/100${f.unit}</small></div>
  </${href ? 'a' : 'button'}>`;
}

function pushRecent(ref) {
  state.recent = [ref, ...state.recent.filter(r => !(r.kind === ref.kind && r.id === ref.id))].slice(0, 15);
}

// ---------- recipes ----------

function makeIngredient(line) {
  const parsed = parseIngredient(line);
  const key = ingredientKey(parsed.name);
  let ref = key && state.learned[key];
  if (ref && ref.kind !== 'ignore' && !foodLike(ref)) ref = null;
  ref ||= matchBuiltIn(parsed.name);
  const grams = ref?.kind === 'ignore' ? 0 : gramsFor(parsed, foodLike(ref), state.settings);
  return { id: uid(), line: parsed.line, parsed, ref: ref || null, grams, gramsEdited: false, custom: null };
}

function ingNutrition(ing) {
  if (!ing.ref || ing.ref.kind === 'ignore') return ZERO;
  if (ing.ref.kind === 'custom') return { ...ZERO, ...ing.custom };
  const f = foodLike(ing.ref);
  if (!f || ing.grams == null) return ZERO;
  return scale(f.per100, ing.grams / 100);
}

function ingStatus(ing) {
  if (!ing.ref) return 'nomatch';
  if (ing.ref.kind === 'ignore') return 'ignored';
  if (ing.ref.kind === 'custom') return 'ok';
  const f = foodLike(ing.ref);
  if (!f) return 'nomatch';
  if (f.per100.kcal === 0) return 'ok';
  if (ing.grams == null) return 'noamount';
  if (ing.grams === 0 && ing.parsed.qty == null && ing.parsed.explicitGrams == null) return 'unmeasured';
  return 'ok';
}

const recipeTotals = r => sumN(r.ingredients.map(ingNutrition));
const getRecipe = id => state.recipes.find(r => r.id === id);

function createRecipe(text, name, servings) {
  const parsed = parseRecipeText(text);
  return {
    id: uid(),
    name: name || parsed.title || 'Untitled recipe',
    servings: servings || parsed.servings || 4,
    cookedG: null,
    url: parsed.url,
    text,
    ingredients: parsed.ingredients.map(makeIngredient),
    created: Date.now(),
  };
}

// ---------- log ----------

function entryNutrition(e) { return scale(e.per, e.qty); }

function entryAmount(e) {
  switch (e.unit) {
    case 'dish': return fracLabel(e.qty);
    case 'serving': return `${r1(e.qty)} × ${e.unitLabel || 'serve'}`;
    case 'item': return '';
    default: return `${r1(e.qty)} ${e.unit}`;
  }
}

function addEntry(entry) {
  (state.log[ui.day] ||= []).push({ id: uid(), t: Date.now(), ...entry });
  persist();
  toast(`Added to ${entry.meal} · ${dayLabel(ui.day)}`);
  go('#/today');
}

const mealSelect = (id = 'meal') => `<select id="${id}" class="meal-select">${MEALS.map(m => `<option ${m === ui.meal ? 'selected' : ''}>${m}</option>`).join('')}</select>`;

// ---------- views ----------

function viewToday() {
  const entries = state.log[ui.day] || [];
  const tot = sumN(entries.map(entryNutrition));
  const s = state.settings;
  const left = s.goal - tot.kcal;
  const pct = Math.min(100, (tot.kcal / (s.goal || 1)) * 100);
  const macroGoal = (k, label) => {
    const g = s[k];
    const v = tot[k[0]];
    return `<div class="macro ${k[0]}"><div class="macro-top"><span>${label}</span><b>${r0(v)}${g ? `<small> / ${g}g</small>` : 'g'}</b></div>
      ${g ? `<div class="bar thin"><i style="width:${Math.min(100, (v / g) * 100)}%"></i></div>` : ''}</div>`;
  };
  return `
  <header class="top">
    <button class="icon-btn" data-act="day" data-d="-1" aria-label="Previous day">‹</button>
    <h1 class="grow center">${esc(dayLabel(ui.day))}</h1>
    <button class="icon-btn" data-act="day" data-d="1" aria-label="Next day">›</button>
    <a class="icon-btn" href="#/settings" aria-label="Settings">⚙</a>
  </header>
  <section class="card summary">
    <div class="summary-nums">
      <div><span class="big">${kcalStr(tot.kcal)}</span><small>eaten</small></div>
      <div class="right"><span class="big ${left < 0 ? 'over' : ''}">${kcalStr(Math.abs(left))}</span><small>${left < 0 ? 'over' : 'left'} of ${kcalStr(s.goal)}</small></div>
    </div>
    <div class="bar ${left < 0 ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    <div class="macros">${macroGoal('protein', 'Protein')}${macroGoal('carbs', 'Carbs')}${macroGoal('fat', 'Fat')}</div>
  </section>
  ${MEALS.map(meal => {
    const items = entries.filter(e => e.meal === meal);
    const mt = sumN(items.map(entryNutrition));
    return `<section class="card meal">
      <div class="meal-head"><h2>${meal}</h2><span class="muted">${items.length ? `${kcalStr(mt.kcal)} kcal` : ''}</span>
        <button class="link" data-act="add-to-meal" data-meal="${meal}">+ Add</button></div>
      ${items.map(e => {
        const n = entryNutrition(e);
        return `<button class="row" data-act="edit-entry" data-id="${e.id}">
          ${entryThumb(e)}
          <div class="row-main"><b>${esc(e.name)}</b><small>${esc(entryAmount(e))}</small></div>
          <div class="row-side">${kcalStr(n.kcal)}<small>kcal</small></div></button>`;
      }).join('')}
    </section>`;
  }).join('')}
  <button class="btn ghost wide" data-act="quick-add">⚡ Quick add calories</button>`;
}

function viewAdd() {
  return `
  <header class="top"><h1 class="grow">Add food</h1><span class="muted">${esc(dayLabel(ui.day))}</span></header>
  <div class="chips">${MEALS.map(m => `<button class="chip ${m === ui.meal ? 'on' : ''}" data-act="set-meal" data-meal="${m}">${m}</button>`).join('')}</div>
  <div class="tiles">
    <button class="tile" data-act="scan-live"><span class="ti">📷</span>Scan barcode</button>
    <label class="tile"><span class="ti">🖼️</span>Photo of barcode<input type="file" accept="image/*" capture="environment" data-change="barcode-photo" hidden></label>
    <button class="tile" data-act="enter-barcode"><span class="ti">🔢</span>Type barcode</button>
    <button class="tile" data-act="new-food"><span class="ti">🏷️</span>From the label</button>
    <a class="tile" href="#/recipes"><span class="ti">🍲</span>Recipe portion</a>
    <button class="tile" data-act="quick-add"><span class="ti">⚡</span>Quick calories</button>
  </div>
  <input class="search" type="search" placeholder="Search my foods, recipes, ingredients…" data-input="add-search" value="${esc(ui.addQuery)}" autocomplete="off">
  <div id="add-results">${addResults()}</div>`;
}

function addResults() {
  const q = ui.addQuery.trim();
  if (!q) {
    const rows = state.recent.map(ref => ref.kind === 'recipe' ? recipeRow(getRecipe(ref.id)) : foodRow(ref, `#/log/${ref.kind}/${ref.id}`)).join('');
    return rows ? `<h3 class="section">Recent</h3><div class="list">${rows}</div>`
      : `<p class="hint">Scan a pack's barcode, or search generic foods like “banana” or “egg”.</p>`;
  }
  const qt = tokens(q);
  const recipes = state.recipes.filter(r => qt.every(t => tokens(r.name).some(h => h.startsWith(t))));
  const foods = searchFoods(q);
  if (!recipes.length && !foods.length) return `<p class="hint">Nothing found for “${esc(q)}”.</p>`;
  return `<div class="list">${recipes.map(recipeRow).join('')}${foods.map(ref => foodRow(ref, `#/log/${ref.kind}/${ref.id}`)).join('')}</div>`;
}

function recipeRow(r) {
  if (!r) return '';
  const t = recipeTotals(r);
  return `<a class="row" href="#/recipe/${r.id}">
    ${thumb(r.image, '🍲')}
    <div class="row-main"><b>${esc(r.name)}</b><small>Serves ${r.servings} · ${kcalStr(t.kcal)} kcal whole dish</small></div>
    <div class="row-side">${kcalStr(t.kcal / r.servings)}<small>kcal/serve</small></div></a>`;
}

function viewLog(kind, id) {
  const f = foodLike({ kind, id });
  if (!f) return notFound('That food no longer exists.');
  const hasServing = !!f.each;
  const unit = hasServing ? 'serving' : f.unit;
  const servingName = f.kind === 'db' ? `each (${r0(f.each)} g)` : `${f.servingLabel || 'serve'} (${r1(f.each)} ${f.unit})`;
  return `
  <header class="top"><button class="icon-btn" data-act="back" aria-label="Back">‹</button><h1 class="grow">Log food</h1></header>
  <section class="card">
    <div class="food-head">
      ${thumb(f.image, f.name, 'md')}
      <div><h2>${esc(f.name)}</h2><small class="muted">${esc(f.brand || (f.kind === 'db' ? 'Generic food, typical values' : ''))}</small></div>
    </div>
    <p class="per">Per 100${f.unit}: <b>${kcalStr(f.per100.kcal)} kcal</b> ${macros(f.per100)}</p>
  </section>
  <section class="card">
    <label class="field-label">How much?</label>
    <div class="amount">
      <input id="amt" type="text" inputmode="decimal" value="${hasServing ? 1 : 100}" data-input="log-preview">
      <select id="amt-unit" data-change="log-preview">
        <option value="${f.unit}" ${unit === f.unit ? 'selected' : ''}>${f.unit}</option>
        ${hasServing ? `<option value="serving" selected>${esc(servingName)}</option>` : ''}
      </select>
    </div>
    <label class="field-label">Meal</label>
    ${mealSelect()}
    <div id="log-preview" class="preview"></div>
    <button class="btn wide" data-act="log-food" data-kind="${kind}" data-id="${id}">Add to ${esc(dayLabel(ui.day))}</button>
  </section>
  ${kind === 'food' ? `<div class="row-actions"><button class="btn ghost" data-act="edit-food" data-id="${id}">Edit food</button><button class="btn ghost danger" data-act="delete-food" data-id="${id}">Delete food</button></div>` : ''}`;
}

function logAmount(kind, id) {
  const f = foodLike({ kind, id });
  const qty = parseAmount(document.getElementById('amt')?.value);
  const unit = document.getElementById('amt-unit')?.value;
  if (!f || !(qty > 0)) return null;
  if (unit === 'serving') {
    return { qty, unit: 'serving', unitLabel: f.kind === 'db' ? `${r0(f.each)} g` : `${f.servingLabel || 'serve'} (${r1(f.each)} ${f.unit})`, per: scale(f.per100, f.each / 100) };
  }
  return { qty, unit: f.unit, per: scale(f.per100, 1 / 100) };
}

function updateLogPreview() {
  const [, , kind, id] = location.hash.split('/');
  const a = logAmount(kind, id);
  const el = document.getElementById('log-preview');
  if (el) el.innerHTML = a ? `<b>${kcalStr(a.per.kcal * a.qty)} kcal</b> ${macros(scale(a.per, a.qty))}` : '<span class="muted">Enter an amount</span>';
}

function viewFoodForm() {
  const d = (ui.draftFood ||= { per100: {} });
  const v = x => (x == null ? '' : r1(x));
  return `
  <header class="top"><button class="icon-btn" data-act="back" aria-label="Back">‹</button><h1 class="grow">${d.id ? 'Edit food' : 'New food'}</h1></header>
  ${ui.formNote ? `<p class="note">${esc(ui.formNote)}</p>` : ''}
  <form id="food-form" class="card form" autocomplete="off">
    <div class="photo-pick">
      <span id="photo-preview">${thumb(d.image, '📷', 'big')}</span>
      <div class="photo-btns">
        <label class="btn ghost" id="photo-label">${d.image ? 'Change photo' : 'Add photo of pack'}<input type="file" accept="image/*" capture="environment" data-change="food-photo" hidden></label>
        <button class="btn ghost danger" type="button" id="photo-remove" data-act="remove-photo" ${d.image ? '' : 'hidden'}>Remove photo</button>
      </div>
    </div>
    <label>Name<input name="name" required value="${esc(d.name || '')}" placeholder="e.g. Collagen Co Original"></label>
    <label>Brand<input name="brand" value="${esc(d.brand || '')}"></label>
    <label>Barcode<input name="barcode" inputmode="numeric" value="${esc(d.barcode || '')}"></label>
    <fieldset class="seg-field">
      <legend>The numbers below are per</legend>
      <label class="seg"><input type="radio" name="basis" value="100" checked><span>100 g / ml</span></label>
      <label class="seg"><input type="radio" name="basis" value="serving"><span>serving</span></label>
    </fieldset>
    <div class="grid2">
      <label>Energy<input name="energy" inputmode="decimal" value="${v(d.per100.kcal)}" required></label>
      <label>Unit<select name="energyUnit"><option value="kcal">kcal (Cal)</option><option value="kj">kJ</option></select></label>
      <label>Protein (g)<input name="p" inputmode="decimal" value="${v(d.per100.p)}"></label>
      <label>Carbs (g)<input name="c" inputmode="decimal" value="${v(d.per100.c)}"></label>
      <label>Fat (g)<input name="f" inputmode="decimal" value="${v(d.per100.f)}"></label>
      <label>Measured in<select name="unit"><option value="g" ${d.unit !== 'ml' ? 'selected' : ''}>grams</option><option value="ml" ${d.unit === 'ml' ? 'selected' : ''}>ml</option></select></label>
      <label>Serving size<input name="servingG" inputmode="decimal" value="${v(d.servingG)}" placeholder="g or ml"></label>
      <label>Serving name<input name="servingLabel" value="${esc(d.servingLabel || '')}" placeholder="e.g. scoop, bar"></label>
    </div>
    <p class="hint">Australian labels list energy in kJ: pick kJ and copy the number from the “per 100 g” column.</p>
    <button class="btn wide" type="button" data-act="save-food">Save and log</button>
  </form>`;
}

function viewRecipes() {
  return `
  <header class="top"><h1 class="grow">Recipes</h1></header>
  <a class="btn wide" href="#/recipe-new">＋ Add a Stashcook recipe</a>
  ${state.recipes.length ? `<div class="list">${state.recipes.map(recipeRow).join('')}</div>`
    : `<p class="hint">Copy a recipe out of Stashcook and paste it here. I'll work out the calories for the whole dish so you can log ⅙ (or any share) of it.</p>`}`;
}

function viewRecipeNew() {
  return `
  <header class="top"><button class="icon-btn" data-act="back" aria-label="Back">‹</button><h1 class="grow">New recipe</h1></header>
  ${/^\S*https?:\/\/\S+$/.test(ui.shareText.trim()) ? `<p class="note warn">Stashcook shared only a link, and the app can't read the recipe from a link. In Stashcook, copy the ingredient list and paste it here instead.</p>` : ''}
  <section class="card form">
    <ol class="steps">
      <li>In Stashcook, open the recipe and tap <b>Share</b> → <b>Copy</b>. Or select the ingredient list and copy it.</li>
      <li>Paste it below. Only the ingredients are used; the method is ignored.</li>
    </ol>
    <textarea id="recipe-text" rows="12" placeholder="Chicken Tikka Masala&#10;Serves 6&#10;&#10;Ingredients&#10;800g chicken thigh fillets&#10;1 cup Greek yoghurt&#10;2 tbsp olive oil&#10;…">${esc(ui.shareText)}</textarea>
    <button class="btn ghost" data-act="paste">📋 Paste from clipboard</button>
    <div class="grid2">
      <label>Name (optional)<input id="recipe-name" placeholder="Taken from the first line"></label>
      <label>Serves<input id="recipe-serves" inputmode="numeric" placeholder="Auto"></label>
    </div>
    <button class="btn wide" data-act="create-recipe">Work out calories</button>
  </section>`;
}

function viewRecipe(id) {
  const r = getRecipe(id);
  if (!r) return notFound('That recipe no longer exists.');
  const t = recipeTotals(r);
  if (!ui.portion || ui.portion.recipeId !== id) ui.portion = { recipeId: id, q: 1 / r.servings, grams: null, custom: '' };
  const p = ui.portion;
  const issues = r.ingredients.filter(i => ['nomatch', 'noamount'].includes(ingStatus(i))).length;
  const fractions = [...FRACTIONS];
  if (!fractions.some(([n, d]) => n / d === 1 / r.servings) && r.servings > 1 && r.servings <= 12) fractions.push([1, r.servings]);
  fractions.sort((a, b) => b[0] / b[1] - a[0] / a[1]);

  return `
  <header class="top"><button class="icon-btn" data-act="back" aria-label="Back">‹</button><h1 class="grow">${esc(r.name)}</h1></header>
  ${issues ? `<p class="note warn">${issues} ingredient${issues > 1 ? 's need' : ' needs'} checking. ${issues > 1 ? "They're" : "It's"} highlighted below and not counted yet.</p>` : ''}
  <section class="card summary">
    ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="">` : ''}
    <div class="summary-nums">
      <div><span class="big">${kcalStr(t.kcal)}</span><small>kcal whole dish</small></div>
      <div class="right"><span class="big">${kcalStr(t.kcal / r.servings)}</span><small>per serve (÷${r.servings})</small></div>
    </div>
    <div class="per">${macros(t)}</div>
  </section>

  <section class="card">
    <h2>How much did you have?</h2>
    <div class="chips">
      ${fractions.map(([n, d]) => `<button class="chip ${!p.grams && !p.custom && Math.abs(p.q - n / d) < 1e-6 ? 'on' : ''}" data-act="portion" data-q="${n / d}">${n}/${d}</button>`).join('')}
      <button class="chip ${!p.grams && !p.custom && p.q === 1 ? 'on' : ''}" data-act="portion" data-q="1">All</button>
    </div>
    <div class="grid2">
      <label>Other share<input id="portion-custom" placeholder="e.g. 2/6 or 0.3" value="${esc(p.custom)}" data-input="portion-custom"></label>
      ${r.cookedG ? `<label>Or grams eaten<input id="portion-grams" inputmode="decimal" placeholder="of ${r0(r.cookedG)} g" value="${p.grams ?? ''}" data-input="portion-grams"></label>` : ''}
    </div>
    <label class="field-label">Meal</label>
    ${mealSelect()}
    <div id="portion-preview" class="preview">${portionPreview(r)}</div>
    <button class="btn wide" data-act="log-recipe" data-id="${r.id}">Add to ${esc(dayLabel(ui.day))}</button>
  </section>

  <section class="card">
    <h2>Ingredients</h2>
    <p class="hint">Tap a food to change the match. Fix any weight by typing grams.</p>
    <div class="ings">${r.ingredients.map(i => ingRow(r, i)).join('')}</div>
  </section>

  <section class="card form">
    <h2>Details</h2>
    <label>Name<input value="${esc(r.name)}" data-change="recipe-field" data-field="name"></label>
    <div class="grid2">
      <label>Serves<input inputmode="numeric" value="${r.servings}" data-change="recipe-field" data-field="servings"></label>
      <label>Cooked weight (g)<input inputmode="decimal" value="${r.cookedG ?? ''}" placeholder="optional" data-change="recipe-field" data-field="cookedG"></label>
    </div>
    <p class="hint">Weigh the finished dish (minus the pot) to log by grams eaten.</p>
    <div class="row-actions">
      <label class="btn ghost">${r.image ? 'Change photo' : '📷 Add photo of dish'}<input type="file" accept="image/*" capture="environment" data-change="recipe-photo" data-id="${r.id}" hidden></label>
      ${r.image ? `<button class="btn ghost danger" data-act="remove-recipe-photo" data-id="${r.id}">Remove photo</button>` : ''}
    </div>
    ${r.url ? `<p class="hint">Source: <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></p>` : ''}
    <div class="row-actions"><button class="btn ghost" data-act="edit-recipe-text" data-id="${r.id}">Edit pasted text</button>
    <button class="btn ghost danger" data-act="delete-recipe" data-id="${r.id}">Delete recipe</button></div>
  </section>`;
}

function ingRow(r, ing) {
  const st = ingStatus(ing);
  const n = ingNutrition(ing);
  const f = foodLike(ing.ref);
  let chip;
  if (st === 'ignored') chip = 'Not counted';
  else if (ing.ref?.kind === 'custom') chip = 'Entered manually';
  else chip = f ? f.name : 'Choose food…';
  const note = {
    nomatch: 'No match found. Tap to choose a food.',
    noamount: 'Unknown weight. Type the grams.',
    unmeasured: 'No amount given, so it counts as 0 g. Type grams if you used some.',
  }[st];
  const showGrams = ing.ref?.kind !== 'custom' && st !== 'ignored';
  return `<div class="ing ${st}">
    <div class="ing-line">${esc(ing.line)}</div>
    <div class="ing-row">
      <button class="chip match" data-act="pick-match" data-recipe="${r.id}" data-ing="${ing.id}">${esc(chip)} ▾</button>
      ${showGrams ? `<label class="grams"><input inputmode="decimal" value="${ing.grams == null ? '' : r1(ing.grams)}" data-change="ing-grams" data-recipe="${r.id}" data-ing="${ing.id}" aria-label="grams"><span>g</span></label>` : '<span class="grow"></span>'}
      <span class="ing-kcal">${kcalStr(n.kcal)}</span>
    </div>
    ${note ? `<div class="ing-note">${note}</div>` : ''}
  </div>`;
}

function portionFor(r) {
  const p = ui.portion;
  const t = recipeTotals(r);
  if (p.grams && r.cookedG) return { qty: p.grams, unit: 'g', per: scale(t, 1 / r.cookedG) };
  if (!(p.q > 0)) return null;
  return { qty: p.q, unit: 'dish', per: t };
}

function portionPreview(r) {
  const a = portionFor(r);
  if (!a) return '<span class="muted">Enter a share like 1/6</span>';
  const n = scale(a.per, a.qty);
  const label = a.unit === 'g' ? `${r1(a.qty)} g` : fracLabel(a.qty);
  return `${esc(label)}: <b>${kcalStr(n.kcal)} kcal</b> ${macros(n)}`;
}

function viewFoods() {
  const q = ui.foodsQuery.trim();
  const list = q ? searchFoods(q).filter(r => r.kind === 'food') : state.foods.map(f => ({ kind: 'food', id: f.id }));
  return `
  <header class="top"><h1 class="grow">My foods</h1></header>
  <div class="row-actions"><button class="btn" data-act="scan-live">📷 Scan</button><button class="btn ghost" data-act="new-food">＋ From label</button></div>
  <input class="search" type="search" placeholder="Search my foods…" data-input="foods-search" value="${esc(ui.foodsQuery)}">
  <div class="list" id="foods-list">${list.map(ref => foodRow(ref, `#/log/food/${ref.id}`)).join('') || '<p class="hint">Foods you scan or enter from a label are saved here.</p>'}</div>`;
}

function viewSettings() {
  const s = state.settings;
  return `
  <header class="top"><button class="icon-btn" data-act="back" aria-label="Back">‹</button><h1 class="grow">Settings</h1></header>
  <section class="card form">
    <h2>Daily goals</h2>
    <label>Calories (kcal)<input inputmode="numeric" value="${s.goal}" data-change="setting" data-key="goal"></label>
    <div class="grid3">
      <label>Protein g<input inputmode="numeric" value="${s.protein || ''}" placeholder="—" data-change="setting" data-key="protein"></label>
      <label>Carbs g<input inputmode="numeric" value="${s.carbs || ''}" placeholder="—" data-change="setting" data-key="carbs"></label>
      <label>Fat g<input inputmode="numeric" value="${s.fat || ''}" placeholder="—" data-change="setting" data-key="fat"></label>
    </div>
  </section>
  <section class="card form">
    <h2>Recipes</h2>
    <label>Tablespoon size<select data-change="setting" data-key="tbspMl">
      <option value="20" ${s.tbspMl == 20 ? 'selected' : ''}>20 ml (Australian)</option>
      <option value="15" ${s.tbspMl == 15 ? 'selected' : ''}>15 ml (US / UK / NZ)</option></select></label>
    <p class="hint">Applies to recipes you add from now on.</p>
  </section>
  <section class="card form">
    <h2>Your data</h2>
    <p class="hint">Everything is stored on this device only. Export a backup now and then.</p>
    <div class="row-actions">
      <button class="btn ghost" data-act="export">Export backup</button>
      <label class="btn ghost">Import backup<input type="file" accept="application/json,.json" data-change="import" hidden></label>
    </div>
    <button class="btn ghost danger" data-act="wipe">Delete all data</button>
  </section>
  <p class="hint center">Product data from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a> (ODbL).</p>`;
}

function notFound(msg) {
  return `<header class="top"><button class="icon-btn" data-act="back">‹</button><h1 class="grow">Not found</h1></header><p class="hint">${esc(msg)}</p>`;
}

// ---------- routing ----------

function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [route, a, b] = parts;
  let html;
  switch (route) {
    case '': case 'today': html = viewToday(); break;
    case 'add': html = viewAdd(); break;
    case 'log': html = viewLog(a, b); break;
    case 'food-form': html = viewFoodForm(); break;
    case 'recipes': html = viewRecipes(); break;
    case 'recipe-new': html = viewRecipeNew(); break;
    case 'recipe': html = viewRecipe(a); break;
    case 'foods': html = viewFoods(); break;
    case 'settings': html = viewSettings(); break;
    default: html = viewToday();
  }
  main.innerHTML = html;
  const tab = { '': 'today', today: 'today', settings: 'today', add: 'add', log: 'add', 'food-form': 'add', recipes: 'recipes', 'recipe-new': 'recipes', recipe: 'recipes', foods: 'foods' }[route] || 'today';
  document.querySelectorAll('nav.tabs a').forEach(el => el.toggleAttribute('aria-current', el.dataset.tab === tab));
  if (route === 'log') updateLogPreview();
}

let lastRoute = '';
window.addEventListener('hashchange', () => {
  const route = location.hash.split('/')[1] || '';
  if (route !== lastRoute) window.scrollTo(0, 0);
  lastRoute = route;
  render();
});

// ---------- sheets (modal dialogs) ----------

function openSheet(html, onClose) {
  sheet.innerHTML = `<div class="sheet-body">${html}</div>`;
  ui.onSheetClose = onClose || null;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('close', () => {
  const fn = ui.onSheetClose;
  ui.onSheetClose = null;
  fn?.();
});
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function editEntrySheet(id) {
  const entries = state.log[ui.day] || [];
  const e = entries.find(x => x.id === id);
  if (!e) return;
  const qtyVal = e.unit === 'dish' ? (fracLabel(e.qty).match(/^(\d+\/\d+)/)?.[1] ?? r1(e.qty)) : r1(e.qty);
  const unitText = { dish: 'of the dish (e.g. 1/6)', serving: `× ${e.unitLabel || 'serve'}`, item: '× item' }[e.unit] || e.unit;
  openSheet(`
    <h2>${esc(e.name)}</h2>
    <div class="form">
      <label>Amount<div class="amount"><input id="edit-qty" inputmode="decimal" value="${esc(qtyVal)}"><span class="unit">${esc(unitText)}</span></div></label>
      <label>Meal<select id="edit-meal">${MEALS.map(m => `<option ${m === e.meal ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    </div>
    <div class="row-actions">
      <button class="btn" data-act="save-entry" data-id="${id}">Save</button>
      <button class="btn ghost" data-act="close-sheet">Cancel</button>
      <button class="btn ghost danger" data-act="delete-entry" data-id="${id}">Delete</button>
    </div>`);
}

function quickAddSheet() {
  openSheet(`
    <h2>Quick add</h2>
    <div class="form">
      <label>What was it?<input id="qa-name" placeholder="e.g. Coffee with milk"></label>
      <label>Calories (kcal)<input id="qa-kcal" inputmode="decimal"></label>
      <div class="grid3">
        <label>Protein g<input id="qa-p" inputmode="decimal"></label>
        <label>Carbs g<input id="qa-c" inputmode="decimal"></label>
        <label>Fat g<input id="qa-f" inputmode="decimal"></label>
      </div>
      <label>Meal${mealSelect('qa-meal')}</label>
    </div>
    <div class="row-actions"><button class="btn" data-act="save-quick">Add</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
  setTimeout(() => document.getElementById('qa-name')?.focus(), 50);
}

function barcodeSheet() {
  openSheet(`
    <h2>Type a barcode</h2>
    <div class="form"><label>The digits under the barcode<input id="bc-input" inputmode="numeric" autocomplete="off"></label></div>
    <div class="row-actions"><button class="btn" data-act="lookup-barcode">Look up</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
  setTimeout(() => document.getElementById('bc-input')?.focus(), 50);
}

async function liveScanSheet() {
  let stop = null;
  let cancelled = false;
  openSheet(`
    <h2>Scan barcode</h2>
    <div id="reader" class="reader"></div>
    <p class="hint center">Hold the barcode flat in the box.</p>
    <button class="btn ghost wide" data-act="close-sheet">Cancel</button>`, () => { cancelled = true; stop?.(); });
  try {
    stop = await startLiveScan('reader', code => { closeSheet(); handleBarcode(code); });
    if (cancelled) stop();
  } catch (err) {
    if (cancelled) return;
    const msg = /Permission|NotAllowed/i.test(String(err)) ? 'Camera access was blocked. Allow the camera for this site, or use “Photo of barcode”.'
      : /secure|https/i.test(String(err)) ? 'The camera only works over HTTPS. Open the installed app instead.'
        : (err?.message || String(err));
    const reader = document.getElementById('reader');
    if (reader) reader.outerHTML = `<p class="note warn">${esc(msg)}</p>`;
  }
}

// `photo` is the picture the barcode was read from, if any. It becomes the product
// photo when Open Food Facts doesn't have one.
async function handleBarcode(raw, photo = null) {
  const code = String(raw).replace(/\D/g, '');
  if (code.length < 6) { toast("That doesn't look like a barcode"); return; }
  const ownThumb = async () => { try { return photo ? await fileToThumb(photo) : ''; } catch { return ''; } };
  const mine = state.foods.find(f => f.barcode === code);
  if (mine) {
    if (!mine.image && photo) { mine.image = await ownThumb(); persist(); }
    go(`#/log/food/${mine.id}`);
    return;
  }
  openSheet(`<div class="loading"><div class="spinner"></div><p>Looking up ${esc(code)}…</p></div>`);
  try {
    const product = await lookupBarcode(code);
    const own = product?.image ? '' : await ownThumb();
    closeSheet();
    if (product && !product.image) product.image = own;
    if (product && product.per100.kcal != null) {
      ui.draftFood = product;
      ui.formNote = 'Found on Open Food Facts. Check the numbers against the pack, then save.';
    } else if (product) {
      ui.draftFood = { ...product, per100: {} };
      ui.formNote = "Found the product, but it has no nutrition info. Enter it from the panel on the pack.";
    } else {
      ui.draftFood = { barcode: code, per100: {}, image: own };
      ui.formNote = "This one isn't in Open Food Facts yet. Copy the per-100 g column from the nutrition panel. You only need to do this once, because the next scan finds it in My foods.";
    }
    go('#/food-form');
  } catch (err) {
    closeSheet();
    toast(err.message);
  }
}

function pickMatchSheet(recipeId, ingId) {
  const r = getRecipe(recipeId);
  const ing = r?.ingredients.find(i => i.id === ingId);
  if (!ing) return;
  ui.pickIng = { recipeId, ingId };
  const q = ingredientKey(ing.parsed.name) || ing.parsed.name;
  openSheet(`
    <h2>Match ingredient</h2>
    <p class="ing-line">${esc(ing.line)}</p>
    <input id="pick-q" class="search" type="search" value="${esc(q)}" data-input="pick-search" autocomplete="off">
    <div id="pick-results" class="list scroll">${pickResults(q)}</div>
    <div class="row-actions wrap">
      <button class="btn ghost" data-act="pick-off">Search Open Food Facts</button>
      <button class="btn ghost" data-act="pick-custom">Enter calories myself</button>
      <button class="btn ghost" data-act="pick-ignore">Don't count</button>
    </div>`, () => { ui.pickIng = null; });
}

function pickResults(q) {
  let refs = searchFoods(q, 30);
  if (!refs.length) {
    // Loosen the search: any single word.
    const seen = new Set();
    for (const t of tokens(q)) for (const ref of searchFoods(t, 10)) {
      const k = ref.kind + ref.id;
      if (!seen.has(k)) { seen.add(k); refs.push(ref); }
    }
  }
  return refs.map(ref => foodRow(ref, null, `data-act="choose-match" data-kind="${ref.kind}" data-id="${ref.id}"`)).join('')
    || '<p class="hint">No matches. Try a simpler word, or search Open Food Facts.</p>';
}

function applyMatch(ref, custom) {
  const { recipeId, ingId } = ui.pickIng || {};
  const r = getRecipe(recipeId);
  const ing = r?.ingredients.find(i => i.id === ingId);
  if (!ing) return;
  ing.ref = ref;
  ing.custom = custom || null;
  if (ref.kind === 'ignore') ing.grams = 0;
  else if (!ing.gramsEdited && ref.kind !== 'custom') ing.grams = gramsFor(ing.parsed, foodLike(ref), state.settings);
  const key = ingredientKey(ing.parsed.name);
  if (key && ref.kind !== 'custom') state.learned[key] = ref;
  persist();
  closeSheet();
  render();
}

// Swap a remote Open Food Facts photo for a small local copy, in the background.
async function keepLocalCopy(food) {
  if (!/^https?:/.test(food.image || '')) return;
  const local = await cacheRemoteImage(food.image);
  if (local === food.image) return;
  const current = state.foods.find(f => f.id === food.id);
  if (current && current.image === food.image) {
    current.image = local;
    persist();
  }
}

async function photoFromInput(el) {
  const file = el.files?.[0];
  el.value = '';
  if (!file) return null;
  try {
    return await fileToThumb(file);
  } catch {
    toast("Couldn't read that photo");
    return null;
  }
}

// ---------- actions ----------

const actions = {
  day: el => { ui.day = addDays(ui.day, +el.dataset.d); render(); },
  back: () => (history.length > 1 ? history.back() : go('#/today')),
  'close-sheet': closeSheet,
  'add-to-meal': el => { ui.meal = el.dataset.meal; go('#/add'); },
  'set-meal': el => { ui.meal = el.dataset.meal; render(); },
  'quick-add': quickAddSheet,
  'save-quick': () => {
    const kcal = num(document.getElementById('qa-kcal').value);
    if (kcal == null) { toast('Enter the calories'); return; }
    ui.meal = document.getElementById('qa-meal').value;
    const per = { kcal, p: num(document.getElementById('qa-p').value) || 0, c: num(document.getElementById('qa-c').value) || 0, f: num(document.getElementById('qa-f').value) || 0 };
    closeSheet();
    addEntry({ meal: ui.meal, name: document.getElementById('qa-name').value.trim() || 'Quick add', qty: 1, unit: 'item', per });
  },
  'edit-entry': el => editEntrySheet(el.dataset.id),
  'save-entry': el => {
    const e = (state.log[ui.day] || []).find(x => x.id === el.dataset.id);
    const q = parseAmount(document.getElementById('edit-qty').value);
    if (!e || !(q > 0)) { toast('Enter an amount like 1/6 or 150'); return; }
    e.qty = q;
    e.meal = document.getElementById('edit-meal').value;
    persist(); closeSheet(); render();
  },
  'delete-entry': el => {
    state.log[ui.day] = (state.log[ui.day] || []).filter(x => x.id !== el.dataset.id);
    persist(); closeSheet(); render(); toast('Deleted');
  },
  'scan-live': liveScanSheet,
  'enter-barcode': barcodeSheet,
  'lookup-barcode': () => { const v = document.getElementById('bc-input').value; closeSheet(); handleBarcode(v); },
  'new-food': () => { ui.draftFood = { per100: {} }; ui.formNote = ''; go('#/food-form'); },
  'edit-food': el => {
    const f = state.foods.find(x => x.id === el.dataset.id);
    if (!f) return;
    ui.draftFood = JSON.parse(JSON.stringify(f));
    ui.formNote = '';
    go('#/food-form');
  },
  'delete-food': el => {
    if (!confirm('Delete this food? Entries already logged stay as they are.')) return;
    state.foods = state.foods.filter(f => f.id !== el.dataset.id);
    state.recent = state.recent.filter(r => r.id !== el.dataset.id);
    persist(); go('#/foods');
  },
  'save-food': () => {
    const form = document.getElementById('food-form');
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    let energy = num(fd.get('energy'));
    if (!name) { toast('Give it a name'); return; }
    if (energy == null) { toast('Enter the energy from the label'); return; }
    if (fd.get('energyUnit') === 'kj') energy /= 4.184;
    const servingG = num(fd.get('servingG'));
    let k = 1;
    if (fd.get('basis') === 'serving') {
      if (!servingG) { toast('Enter the serving size so per-serving numbers can be converted'); return; }
      k = 100 / servingG;
    }
    const d = ui.draftFood || {};
    const food = {
      id: d.id || uid(),
      name,
      brand: String(fd.get('brand') || '').trim(),
      barcode: String(fd.get('barcode') || '').replace(/\D/g, ''),
      unit: fd.get('unit') === 'ml' ? 'ml' : 'g',
      per100: { kcal: energy * k, p: (num(fd.get('p')) || 0) * k, c: (num(fd.get('c')) || 0) * k, f: (num(fd.get('f')) || 0) * k },
      servingG: servingG || null,
      servingLabel: String(fd.get('servingLabel') || '').trim(),
      image: d.image || '',
      source: d.source || 'manual',
      created: d.created || Date.now(),
    };
    const i = state.foods.findIndex(f => f.id === food.id);
    if (i >= 0) state.foods[i] = food; else state.foods.unshift(food);
    persist();
    keepLocalCopy(food);
    ui.draftFood = null;
    // Replace the form in history so Back doesn't return to it.
    location.replace(`#/log/food/${food.id}`);
  },
  'remove-photo': () => {
    if (ui.draftFood) ui.draftFood.image = '';
    setPhotoPreview('');
  },
  'remove-recipe-photo': el => {
    const r = getRecipe(el.dataset.id);
    if (!r) return;
    r.image = '';
    persist(); render();
  },
  'log-food': el => {
    const { kind, id } = el.dataset;
    const a = logAmount(kind, id);
    if (!a) { toast('Enter an amount'); return; }
    const f = foodLike({ kind, id });
    ui.meal = document.getElementById('meal').value;
    pushRecent({ kind, id });
    const withBrand = f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase());
    addEntry({ meal: ui.meal, name: withBrand ? `${f.name} (${f.brand})` : f.name, ref: { kind, id }, ...a });
  },
  paste: async () => {
    try {
      const text = await navigator.clipboard.readText();
      document.getElementById('recipe-text').value = text;
    } catch {
      toast('Clipboard blocked. Long-press the box and choose Paste.');
    }
  },
  'create-recipe': () => {
    const text = document.getElementById('recipe-text').value;
    if (!text.trim()) { toast('Paste a recipe first'); return; }
    const r = createRecipe(text, document.getElementById('recipe-name').value.trim(), parseInt(document.getElementById('recipe-serves').value, 10) || null);
    if (!r.ingredients.length) { toast("Couldn't find any ingredients in that text"); return; }
    state.recipes.unshift(r);
    ui.shareText = '';
    persist();
    location.replace(`#/recipe/${r.id}`);
  },
  portion: el => { ui.portion = { ...ui.portion, q: +el.dataset.q, grams: null, custom: '' }; render(); },
  'log-recipe': el => {
    const r = getRecipe(el.dataset.id);
    const a = r && portionFor(r);
    if (!a) { toast('Choose how much you had'); return; }
    ui.meal = document.getElementById('meal').value;
    pushRecent({ kind: 'recipe', id: r.id });
    const entry = { meal: ui.meal, name: r.name, ref: { kind: 'recipe', id: r.id }, ...a };
    ui.portion = null;
    addEntry(entry);
  },
  'pick-match': el => pickMatchSheet(el.dataset.recipe, el.dataset.ing),
  'choose-match': el => applyMatch({ kind: el.dataset.kind, id: el.dataset.id }),
  'pick-ignore': () => applyMatch({ kind: 'ignore' }),
  'pick-custom': () => {
    const box = document.getElementById('pick-results');
    box.innerHTML = `<div class="form">
      <p class="hint">Calories for the amount in this recipe:</p>
      <div class="grid2">
        <label>kcal<input id="pc-kcal" inputmode="decimal"></label>
        <label>Protein g<input id="pc-p" inputmode="decimal"></label>
        <label>Carbs g<input id="pc-c" inputmode="decimal"></label>
        <label>Fat g<input id="pc-f" inputmode="decimal"></label>
      </div>
      <button class="btn" data-act="save-custom">Use these</button></div>`;
    document.getElementById('pc-kcal').focus();
  },
  'save-custom': () => {
    const kcal = num(document.getElementById('pc-kcal').value);
    if (kcal == null) { toast('Enter the calories'); return; }
    const g = id => num(document.getElementById(id).value) || 0;
    applyMatch({ kind: 'custom' }, { kcal, p: g('pc-p'), c: g('pc-c'), f: g('pc-f') });
  },
  'pick-off': async () => {
    const q = document.getElementById('pick-q').value.trim();
    const box = document.getElementById('pick-results');
    if (!q) return;
    box.innerHTML = '<div class="loading"><div class="spinner"></div><p>Searching Open Food Facts…</p></div>';
    try {
      const products = await searchProducts(q);
      ui.offResults = products;
      box.innerHTML = products.map((p, i) => `<button type="button" class="row" data-act="choose-off" data-i="${i}">
        <div class="row-main"><b>${esc(p.name)}</b><small>${esc(p.brand)}</small></div>
        <div class="row-side">${kcalStr(p.per100.kcal)}<small>kcal/100${p.unit}</small></div></button>`).join('')
        || '<p class="hint">Nothing on Open Food Facts either. Enter the calories yourself.</p>';
    } catch (err) {
      box.innerHTML = `<p class="note warn">${esc(err.message)}</p>`;
    }
  },
  'choose-off': el => {
    const p = ui.offResults?.[+el.dataset.i];
    if (!p) return;
    const existing = p.barcode && state.foods.find(f => f.barcode === p.barcode);
    let id = existing?.id;
    if (!id) {
      id = uid();
      const food = { id, ...p, created: Date.now() };
      state.foods.unshift(food);
      keepLocalCopy(food);
    }
    applyMatch({ kind: 'food', id });
  },
  'edit-recipe-text': el => {
    const r = getRecipe(el.dataset.id);
    openSheet(`
      <h2>Edit pasted text</h2>
      <p class="hint">Ingredients are re-read from this text. Foods you picked before are remembered.</p>
      <textarea id="rt-text" rows="14">${esc(r.text || r.ingredients.map(i => i.line).join('\n'))}</textarea>
      <div class="row-actions"><button class="btn" data-act="save-recipe-text" data-id="${r.id}">Re-read ingredients</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
  },
  'save-recipe-text': el => {
    const r = getRecipe(el.dataset.id);
    const text = document.getElementById('rt-text').value;
    const fresh = createRecipe(text, r.name, r.servings);
    if (!fresh.ingredients.length) { toast("Couldn't find any ingredients in that text"); return; }
    r.text = text;
    r.ingredients = fresh.ingredients;
    persist(); closeSheet(); render();
  },
  'delete-recipe': el => {
    if (!confirm('Delete this recipe? Portions already logged stay as they are.')) return;
    state.recipes = state.recipes.filter(r => r.id !== el.dataset.id);
    state.recent = state.recent.filter(r => r.id !== el.dataset.id);
    persist(); go('#/recipes');
  },
  export: () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `calorie-tracker-backup-${todayISO()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  wipe: () => {
    if (!confirm('Delete ALL foods, recipes and log entries from this device? This cannot be undone.')) return;
    replaceState({});
    toast('All data deleted');
    go('#/today');
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  actions[el.dataset.act](el, e);
});

const inputs = {
  'add-search': el => { ui.addQuery = el.value; document.getElementById('add-results').innerHTML = addResults(); },
  'foods-search': el => {
    ui.foodsQuery = el.value;
    const q = el.value.trim();
    const list = q ? searchFoods(q).filter(r => r.kind === 'food') : state.foods.map(f => ({ kind: 'food', id: f.id }));
    document.getElementById('foods-list').innerHTML = list.map(ref => foodRow(ref, `#/log/food/${ref.id}`)).join('') || '<p class="hint">No matches.</p>';
  },
  'log-preview': updateLogPreview,
  'pick-search': el => { document.getElementById('pick-results').innerHTML = pickResults(el.value); },
  'portion-custom': el => {
    const r = getRecipe(ui.portion?.recipeId);
    const q = parseAmount(el.value);
    ui.portion = { ...ui.portion, custom: el.value, grams: null, q: q > 0 ? q : (el.value.trim() ? NaN : 1 / r.servings) };
    const g = document.getElementById('portion-grams');
    if (g) g.value = '';
    document.querySelectorAll('[data-act="portion"]').forEach(c => c.classList.toggle('on', !el.value.trim() && Math.abs(+c.dataset.q - ui.portion.q) < 1e-6));
    document.getElementById('portion-preview').innerHTML = portionPreview(r);
  },
  'portion-grams': el => {
    const r = getRecipe(ui.portion?.recipeId);
    const g = num(el.value);
    ui.portion = { ...ui.portion, grams: g > 0 ? g : null, custom: '' };
    const c = document.getElementById('portion-custom');
    if (c && g > 0) c.value = '';
    document.querySelectorAll('[data-act="portion"]').forEach(ch => ch.classList.toggle('on', !(g > 0) && Math.abs(+ch.dataset.q - ui.portion.q) < 1e-6));
    document.getElementById('portion-preview').innerHTML = portionPreview(r);
  },
};

const changes = {
  'log-preview': updateLogPreview,
  'barcode-photo': async el => {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    openSheet('<div class="loading"><div class="spinner"></div><p>Reading barcode…</p></div>');
    try {
      const code = await scanImageFile(file);
      closeSheet();
      handleBarcode(code, file);
    } catch (err) {
      closeSheet();
      toast(err.message);
    }
  },
  'food-photo': async el => {
    const src = await photoFromInput(el);
    if (!src) return;
    (ui.draftFood ||= { per100: {} }).image = src;
    setPhotoPreview(src);
  },
  'recipe-photo': async el => {
    const src = await photoFromInput(el);
    const r = getRecipe(el.dataset.id);
    if (!src || !r) return;
    r.image = src;
    persist(); render();
  },
  'ing-grams': el => {
    const r = getRecipe(el.dataset.recipe);
    const ing = r?.ingredients.find(i => i.id === el.dataset.ing);
    if (!ing) return;
    const g = num(el.value);
    ing.grams = g == null ? null : Math.max(0, g);
    ing.gramsEdited = g != null;
    persist(); render();
  },
  'recipe-field': el => {
    const r = getRecipe(location.hash.split('/')[2]);
    if (!r) return;
    const f = el.dataset.field;
    if (f === 'name') r.name = el.value.trim() || r.name;
    if (f === 'servings') { const n = parseInt(el.value, 10); if (n > 0) { r.servings = n; ui.portion = null; } }
    if (f === 'cookedG') r.cookedG = num(el.value) || null;
    persist(); render();
  },
  setting: el => {
    const v = num(el.value);
    const k = el.dataset.key;
    if (k === 'goal' && !(v > 0)) { toast('Enter a calorie goal'); return; }
    state.settings[k] = v || 0;
    persist(); toast('Saved');
  },
  import: async el => {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || !('log' in data)) throw new Error();
      if (!confirm('Replace everything on this device with the backup?')) return;
      replaceState(data);
      toast('Backup restored');
      go('#/today');
    } catch {
      toast("That file isn't a Calorie Tracker backup");
    }
  },
};

document.addEventListener('input', e => {
  const k = e.target.dataset?.input;
  if (k && inputs[k]) inputs[k](e.target);
});
document.addEventListener('change', e => {
  const k = e.target.dataset?.change;
  if (k && changes[k]) changes[k](e.target);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'bc-input') actions['lookup-barcode']();
});

// ---------- start ----------

// Text shared to the installed app (Android share sheet → Calories).
const params = new URLSearchParams(location.search);
if (params.has('text') || params.has('title') || params.has('url')) {
  ui.shareText = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
  history.replaceState(null, '', location.pathname + '#/recipe-new');
}

lastRoute = location.hash.split('/')[1] || '';
render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
