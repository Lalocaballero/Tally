/* Tally — recipe engine (v3.0)
   Talks to TheMealDB through our own /api/recipes proxy (key hidden, cached).
   Core job: given ingredients you have (esp. expiring), find recipes and score
   each by have / substitute / missing. `fold`, `CATALOG`, and the maps from
   data.js + substitutions.js are globals available at call time. */

const RECIPE_API = '/api/recipes';

/* ---- Cuisine areas (verified against TheMealDB by probing filter.php) ----
   TheMealDB's list.php exposes ~192 area labels, but only 58 currently return
   any recipes. Of those, 29 work under the label shown, and 29 are filed under
   a country-noun instead of the adjective (French recipes live under "France").
   We expose ONLY these 58 so the planner has no dead chips; the other ~134
   labels return zero meals and are intentionally omitted. */
const AREA_ALIAS = {
  'Afghan': 'Afghanistan',
  'Albanian': 'Albania',
  'American': 'United States',
  'Andorran': 'Andorra',
  'Angolan': 'Angola',
  'Antiguan, Barbudan': 'Antigua and Barbuda',
  'Argentine': 'Argentina',
  'Armenian': 'Armenia',
  'Aruban': 'Aruba',
  'Austrian': 'Austria',
  'Azerbaijani': 'Azerbaijan',
  'Bahamian': 'Bahamas',
  'Bangladeshi': 'Bangladesh',
  'Barbadian': 'Barbados',
  'Belgian': 'Belgium',
  'Brazilian': 'Brazil',
  'Bulgarian': 'Bulgaria',
  'Cambodian': 'Cambodia',
  'Caymanian': 'Cayman Islands',
  'Chilean': 'Chile',
  'Colombian': 'Colombia',
  'Dutch': 'Netherlands',
  'French': 'France',
  'Indian': 'India',
  'Laotian': 'Laos',
  'Motswana': 'Botswana',
  'Norwegian': 'Norway',
  'Slovak': 'Slovakia',
  'Venezuelan': 'Venezuela',
};
/* Areas that return recipes under the label exactly as shown (no alias). */
const DIRECT_AREAS = [
  'Algerian', 'Australian', 'British', 'Canadian', 'Chinese', 'Croatian',
  'Egyptian', 'Filipino', 'Greek', 'Irish', 'Italian', 'Jamaican', 'Japanese',
  'Kenyan', 'Malaysian', 'Mexican', 'Moroccan', 'Polish', 'Portuguese',
  'Russian', 'Saudi Arabian', 'Spanish', 'Syrian', 'Thai', 'Tunisian',
  'Turkish', 'Ukrainian', 'Uruguayan', 'Vietnamese',
];

/* ---- proxy calls ---- */
async function mealApi(op, q) {
  const url = `${RECIPE_API}?op=${encodeURIComponent(op)}` + (q ? `&q=${encodeURIComponent(q)}` : '');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('recipe service unavailable');
  return res.json();
}

/* ---- ingredient normalisation & matching ---- */
/* Reduce a recipe ingredient string to a comparable token. */
function normIng(s) {
  let f = fold(s);
  // drop common descriptors that don't affect identity
  f = f.replace(/\b(fresh|dried|ground|chopped|sliced|minced|grated|large|small|medium|boneless|skinless|ripe|free range|smoked|raw|cooked|whole)\b/g, ' ');
  return f.replace(/\s+/g, ' ').trim();
}

/* Set of canonical pantry names you currently own (lowercased/folded). */
function pantryCanonicalSet() {
  const set = new Set();
  state.pantry.forEach(p => { if (p.name) set.add(fold(p.name)); });
  return set;
}

/* Does the pantry satisfy this recipe ingredient outright? ('have') */
function pantryHas(recipeIng, pantrySet) {
  const n = normIng(recipeIng);
  if (!n) return false;
  if (STAPLES.has(n)) return true;                         // staples assumed present
  if (pantrySet.has(n)) return true;                        // exact
  if (INGREDIENT_SYNONYMS[n] && pantrySet.has(fold(INGREDIENT_SYNONYMS[n]))) return true; // synonym
  // word-overlap: pantry "chicken" satisfies recipe "chicken breast"
  for (const canon of pantrySet) {
    if (canon.length >= 4 && (n === canon || n.includes(canon) || canon.includes(n))) return true;
  }
  return false;
}

/* Can a substitute cover it? -> substitute canonical name, or null. ('sub') */
function pantrySub(recipeIng, pantrySet) {
  const n = normIng(recipeIng);
  const subs = SUBSTITUTIONS[n];
  if (!subs) return null;
  for (const s of subs) { if (pantrySet.has(fold(s))) return s; }
  return null;
}

/* Pull the ingredient list out of a TheMealDB meal object. */
function mealIngredients(meal) {
  const out = [];
  for (let i = 1; i <= 20; i++) {
    const ing = meal['strIngredient' + i];
    const mea = meal['strMeasure' + i];
    if (ing && ing.trim()) out.push({ name: ing.trim(), measure: (mea || '').trim() });
  }
  return out;
}

/* ---- Diet / allergen filtering (v3.2) ---- */
/* Each preset maps to ingredient keywords; matching is word-boundary + optional
   plural so "nut" hits "nut"/"nuts" but never "butternut"/"coconut". */
const DIET_PRESETS = {
  pork:      { label: 'No pork',      words: ['pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'lard', 'gammon'] },
  beef:      { label: 'No beef',      words: ['beef', 'veal', 'steak'] },
  shellfish: { label: 'No shellfish', words: ['shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop', 'shellfish', 'crayfish'] },
  fish:      { label: 'No fish',      words: ['fish', 'salmon', 'tuna', 'cod', 'haddock', 'anchovy', 'anchovies', 'sardine', 'mackerel', 'trout'] },
  nuts:      { label: 'No nuts',      words: ['almond', 'walnut', 'peanut', 'cashew', 'pecan', 'hazelnut', 'pistachio', 'macadamia', 'nut'] },
  egg:       { label: 'No egg',       words: ['egg'] },
  dairy:     { label: 'No dairy',     words: ['milk', 'cheese', 'butter', 'cream', 'yoghurt', 'yogurt', 'ghee', 'parmesan', 'mozzarella'] },
  gluten:    { label: 'No gluten',    words: ['flour', 'bread', 'pasta', 'wheat', 'barley', 'breadcrumb', 'breadcrumbs', 'couscous', 'noodle'] },
};

/* Flat list of lowercase keywords to avoid, from presets + custom words. */
function dietWords() {
  const d = state.diet || {};
  let words = [];
  (d.presets || []).forEach(k => { if (DIET_PRESETS[k]) words = words.concat(DIET_PRESETS[k].words); });
  (d.custom || []).forEach(w => { const t = String(w || '').trim().toLowerCase(); if (t) words.push(t); });
  return words;
}

/* True if a meal contains any avoided ingredient (checks ingredients + title).
   Word-boundary + optional plural avoids substring false positives. */
function mealViolatesDiet(meal) {
  const words = dietWords();
  if (!words.length || !meal) return false;
  const hay = mealIngredients(meal).map(ig => fold(ig.name));
  hay.push(fold(meal.strMeal || ''));
  return words.some(w => {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|es)?\\b', 'i');
    return hay.some(h => re.test(h));
  });
}

/* Classify every ingredient of a meal against the pantry. */
function classifyMeal(meal, pantrySet, selectedSet) {
  const ings = mealIngredients(meal);
  const have = [], sub = [], missing = [];
  let usesSelected = 0;
  ings.forEach(ig => {
    const n = normIng(ig.name);
    if (selectedSet && (selectedSet.has(n) || [...selectedSet].some(s => n.includes(s) || s.includes(n)))) usesSelected++;
    if (pantryHas(ig.name, pantrySet)) { have.push(ig); return; }
    const sName = pantrySub(ig.name, pantrySet);
    if (sName) { sub.push({ ...ig, subWith: sName }); return; }
    missing.push(ig);
  });
  const total = ings.length || 1;
  // score: exact-have best, sub half-credit, missing hurts; selected-usage bonus
  const score = (have.length * 1.0 + sub.length * 0.5) / total * 100 + usesSelected * 6;
  return { have, sub, missing, total, usesSelected, score, ings };
}

/* ---- the main flow: from selected ingredients -> ranked recipes ---- */
/* selected = array of canonical pantry names. onStep(msg) for progress. */
async function findRecipes(selected, onStep) {
  const pantrySet = pantryCanonicalSet();
  const selectedSet = new Set(selected.map(fold));

  // 1) gather candidate IDs by querying each selected ingredient
  const idMap = {};   // id -> {name,thumb}
  for (let i = 0; i < selected.length; i++) {
    const term = QUERY_TERMS[fold(selected[i])] || selected[i];
    if (onStep) onStep(`Searching “${selected[i]}”...`);
    try {
      const d = await mealApi('filter', term.replace(/\s+/g, '_'));
      (d.meals || []).forEach(m => { idMap[m.idMeal] = { name: m.strMeal, thumb: m.strMealThumb }; });
    } catch (e) { /* skip this ingredient, keep going */ }
  }
  let ids = Object.keys(idMap);
  if (!ids.length) return [];

  // cap the pool so the first (uncached) run stays quick
  ids = ids.slice(0, 40);

  // 2) hydrate each candidate (cached forever server-side) and 3) score
  const scored = [];
  for (let i = 0; i < ids.length; i++) {
    if (onStep) onStep(`Checking recipe ${i + 1} of ${ids.length}...`);
    try {
      const d = await mealApi('lookup', ids[i]);
      const meal = (d.meals || [])[0];
      if (!meal) continue;
      const c = classifyMeal(meal, pantrySet, selectedSet);
      scored.push({ meal, ...c });
    } catch (e) { /* skip */ }
  }

  // 4) rank: highest score first; tiebreak fewer-missing then more-have
  scored.sort((a, b) => b.score - a.score || a.missing.length - b.missing.length || b.have.length - a.have.length);
  return scored.filter(s => !mealViolatesDiet(s.meal));
}

/* Explore helpers */
async function searchRecipes(name) {
  const d = await mealApi('search', name);
  return d.meals || [];
}
async function randomRecipe() {
  // try a few times so an active diet filter still yields a suggestion
  for (let i = 0; i < 12; i++) {
    const d = await mealApi('random');
    const m = (d.meals || [])[0];
    if (!m) return null;
    if (!mealViolatesDiet(m)) return m;
  }
  return null;
}

/* Cuisines list for the "inspired by" planner. Returns only the 58 areas we've
   confirmed return recipes (no live list.php call, no dead chips). */
function listCuisines() {
  return DIRECT_AREAS.concat(Object.keys(AREA_ALIAS)).sort();
}
/* Recipe IDs for a cuisine, then hydrate a handful (for meal-plan generation). */
async function recipesByCuisine(area, limit) {
  limit = limit || 7;
  let d = await mealApi('area', area);
  // Some cuisines are filed under the country-noun ("France") while the chip
  // uses the adjective ("French"). If the label yields nothing, retry the alias.
  if ((!d.meals || !d.meals.length) && AREA_ALIAS[area]) {
    d = await mealApi('area', AREA_ALIAS[area]);
  }
  let meals = d.meals || [];
  // shuffle so "generate again" varies
  for (let i = meals.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [meals[i], meals[j]] = [meals[j], meals[i]]; }
  // Hydrate one-by-one and skip desserts (a meal plan wants main dishes, not
  // cake). filter.php gives no category, so we only learn it after lookup.
  const full = [];
  for (const m of meals) {
    if (full.length >= limit) break;
    try {
      const r = await mealApi('lookup', m.idMeal);
      const meal = (r.meals || [])[0];
      if (meal && !/dessert/i.test(meal.strCategory || '') && !mealViolatesDiet(meal)) full.push(meal);
    } catch (e) { /* skip */ }
  }
  // Fallback: if a cuisine is ALL desserts, don't return an empty week.
  if (!full.length) {
    for (const m of meals.slice(0, limit)) {
      try { const r = await mealApi('lookup', m.idMeal); const meal = (r.meals || [])[0]; if (meal && !mealViolatesDiet(meal)) full.push(meal); }
      catch (e) { /* skip */ }
    }
  }
  return full;
}
/* Score an arbitrary meal object against the current pantry (for saved/plan). */
function scoreMeal(meal) {
  return { meal, ...classifyMeal(meal, pantryCanonicalSet(), null) };
}
