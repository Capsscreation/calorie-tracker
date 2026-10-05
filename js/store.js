// All data lives in this browser's localStorage. Settings → Export makes a backup file.
const KEY = 'calorie-tracker.v1';

const DEFAULTS = () => ({
  // Macro targets in grams (0 = not tracked); sodium in mg.
  settings: { goal: 2000, protein: 0, carbs: 0, fat: 0, fibre: 0, sugar: 0, sat: 0, sodium: 0, tbspMl: 20 },
  foods: [],     // the user's own products (scanned or typed in)
  recipes: [],
  log: {},       // 'YYYY-MM-DD' → entries
  learned: {},   // ingredient key → { kind, id } the user picked
  recent: [],    // [{ kind, id }] most recent first
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      const d = DEFAULTS();
      return { ...d, ...data, settings: { ...d.settings, ...data.settings } };
    }
  } catch { /* storage blocked or corrupt: start fresh */ }
  return DEFAULTS();
}

export let state = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function replaceState(data) {
  const d = DEFAULTS();
  state = { ...d, ...data, settings: { ...d.settings, ...(data.settings || {}) } };
  save();
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
