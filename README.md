# Calories

A phone-first calorie tracker that runs as an installable web app (PWA). There's no build step and no server-side code, and all data stays on the phone.

- **Scan a pack:** live camera scan or a photo of the barcode. Products are looked up on [Open Food Facts](https://world.openfoodfacts.org). If a product isn't listed, you type the nutrition panel in once (kJ or kcal, per 100 g or per serve) and it's saved to *My foods*. After that, scanning it finds it instantly.
- **Scan a nutrition panel:** photograph the panel and the app reads it on the phone (Tesseract OCR, no account or API key). It fills in energy, protein, fat, saturated fat, carbs, sugars, fibre and sodium from the per-100 g column. Your photo is shown beside the form, and saving is blocked until you tick that you've checked the numbers against the label. Typical OCR slips like "g" read as "9" or a lost decimal point are repaired by checking each value against the per-serve column and against the stated energy. Anything not found is outlined in amber.
- **Macros tab:** shows how the day's calories split between protein, carbs and fat; progress against targets (protein, carbs, fat, fibre, plus limits for sugars, saturated fat and sodium); a 7-day stacked chart (tap a day to open it); and each nutrient's top sources. Targets can be set in grams or as a % of calories, with presets. Sugars, saturated fat, fibre and sodium only come from foods whose label or Open Food Facts entry lists them. The built-in generic ingredients don't have them, and the tab says how many items are missing each one.
- **Product photos:** each product gets a thumbnail in the daily log, My foods and search, so you can tell packs apart at a glance. The app uses the Open Food Facts photo when there is one. If not, it uses the photo you scanned the barcode from, or one you add from the pack. Photos are saved on the device as small JPEGs (about 10 KB each), so they show offline too. Recipes can have a photo of the finished dish.
- **Stashcook recipes:** paste a recipe and the ingredients are matched against a built-in table of about 150 generic foods, then converted to grams. The app shows the calories for the whole dish. You then log ½, ⅓, ⅙ or any share (`2/6`, `0.3`), or log by grams eaten if you weigh the cooked dish.
- **Fixing matches:** tap any ingredient to pick a different food, search Open Food Facts, type the calories yourself or not count it. Your choices are remembered for future recipes.
- **Daily log:** calorie and macro goals, four meals, back/forward by day, quick-add, and editing a portion afterwards.

## Run locally

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765. The camera works on `localhost`/`127.0.0.1`, but a phone needs **HTTPS**.

## Put it on your phone

Host the folder on any static HTTPS host. GitHub Pages is free: push this repo, then go to Settings → Pages → *Deploy from branch* → `main` / root. Then open the URL on your phone:

- **iPhone (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** ⋮ → *Install app*. Once installed, **Calories** appears in the Android share sheet, so sharing recipe text from Stashcook opens it straight into *New recipe*.

## Getting recipes out of Stashcook

Stashcook has no public API. In Stashcook, open the recipe and use **Share → Copy**, or select the ingredient list and copy it, then paste it into *Recipes → Add a Stashcook recipe*. The parser looks for an *Ingredients* heading and stops at *Method/Instructions*. It picks up "Serves N", and it ignores sub-headings like "For the sauce:".

## Notes

- Built-in ingredient values are typical raw/uncooked averages per 100 g. Recipes default to the **Australian 20 ml tablespoon**; you can switch to 15 ml in Settings.
- A can or tin with no size given counts as 400 g. Canned beans/chickpeas use drained values, so edit the grams if you drain them.
- Back up from Settings → *Export backup*. Data lives in the browser's storage on that device only.

## Files

| File | What it does |
| --- | --- |
| `js/app.js` | Views, routing, actions |
| `js/parse.js` | Ingredient-line parser, unit conversion, food matching |
| `js/foods.js` | Built-in generic food table |
| `js/off.js` | Open Food Facts barcode lookup and search |
| `js/scanner.js` | Barcode reading (native `BarcodeDetector`, falling back to html5-qrcode) |
| `js/label.js` | Nutrition-panel OCR and the label-text parser |
| `js/images.js` | Shrinks product photos and stores them on the device |
| `js/store.js` | localStorage persistence |
| `sw.js` | Offline cache |
