/* Tally — Pantry Tracker v1 + shared sync
   App state lives on the server (state.json via /api/state) so both phones
   share one live pantry. localStorage is used as an offline cache/fallback. */

const STORE_KEY = 'tally.v1';
const API = '/api/state';

const CATEGORIES = ['Dairy','Bakery','Produce','Meat & Fish','Pantry','Frozen','Drinks','Household','Other'];

/* ---------- State ---------- */
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      s.updatedAt = s.updatedAt || 0;
      s.purchases = s.purchases || [];      // v2 migration
      s.listExtras = s.listExtras || [];
      s.aliases = s.aliases || {};          // v2.3c: shared learned names
      s.saved = s.saved || [];              // v3.1: saved recipes
      s.mealPlan = s.mealPlan || {};        // v3.1: {mon:recipe, tue:recipe,...}
      s.prefs = s.prefs || {};              // v3.1: preferences (cuisine etc.)
      s.diet = s.diet || { presets: [], custom: [] }; // v3.2: recipe diet/allergen filters
      // one-time migration of any per-device learned names into shared state
      try {
        const legacy = JSON.parse(localStorage.getItem('tally.aliases'));
        if (legacy && typeof legacy === 'object') s.aliases = Object.assign({}, legacy, s.aliases);
      } catch (e) {}
      return s;
    }
  } catch (e) {}
  return { pantry: seed(), listExtras: [], purchases: [], aliases: {}, saved: [], mealPlan: {}, prefs: {}, diet: { presets: [], custom: [] }, updatedAt: 0 };
}
function saveLocal() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

/* Every change: stamp it, cache locally, and push to the server (debounced) */
function save() {
  state.updatedAt = Date.now();
  saveLocal();
  syncPush();
}

function seed() {
  return [
    { id: uid(), name: 'Milk',   orig: 'Mlieko / Milch', cat: 'Dairy',  status: 'ok'  },
    { id: uid(), name: 'Bread',  orig: 'Chlieb / Brot',  cat: 'Bakery', status: 'low' },
    { id: uid(), name: 'Butter', orig: 'Maslo / Butter', cat: 'Dairy',  status: 'ok'  },
    { id: uid(), name: 'Eggs',   orig: 'Vajcia / Eier',  cat: 'Produce',status: 'out' },
    { id: uid(), name: 'Coffee', orig: 'Káva / Kaffee',  cat: 'Drinks', status: 'ok'  },
  ];
}
function uid() { return Math.random().toString(36).slice(2, 9); }

/* ---------- Sync ---------- */
let pushTimer = null;

function setSync(online) {
  const dot = document.getElementById('sync-dot');
  if (dot) dot.className = 'sync-dot ' + (online ? 'on' : 'off');
}

function applyRemote(remote) {
  state.pantry = remote.pantry || [];
  state.listExtras = remote.listExtras || [];
  state.purchases = remote.purchases || [];
  // Learned names are additive knowledge — UNION both sides so a correction on
  // either device is never lost (unlike pantry/list which use last-write-wins).
  state.aliases = Object.assign({}, state.aliases || {}, remote.aliases || {});
  // v3.1: saved recipes union by id (never lose a save); plan/prefs last-write-wins
  const savedById = {};
  [...(state.saved || []), ...(remote.saved || [])].forEach(s => { if (s && s.id) savedById[s.id] = s; });
  state.saved = Object.values(savedById);
  state.mealPlan = remote.mealPlan || state.mealPlan || {};
  state.prefs = remote.prefs || state.prefs || {};
  state.updatedAt = remote.updatedAt || 0;
  saveLocal();
  // refresh the passive views only (don't disrupt Scan/Add in progress)
  if (currentView === 'pantry' || currentView === 'list') views[currentView]();
}

async function syncPull() {
  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw 0;
    const remote = await res.json();
    setSync(true);
    if ((remote.updatedAt || 0) > (state.updatedAt || 0)) applyRemote(remote);
  } catch (e) { setSync(false); }
}

function syncPush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const res = await fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      setSync(res.ok);
    } catch (e) { setSync(false); }
  }, 400);
}

async function bootSync() {
  try {
    const res = await fetch(API, { cache: 'no-store' });
    const remote = await res.json();
    setSync(true);
    if ((remote.updatedAt || 0) > (state.updatedAt || 0)) {
      applyRemote(remote);                 // adopt server's newer copy
    } else if ((remote.pantry || []).length === 0 || (state.updatedAt || 0) > (remote.updatedAt || 0)) {
      syncPush();                          // seed / push our newer copy up
    }
  } catch (e) {
    setSync(false);                        // offline: run on local cache
  }
  renderPantry();
  setInterval(syncPull, 5000);             // live sync every 5s
}

/* ---------- Router ---------- */
let currentView = 'pantry';
const views = { pantry: renderPantry, scan: renderScan, list: renderList, cook: renderCook, insights: renderInsights, add: renderAdd };

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchView(t.dataset.view))
);
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  views[v]();
}

/* ---------- Pantry ---------- */
const STATUS_LABEL = { ok: 'In stock', low: 'Running low', out: 'Out' };
const NEXT_STATUS   = { ok: 'low', low: 'out', out: 'ok' };

let pantryView = { q: '', cat: '', sort: 'added', status: '' };

function renderPantry() {
  const el = document.getElementById('view');
  if (!state.pantry.length) {
    el.innerHTML = `<div class="hint">Your pantry is empty.<br>Tap 📸 Scan a receipt or ➕ Add to fill it.</div>`;
    return;
  }
  const cats = [...new Set(state.pantry.map(p => p.cat || 'Other'))].sort();
  const total = state.pantry.length;
  const lowN = state.pantry.filter(p => p.status === 'low').length;
  const outN = state.pantry.filter(p => p.status === 'out').length;
  const expiringCount = state.pantry.filter(p => { const e = expiryInfo(p); return e && (e.state === 'soon' || e.state === 'expired'); }).length;
  // v3.2 "Today" banner: quick glance at low + expiring + a recipe you can cook right now
  const cookable = (state.saved || []).map(s => scoreMeal(s.meal)).filter(r => !mealViolatesDiet(r.meal)).find(r => r.missing.length === 0);
  const todayBits = [];
  if (lowN) todayBits.push(`<b>${lowN}</b> low`);
  if (expiringCount) todayBits.push(`<b>${expiringCount}</b> expiring`);
  if (cookable) todayBits.push(`cook <b>${esc(cookable.meal.strMeal)}</b>`);
  const todayBanner = todayBits.length ? `<div class="today-banner"${cookable ? ' id="today-cook"' : ''}>Today: ${todayBits.join(' &middot; ')}</div>` : '';

  const chip = (val, label, cls) => `<button class="count-chip ${cls} ${pantryView.status === val ? 'active' : ''}" data-status="${val}">${label}</button>`;

  el.innerHTML = `
    ${todayBanner}
    <div class="count-bar">
      ${chip('', `${total} total`, 'all')}
      ${chip('low', `${lowN} low`, 'low')}
      ${chip('out', `${outN} out`, 'out')}
    </div>
    <div class="pantry-tools">
      <input id="pantry-search" class="pantry-search" placeholder="🔍 Search pantry..." value="${esc(pantryView.q)}" autocomplete="off" />
      <div class="pantry-selects">
        <select id="pantry-cat">
          <option value="">All categories</option>
          ${cats.map(c => `<option value="${esc(c)}" ${pantryView.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <select id="pantry-sort">
          <option value="added"    ${pantryView.sort === 'added' ? 'selected' : ''}>Added order</option>
          <option value="category" ${pantryView.sort === 'category' ? 'selected' : ''}>By category</option>
          <option value="name"     ${pantryView.sort === 'name' ? 'selected' : ''}>By name</option>
          <option value="expiry"   ${pantryView.sort === 'expiry' ? 'selected' : ''}>By expiry</option>
        </select>
      </div>
    </div>
    <div id="pantry-list"></div>`;

  const search = el.querySelector('#pantry-search');
  search.addEventListener('input', () => { pantryView.q = search.value; renderPantryList(); });
  el.querySelector('#pantry-cat').addEventListener('change', (e) => { pantryView.cat = e.target.value; renderPantryList(); });
  el.querySelector('#pantry-sort').addEventListener('change', (e) => { pantryView.sort = e.target.value; renderPantryList(); });
  el.querySelectorAll('.count-chip').forEach(b =>
    b.addEventListener('click', () => {
      pantryView.status = (pantryView.status === b.dataset.status) ? '' : b.dataset.status;
      el.querySelectorAll('.count-chip').forEach(x => x.classList.toggle('active', x.dataset.status === pantryView.status && pantryView.status !== ''));
      renderPantryList();
    })
  );

  const tc = el.querySelector('#today-cook');
  if (tc && cookable) tc.addEventListener('click', () => openRecipe(cookable));

  renderPantryList();
}

/* Fills only #pantry-list (so the search box keeps focus while typing). */
function renderPantryList() {
  const box = document.getElementById('pantry-list');
  if (!box) return;
  const q = pantryView.q.trim().toLowerCase();

  let items = state.pantry.filter(p => {
    if (pantryView.status && p.status !== pantryView.status) return false;
    if (pantryView.cat && (p.cat || 'Other') !== pantryView.cat) return false;
    if (q && !((p.name || '').toLowerCase().includes(q) || (p.orig || '').toLowerCase().includes(q))) return false;
    return true;
  });

  if (pantryView.sort === 'name') {
    items = [...items].sort((a, b) => a.name.localeCompare(b.name));
  } else if (pantryView.sort === 'category') {
    items = [...items].sort((a, b) => (a.cat || 'Other').localeCompare(b.cat || 'Other') || a.name.localeCompare(b.name));
  } else if (pantryView.sort === 'expiry') {
    const key = p => { const d = daysUntil(p.expiry); return d === null ? 99999 : d; };
    items = [...items].sort((a, b) => key(a) - key(b));
  }
  // 'added' keeps state.pantry order (stable — no jump on tap)

  if (!items.length) {
    box.innerHTML = `<div class="hint">No matching items.</div>`;
    return;
  }

  if (pantryView.sort === 'category') {
    const groups = {};
    items.forEach(p => { const c = p.cat || 'Other'; (groups[c] = groups[c] || []).push(p); });
    box.innerHTML = Object.keys(groups).sort().map(c =>
      `<div class="cat-head">${esc(c)}</div><div class="grid">${groups[c].map(cardHTML).join('')}</div>`
    ).join('');
  } else {
    box.innerHTML = `<div class="grid">${items.map(cardHTML).join('')}</div>`;
  }

  box.querySelectorAll('.card').forEach(c =>
    c.addEventListener('click', () => cycleStatus(c.dataset.id))
  );
  box.querySelectorAll('.card-edit').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); editPantryItem(b.dataset.edit); })
  );
}
function rank(s) { return s === 'out' ? 0 : s === 'low' ? 1 : 2; }
/* out < low < (ok but predicted-low) < ok — so likely-low floats up */
function sortRank(item) {
  if (item.status === 'out') return 0;
  if (item.status === 'low') return 1;
  return isPredictedLow(item) ? 2 : 3;
}
function cardHTML(item) {
  const predicted = isPredictedLow(item);
  return `
    <div class="card ${item.status}${predicted ? ' predicted' : ''}" data-id="${item.id}">
      <div class="stripe"></div>
      <button class="card-edit" data-edit="${item.id}" aria-label="Edit">⋯</button>
      <div class="name">${esc(item.name)}</div>
      ${item.orig ? `<div class="orig">${esc(item.orig)}</div>` : ''}
      <div class="card-foot">
        <span class="status">${STATUS_LABEL[item.status]}</span>
        ${expiryBadge(item)}
        ${predicted ? `<span class="predict-badge">likely low</span>` : ''}
      </div>
    </div>`;
}

/* Edit menu for a pantry item: rename or delete */
function editPantryItem(id) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  const exLabel = item.expiry ? `Expiry: ${item.expiry}` : 'Set expiry date';
  showModal(`“${item.name}” (${esc(item.cat || 'Other')}) — what would you like to do?`, [
    { label: 'Rename', kind: 'btn', fn: () => { hideModal(); renamePantryItem(id); } },
    { label: 'Change category', kind: 'secondary', fn: () => { hideModal(); changeCategory(id); } },
    { label: exLabel, kind: 'secondary', fn: () => { hideModal(); setExpiry(id); } },
    { label: 'Delete', kind: 'secondary', fn: () => { hideModal(); confirmDeletePantry(id); } },
    { label: 'Cancel', kind: 'secondary', fn: hideModal },
  ]);
}
/* Category picker — buttons for each category; picking one updates the item
   (and refreshes its expiry estimate, since expiry depends on category). */
function changeCategory(id) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  const actions = CATEGORIES.map(c => ({
    label: (c === item.cat ? '✓ ' : '') + c,
    kind: c === item.cat ? 'btn' : 'secondary',
    fn: () => {
      item.cat = c;
      // refresh auto-expiry only if item didn't have a manual one already
      if (!item.expiry) { const ex = estimateExpiry(c, null); if (ex) item.expiry = ex; }
      save(); hideModal(); renderPantry();
    },
  }));
  actions.push({ label: 'Cancel', kind: 'secondary', fn: hideModal });
  showModal(`Category for “${esc(item.name)}”:`, actions);
}
function setExpiry(id) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  const v = prompt('Expiry date (YYYY-MM-DD) — leave blank to clear:', item.expiry || '');
  if (v === null) return;                       // cancelled
  const t = v.trim();
  if (t === '') { delete item.expiry; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !isNaN(new Date(t + 'T00:00:00'))) { item.expiry = t; }
  else { return flash('Please use the format YYYY-MM-DD (e.g. 2026-07-20).'); }
  save();
  renderPantry();
}
function renamePantryItem(id) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  const v = prompt('New name (English):', item.name);
  if (v && v.trim()) {
    item.name = v.trim();
    const match = CATALOG.find(c => c.en.toLowerCase() === item.name.toLowerCase());
    if (match) item.cat = match.cat;
    save();
  }
  renderPantry();
}
function confirmDeletePantry(id) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  showModal(`Remove “${item.name}” from the pantry?`, [
    { label: 'Delete', kind: 'btn', fn: () => {
        state.pantry = state.pantry.filter(p => p.id !== id);
        save(); hideModal(); renderPantry();
      } },
    { label: 'Cancel', kind: 'secondary', fn: hideModal },
  ]);
}
function cycleStatus(id) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  item.status = NEXT_STATUS[item.status];
  save();
  // Update ONLY this card in place so it keeps its position (no reorder/jump).
  const card = document.querySelector('.card[data-id="' + id + '"]');
  if (card) {
    const tmp = document.createElement('div');
    tmp.innerHTML = cardHTML(item);
    const fresh = tmp.firstElementChild;
    card.replaceWith(fresh);
    fresh.addEventListener('click', () => cycleStatus(id));
    const eb = fresh.querySelector('.card-edit');
    if (eb) eb.addEventListener('click', (e) => { e.stopPropagation(); editPantryItem(id); });
  } else {
    renderPantry();
  }
}

function upsertPantry(englishName, orig, cat, fromDate) {
  const existing = state.pantry.find(p => p.name.toLowerCase() === englishName.toLowerCase());
  if (existing) {
    existing.status = 'ok';
    if (orig && !(existing.orig || '').includes(orig)) {
      existing.orig = existing.orig ? existing.orig + ' / ' + orig : orig;
    }
    const ex = estimateExpiry(existing.cat, fromDate);   // refresh on re-purchase
    if (ex) existing.expiry = ex;
  } else {
    state.pantry.push({
      id: uid(), name: englishName, orig: orig || '', cat: cat || 'Other',
      status: 'ok', expiry: estimateExpiry(cat, fromDate),
    });
  }
}

/* ---------- Expiry tracking (v2.2) ---------- */
/* Only perishables get an auto-estimated expiry; dry/household goods don't. */
const PERISHABLE = ['Dairy', 'Bakery', 'Produce', 'Meat & Fish', 'Frozen'];
function estimateExpiry(cat, fromDate) {
  if (!PERISHABLE.includes(cat)) return null;
  const base = fromDate ? new Date(fromDate + 'T00:00:00') : new Date();
  if (isNaN(base)) return null;
  base.setDate(base.getDate() + shelfLifeFor(cat));
  return base.toISOString().slice(0, 10);
}
function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / DAY);
}
/* -> { state:'expired'|'soon'|'ok', days } or null if no expiry set */
function expiryInfo(item) {
  const days = daysUntil(item.expiry);
  if (days === null) return null;
  if (days < 0) return { state: 'expired', days };
  if (days <= 3) return { state: 'soon', days };
  return { state: 'ok', days };
}
function expiryBadge(item) {
  const e = expiryInfo(item);
  if (!e) return '';
  if (e.state === 'expired') return `<span class="exp-badge expired">expired</span>`;
  if (e.state === 'soon') return `<span class="exp-badge soon">${e.days === 0 ? 'today' : 'in ' + e.days + 'd'}</span>`;
  return '';
}

/* ---------- Purchase history + prediction (v2) ---------- */
const DAY = 86400000;

/* Log a purchase into history (from a receipt or a manual add). */
function logPurchase(name, cat, price, qty, date, store) {
  state.purchases.push({
    name: name,
    cat: cat || 'Other',
    price: (typeof price === 'number') ? price : null,
    qty: qty || 1,
    date: date || new Date().toISOString().slice(0, 10),
    store: store ? store.name : '',
    country: store ? store.country : '??',
  });
}

/* Sorted purchase dates (ms) for a product name. */
function purchaseDates(name) {
  const n = name.toLowerCase();
  return state.purchases
    .filter(p => (p.name || '').toLowerCase() === n)
    .map(p => new Date(p.date).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);
}

/* Is this pantry item PROBABLY low, based on buying cadence?
   - 2+ purchases  -> learned average repurchase interval
   - 1 purchase    -> category shelf-life default
   Returns true only for items currently marked 'ok' (manual flags win). */
function isPredictedLow(item) {
  if (item.status !== 'ok') return false;
  const dates = purchaseDates(item.name);
  if (!dates.length) return false;
  const last = dates[dates.length - 1];
  const daysSince = (Date.now() - last) / DAY;

  let interval;
  if (dates.length >= 2) {
    let sum = 0;
    for (let i = 1; i < dates.length; i++) sum += (dates[i] - dates[i - 1]) / DAY;
    interval = sum / (dates.length - 1);
  } else {
    interval = shelfLifeFor(item.cat);
  }
  return interval > 0 && daysSince > interval;
}

/* Pantry items predicted low (but not already flagged low/out). */
function predictedLowItems() {
  return state.pantry.filter(isPredictedLow);
}

/* ---------- Scan (receipt) ---------- */
let scanResult = null;

function renderScan() {
  const el = document.getElementById('view');
  el.innerHTML = `
    <div class="section-title">Scan a receipt</div>
    <div class="scan-drop" id="scan-drop">
      <div class="scan-ico">🧾</div>
      <div class="scan-title">Add a receipt</div>
      <div class="scan-sub">Photo, or a digital receipt (PDF / image). Slovak &amp; Austrian receipts are translated to English.</div>
      <input type="file" id="scan-cam"  accept="image/*" capture="environment" hidden />
      <input type="file" id="scan-file" accept="image/*,application/pdf" hidden />
      <button class="btn" id="scan-photo">📸 Take a photo</button>
      <button class="btn secondary" id="scan-upload" style="margin-top:10px">📄 Upload PDF or image</button>
      <input type="file" id="scan-bulk" accept="image/*,application/pdf" multiple hidden />
      <button class="btn secondary" id="scan-backfill" style="margin-top:10px">📥 Backfill old receipts</button>
      <div class="scan-sub" style="margin-top:8px">Backfill imports several old receipts at once — great for filling in past months so predictions &amp; spending charts work right away.</div>
    </div>
    <div id="scan-progress" class="scan-progress hidden">
      <div class="spinner"></div>
      <div id="scan-status">Reading receipt...</div>
      <div class="bar"><div id="scan-bar" class="bar-fill"></div></div>
    </div>
    <div id="scan-review"></div>`;

  const camInput  = el.querySelector('#scan-cam');
  const fileInput = el.querySelector('#scan-file');
  const bulkInput = el.querySelector('#scan-bulk');
  // "Take a photo" opens the in-app guided camera (falls back to native picker)
  el.querySelector('#scan-photo').addEventListener('click', openCamera);
  el.querySelector('#scan-upload').addEventListener('click', () => fileInput.click());
  el.querySelector('#scan-backfill').addEventListener('click', () => bulkInput.click());
  camInput.addEventListener('change',  () => { if (camInput.files[0])  startScan(camInput.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) startScan(fileInput.files[0]); });
  bulkInput.addEventListener('change', () => { if (bulkInput.files.length) startBackfill(bulkInput.files); });
}

/* ---------- Backfill: bulk-import old receipts (Milestone 2.4) ---------- */
/* Processes many receipts in one go and auto-imports their items into purchase
   history + pantry (no per-item review — speed is the point). Each item lands
   on its receipt's real date, so prediction & spending charts get instant
   historical data. Shows progress, then a summary. */
let backfillItems = [];    // flat list of every parsed line across all receipts
let backfillStats = { ok: 0, fail: 0 };

async function startBackfill(fileList) {
  const files = Array.from(fileList);
  const prog = document.getElementById('scan-progress');
  const drop = document.getElementById('scan-drop');
  const bar  = document.getElementById('scan-bar');
  const stat = document.getElementById('scan-status');
  const rev  = document.getElementById('scan-review');
  if (drop) drop.classList.add('hidden');
  if (prog) prog.classList.remove('hidden');
  if (rev) rev.innerHTML = '';

  backfillItems = [];
  backfillStats = { ok: 0, fail: 0 };

  // First pass: read every receipt, collect line items; commit later.
  for (let f = 0; f < files.length; f++) {
    if (stat) stat.textContent = `Reading receipt ${f + 1} of ${files.length}...`;
    if (bar) bar.style.width = Math.round((f / files.length) * 100) + '%';
    try {
      const res = await processReceipt(files[f], () => {});
      if (!res.items.length) { backfillStats.fail++; continue; }
      backfillStats.ok++;
      res.items.forEach(it => {
        backfillItems.push({
          rawFolded: it.rawFolded, raw: it.raw,
          englishName: it.englishName, cat: it.cat, confidence: it.confidence,
          price: it.price, qty: it.qty,
          date: res.date, store: res.store,
        });
      });
    } catch (e) {
      backfillStats.fail++;
    }
  }
  if (bar) bar.style.width = '100%';
  if (prog) prog.classList.add('hidden');

  if (!backfillItems.length) {
    if (drop) drop.classList.remove('hidden');
    return flash("Couldn't read any items from those receipts. Try clearer photos or PDFs.");
  }
  renderBackfillReview();
}

/* De-duplicated review: group all line items by their raw text so each unique
   product is shown ONCE (with a ×count). Fix a name here and it applies to
   every occurrence across all receipts. */
function renderBackfillReview() {
  const rev = document.getElementById('scan-review');
  if (!rev) return;

  // group by rawFolded
  const groups = {};
  backfillItems.forEach(it => {
    const k = it.rawFolded || it.englishName;
    if (!groups[k]) groups[k] = { rawFolded: it.rawFolded, raw: it.raw, englishName: it.englishName, cat: it.cat, confidence: it.confidence, count: 0 };
    groups[k].count += it.qty || 1;
  });
  const uniques = Object.values(groups).sort((a, b) => b.count - a.count);
  const needFix = uniques.filter(u => u.confidence !== 'high').length;

  rev.innerHTML = `
    <div class="review-head">
      <div>📥 <b>Review backfill</b></div>
      <div class="li-meta">${backfillStats.ok} receipt${backfillStats.ok !== 1 ? 's' : ''} · ${uniques.length} unique products${backfillStats.fail ? ` · ${backfillStats.fail} unreadable` : ''} · tap any to rename</div>
      ${needFix ? `<div class="li-meta">${needFix} may need a name fix (flagged below)</div>` : ''}
    </div>
    <div id="bf-rows">${uniques.map((u, i) => bfRow(u, i)).join('')}</div>
    <button class="btn" id="bf-import">Import all to pantry &amp; history</button>
    <button class="btn secondary" id="bf-cancel" style="margin-top:10px">Cancel</button>`;

  rev._uniques = uniques;
  rev.querySelectorAll('.rv-row').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.rv-body').addEventListener('click', () => bfRename(i));
  });
  rev.querySelector('#bf-import').addEventListener('click', commitBackfill);
  rev.querySelector('#bf-cancel').addEventListener('click', () => { backfillItems = []; renderScan(); });
}
function bfRow(u, i) {
  const conf = u.confidence;
  const tag = conf === 'high' ? '' :
    conf === 'med' ? `<span class="conf med">guess</span>` : `<span class="conf low">not sure</span>`;
  return `
    <div class="rv-row ${conf}" data-i="${i}">
      <div class="rv-body">
        <div class="rv-name">${esc(u.englishName)} ${tag} <span class="bf-count">×${u.count}</span></div>
        <div class="rv-orig">"${esc(u.raw)}"</div>
      </div>
    </div>`;
}
/* Rename a unique product -> applies to all its occurrences + teaches the dict */
function bfRename(i) {
  const rev = document.getElementById('scan-review');
  const u = rev._uniques[i];
  if (!u) return;
  const v = prompt(`What is "${u.raw}"? (English)`, u.englishName);
  if (v === null) return;
  const name = v.trim();
  if (!name) return;
  const match = CATALOG.find(c => c.en.toLowerCase() === name.toLowerCase());
  const cat = match ? match.cat : (u.cat || 'Other');
  // apply to every occurrence with this rawFolded
  backfillItems.forEach(it => {
    if ((it.rawFolded || it.englishName) === (u.rawFolded || u.englishName)) {
      it.englishName = name; it.cat = cat; it.confidence = 'high';
    }
  });
  renderBackfillReview();
}

/* Commit all collected items to pantry + purchase history, each on its own
   receipt date, and teach every mapping. */
function commitBackfill() {
  const snap = snapshotState();
  const perStore = {};
  backfillItems.forEach(it => {
    upsertPantry(it.englishName, it.raw, it.cat, it.date);
    logPurchase(it.englishName, it.cat, it.price, it.qty, it.date, it.store);
    if (it.rawFolded && it.englishName) learnAlias(it.rawFolded, it.englishName);
    const s = it.store && it.store.name ? it.store.name : 'Unknown';
    perStore[s] = (perStore[s] || 0) + (it.qty || 1);
  });
  save();
  const total = backfillItems.length;
  const rev = document.getElementById('scan-review');
  const storeLines = Object.entries(perStore).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `<div class="bf-line">${esc(s)} · ${n} item${n !== 1 ? 's' : ''}</div>`).join('');
  backfillItems = [];
  if (rev) {
    rev.innerHTML = `
      <div class="review-head">
        <div>✓ <b>Imported</b></div>
        <div class="li-meta">${total} items added to pantry &amp; history</div>
      </div>
      ${storeLines ? `<div class="chart">${storeLines}</div>` : ''}
      <button class="btn" id="bf-done">View pantry</button>
      <button class="btn secondary" id="bf-undo" style="margin-top:10px">↩︎ Undo this import</button>
      <button class="btn secondary" id="bf-insights" style="margin-top:10px">See spending insights</button>`;
    const d = rev.querySelector('#bf-done'); if (d) d.addEventListener('click', () => switchView('pantry'));
    const ins = rev.querySelector('#bf-insights'); if (ins) ins.addEventListener('click', () => switchView('insights'));
    const un = rev.querySelector('#bf-undo'); if (un) un.addEventListener('click', () => {
      restoreSnapshot(snap);
      renderScan();
      toast('Import undone');
    });
  }
  toast(`Imported ${total} items ✓`, { undo: () => { restoreSnapshot(snap); renderScan(); } });
}

/* Shared processing UI: shows progress, runs `work(onProgress)`, then review. */
async function runScanPipeline(work) {
  if (currentView !== 'scan') switchView('scan');
  const prog = document.getElementById('scan-progress');
  const drop = document.getElementById('scan-drop');
  const bar  = document.getElementById('scan-bar');
  const stat = document.getElementById('scan-status');
  if (drop) drop.classList.add('hidden');
  if (prog) prog.classList.remove('hidden');
  const rev = document.getElementById('scan-review'); if (rev) rev.innerHTML = '';
  try {
    if (stat) stat.textContent = 'Reading receipt...';
    scanResult = await work(p => { if (bar) bar.style.width = Math.round(p * 100) + '%'; });
    if (prog) prog.classList.add('hidden');
    renderReview();
  } catch (err) {
    if (prog) prog.classList.add('hidden');
    if (drop) drop.classList.remove('hidden');
    flash(err.message || 'Could not read that receipt. Try a clearer, flatter photo.');
  }
}
function startScan(file)        { return runScanPipeline(onp => processReceipt(file, onp)); }
function startScanCanvas(canvas) { return runScanPipeline(onp => processCanvas(canvas, onp)); }

/* ---------- In-app guided camera ---------- */
let cameraStream = null;
let lastCapture = null;   // holds a failed-quality frame for "use anyway"

async function openCamera() {
  // No camera API (desktop, blocked) -> fall back to the native picker.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const ci = document.getElementById('scan-cam'); if (ci) ci.click();
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'cam';
  overlay.id = 'cam';
  overlay.innerHTML = `
    <video id="cam-video" playsinline autoplay muted></video>
    <div class="cam-frame">
      <span class="c tl"></span><span class="c tr"></span>
      <span class="c bl"></span><span class="c br"></span>
    </div>
    <div class="cam-hint" id="cam-hint">Line the receipt up inside the frame — flat, good light</div>
    <button class="cam-anyway hidden" id="cam-anyway">Use photo anyway</button>
    <div class="cam-controls">
      <button class="cam-cancel" id="cam-cancel">Cancel</button>
      <button class="cam-shot" id="cam-shot" aria-label="Capture"></button>
      <span style="width:72px"></span>
    </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector('#cam-video');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = cameraStream;
  } catch (e) {
    closeCamera();
    const ci = document.getElementById('scan-cam'); if (ci) ci.click();  // permission denied -> picker
    return;
  }
  overlay.querySelector('#cam-cancel').addEventListener('click', closeCamera);
  overlay.querySelector('#cam-shot').addEventListener('click', () => captureFrame(video));
  overlay.querySelector('#cam-anyway').addEventListener('click', () => { if (lastCapture) proceedWithCapture(lastCapture); });
}

function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const o = document.getElementById('cam'); if (o) o.remove();
  lastCapture = null;
}

function captureFrame(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  // Crop the centered region matching the on-screen guide (removes background).
  const cw = Math.round(vw * 0.82), ch = Math.round(vh * 0.88);
  const cx = Math.round(vw * 0.09), cy = Math.round(vh * 0.04);
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);

  const q = assessQuality(canvas);
  const hint = document.getElementById('cam-hint');
  const anyway = document.getElementById('cam-anyway');
  if (!q.ok) {
    lastCapture = canvas;
    if (hint) { hint.textContent = '⚠ ' + q.reason + ' — tap the shutter to retake'; hint.classList.add('bad'); }
    if (anyway) anyway.classList.remove('hidden');
    return;
  }
  proceedWithCapture(canvas);
}

function proceedWithCapture(canvas) {
  applyGrayContrast(canvas);   // enhance for OCR
  closeCamera();
  startScanCanvas(canvas);
}

function renderReview() {
  const box = document.getElementById('scan-review');
  const r = scanResult;
  if (!r || !r.items.length) {
    box.innerHTML = `<div class="hint">I couldn't pick out any products from that photo.<br>Try a flatter, brighter shot — or add items manually.</div>`;
    return;
  }
  const langLabel = { de: 'German', sk: 'Slovak', unknown: 'Unknown' }[r.lang];
  const srcLabel = { 'pdf-text': 'read from PDF ✓', 'pdf-ocr': 'scanned PDF', 'ocr': 'photo', 'photo': 'photo' }[r.source] || '';

  box.innerHTML = `
    <div class="review-head">
      <div class="store-edit">
        <input id="rv-store" class="store-name" value="${esc(r.store.name)}" placeholder="Store name" autocomplete="off" />
        <div class="country-toggle" id="rv-country">
          <button data-c="AT" class="${r.store.country === 'AT' ? 'active' : ''}">🇦🇹 AT</button>
          <button data-c="SK" class="${r.store.country === 'SK' ? 'active' : ''}">🇸🇰 SK</button>
        </div>
      </div>
      <div class="li-meta">${langLabel} · ${srcLabel} · ${r.items.length} items found · tap an item to fix · edit store above</div>
    </div>
    <div id="review-rows">${r.items.map((it, i) => reviewRow(it, i)).join('')}</div>
    <button class="btn secondary" id="review-add" style="margin-bottom:12px">➕ Add a missed item</button>
    <button class="btn" id="review-save">Add checked items to pantry</button>
    <button class="btn secondary" id="review-cancel" style="margin-top:10px">Cancel</button>`;

  // editable store name
  const storeInput = box.querySelector('#rv-store');
  storeInput.addEventListener('input', () => { r.store.name = storeInput.value.trim() || 'Unknown store'; });
  // editable country
  box.querySelectorAll('#rv-country button').forEach(b =>
    b.addEventListener('click', () => {
      r.store.country = b.dataset.c;
      box.querySelectorAll('#rv-country button').forEach(x => x.classList.toggle('active', x === b));
    })
  );

  box.querySelectorAll('.rv-row').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.rv-check').addEventListener('click', () => { r.items[i].keep = !r.items[i].keep; renderReview(); });
    row.querySelector('.rv-name').addEventListener('click', () => editItem(i));
    row.querySelector('.rv-orig').addEventListener('click', () => editItem(i));
    row.querySelectorAll('.rv-chip').forEach(ch =>
      ch.addEventListener('click', (e) => { e.stopPropagation(); editQtyPrice(i, ch.dataset.edit); })
    );
  });
  box.querySelector('#review-add').addEventListener('click', addReviewItem);
  box.querySelector('#review-save').addEventListener('click', saveReview);
  box.querySelector('#review-cancel').addEventListener('click', () => { scanResult = null; renderScan(); });
}

/* Add a product the OCR missed, directly in the review screen. */
function addReviewItem() {
  const name = prompt('Product name (English):', '');
  if (name === null) return;
  const clean = name.trim();
  if (!clean) return;
  const match = CATALOG.find(c => c.en.toLowerCase() === clean.toLowerCase());
  scanResult.items.push({
    raw: clean, rawFolded: fold(clean),
    englishName: clean, cat: match ? match.cat : 'Other',
    confidence: 'high', price: null, qty: 1, keep: true,
  });
  renderReview();
}

/* Edit quantity or price of a review line. */
function editQtyPrice(i, field) {
  const it = scanResult.items[i];
  if (field === 'qty') {
    const v = prompt('Quantity:', it.qty || 1);
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) it.qty = n;
  } else {
    const v = prompt('Price in € (blank to clear):', it.price != null ? it.price : '');
    if (v === null) return;
    const t = v.trim().replace(',', '.');
    if (t === '') { it.price = null; }
    else { const p = parseFloat(t); if (!isNaN(p) && p >= 0) it.price = p; }
  }
  renderReview();
}

function reviewRow(it, i) {
  const conf = it.confidence;
  const confTag = conf === 'high' ? '' :
    conf === 'med' ? `<span class="conf med">guess</span>` :
                     `<span class="conf low">not sure</span>`;
  return `
    <div class="rv-row ${it.keep ? '' : 'off'} ${conf}" data-i="${i}">
      <div class="rv-check">${it.keep ? '✓' : ''}</div>
      <div class="rv-body">
        <div class="rv-name">${esc(it.englishName)} ${confTag}</div>
        <div class="rv-orig">“${esc(it.raw)}”</div>
        <div class="rv-edits">
          <button class="rv-chip" data-edit="qty">×${it.qty || 1}</button>
          <button class="rv-chip" data-edit="price">${it.price != null ? '€' + it.price.toFixed(2) : '€ —'}</button>
        </div>
      </div>
    </div>`;
}

function editItem(i) {
  const it = scanResult.items[i];
  const msg = it.confidence === 'high'
    ? `Is this “${it.englishName}”?`
    : `I think “${it.raw}” is “${it.englishName}”. Correct?`;
  showModal(msg, [
    { label: 'Yes ✓', kind: 'btn', fn: () => { hideModal(); learnAlias(it.rawFolded, it.englishName); it.confidence = 'high'; renderReview(); } },
    { label: 'No — rename', kind: 'secondary', fn: () => { hideModal(); renameItem(i); } },
  ]);
}
function renameItem(i) {
  const it = scanResult.items[i];
  const val = prompt('What is this product? (English)', it.englishName);
  if (val && val.trim()) {
    it.englishName = val.trim();
    const match = CATALOG.find(c => c.en.toLowerCase() === it.englishName.toLowerCase());
    it.cat = match ? match.cat : 'Other';
    it.confidence = 'high';
    learnAlias(it.rawFolded, it.englishName);
  }
  renderReview();
}

function saveReview() {
  const kept = scanResult.items.filter(it => it.keep);
  if (!kept.length) return flash('Nothing checked to add.');
  const snap = snapshotState();
  kept.forEach(it => {
    upsertPantry(it.englishName, it.raw, it.cat, scanResult.date);
    logPurchase(it.englishName, it.cat, it.price, it.qty, scanResult.date, scanResult.store);
    // Auto-learn: remember this raw-text -> English mapping so the SAME item on
    // a future receipt is recognised instantly (no re-guessing), even if the
    // user didn't tap to confirm it explicitly.
    if (it.rawFolded && it.englishName) learnAlias(it.rawFolded, it.englishName);
  });
  save();
  const n = kept.length;
  scanResult = null;
  switchView('pantry');
  toast(`Added ${n} item${n > 1 ? 's' : ''} ✓`, { undo: () => restoreSnapshot(snap) });
}

/* ---------- Shopping list ---------- */
let listGroup = false;   // false = flat, true = grouped by category

function renderList() {
  const el = document.getElementById('view');
  const catOf = id => { const p = state.pantry.find(x => x.id === id); return p ? (p.cat || 'Other') : 'Other'; };
  const fromPantry = state.pantry
    .filter(p => p.status !== 'ok')
    .map(p => ({ id: p.id, name: p.name, meta: STATUS_LABEL[p.status], reason: 'auto', done: false, cat: p.cat || 'Other' }));
  const extras = state.listExtras.map(e => ({ ...e, cat: e.cat || 'Other' }));
  const items = [...fromPantry, ...extras];
  const suggested = predictedLowItems();   // predicted low, not yet on the list

  if (!items.length && !suggested.length) {
    el.innerHTML = `<div class="hint">Nothing to buy 🎉<br>Items you mark <b>low</b> or <b>out</b> show up here automatically.</div>`;
    return;
  }

  let html = '';
  if (items.length) {
    html += `<div class="list-head">
        <div class="section-title" style="margin:0">Shopping list · ${items.length}</div>
        <button class="list-group-toggle" id="list-group">${listGroup ? '☰ Flat' : '🗂 By category'}</button>
      </div>`;
    if (listGroup) {
      const groups = {};
      items.forEach(it => { (groups[it.cat] = groups[it.cat] || []).push(it); });
      html += Object.keys(groups).sort().map(c =>
        `<div class="cat-head">${esc(c)}</div>${groups[c].map(listItemHTML).join('')}`
      ).join('');
    } else {
      html += items.map(listItemHTML).join('');
    }
    html += `<button class="btn secondary" id="clear-bought" style="margin:8px 0 18px">Clear checked items</button>`;
  }
  if (suggested.length) {
    html += `<div class="section-title">📉 Suggested — you may be running low</div>
      ${suggested.map(suggestRow).join('')}`;
  }
  el.innerHTML = html;

  el.querySelectorAll('.list-item').forEach(li =>
    li.addEventListener('click', () => toggleBought(li.dataset.id, li.dataset.reason))
  );
  el.querySelectorAll('.suggest-row').forEach(li =>
    li.addEventListener('click', () => addSuggested(li.dataset.id))
  );
  const cb = el.querySelector('#clear-bought');
  if (cb) cb.addEventListener('click', clearBought);
  const gt = el.querySelector('#list-group');
  if (gt) gt.addEventListener('click', () => { listGroup = !listGroup; renderList(); });
}
function suggestRow(p) {
  return `
    <div class="list-item suggest-row" data-id="${p.id}">
      <div class="check">+</div>
      <div class="li-body">
        <div class="li-name">${esc(p.name)}</div>
        <div class="li-meta">tap to add to list</div>
      </div>
      <span class="tag">predicted</span>
    </div>`;
}
/* Accepting a suggestion = mark that pantry item 'low' so it joins the real list */
function addSuggested(id) {
  const p = state.pantry.find(x => x.id === id);
  if (p) { p.status = 'low'; save(); renderList(); }
}
function listItemHTML(it) {
  return `
    <div class="list-item ${it.done ? 'done' : ''}" data-id="${it.id}" data-reason="${it.reason}">
      <div class="check">${it.done ? '✓' : ''}</div>
      <div class="li-body">
        <div class="li-name">${esc(it.name)}</div>
        <div class="li-meta">${esc(it.meta || '')}</div>
      </div>
      <span class="tag ${it.reason === 'manual' ? 'manual' : ''}">${it.reason === 'manual' ? 'added' : 'low stock'}</span>
    </div>`;
}
function toggleBought(id, reason) {
  const snap = snapshotState();
  let label = '';
  if (reason === 'manual') {
    const it = state.listExtras.find(e => e.id === id);
    if (it) { it.done = !it.done; label = it.name; }
  } else {
    const p = state.pantry.find(x => x.id === id);
    if (p) { p.status = p.status === 'ok' ? 'low' : 'ok'; label = p.name; }
  }
  save();
  renderList();
  toast(label ? `Updated “${label}”` : 'Updated', { undo: () => restoreSnapshot(snap) });
}
function clearBought() {
  const snap = snapshotState();
  const before = state.listExtras.length;
  state.listExtras = state.listExtras.filter(e => !e.done);
  const removed = before - state.listExtras.length;
  save();
  renderList();
  if (removed) toast(`Cleared ${removed} item${removed > 1 ? 's' : ''}`, { undo: () => restoreSnapshot(snap) });
}

/* ---------- Add ---------- */
function renderAdd() {
  const el = document.getElementById('view');
  el.innerHTML = `
    <div class="section-title">Add an item</div>
    <div class="field">
      <label>Name (English)</label>
      <input id="f-name" placeholder="e.g. Yogurt" autocomplete="off" />
    </div>
    <div class="field">
      <label>Original name on receipt (optional)</label>
      <input id="f-orig" placeholder="e.g. Jogurt / Joghurt" autocomplete="off" />
    </div>
    <div class="field">
      <label>Category</label>
      <select id="f-cat">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label>Starting status</label>
      <select id="f-status">
        <option value="ok">In stock</option>
        <option value="low">Running low</option>
        <option value="out">Out (add to list)</option>
      </select>
    </div>
    <button class="btn" id="f-save">Add to pantry</button>
    <button class="btn secondary" id="f-quicklist" style="margin-top:10px">Just add to shopping list</button>

    <div class="danger-zone">
      <div class="section-title" style="color:var(--red)">Danger zone</div>
      <div class="li-meta" style="margin:0 2px 12px">These clear data on <b>all devices</b> (it syncs). Learned product names are kept.</div>
      <button class="btn danger-outline" id="f-reset-purchases">Clear purchase history &amp; spending</button>
      <button class="btn danger" id="f-reset-all" style="margin-top:10px">🧨 Reset everything (start fresh)</button>
    </div>`;

  el.querySelector('#f-save').addEventListener('click', addToPantry);
  el.querySelector('#f-quicklist').addEventListener('click', addToListOnly);
  el.querySelector('#f-reset-purchases').addEventListener('click', confirmResetPurchases);
  el.querySelector('#f-reset-all').addEventListener('click', confirmResetAll);
}

/* ---------- Reset / nuke (double-confirmed) ---------- */
function confirmResetPurchases() {
  const n = (state.purchases || []).length;
  showModal(`Clear all purchase history (${n} record${n !== 1 ? 's' : ''})? This wipes spending insights and prediction data, but keeps your pantry and shopping list.`, [
    { label: 'Clear history', kind: 'btn', fn: () => {
        state.purchases = [];
        save(); hideModal();
        flash('Purchase history cleared.');
      } },
    { label: 'Cancel', kind: 'secondary', fn: hideModal },
  ]);
}
function confirmResetAll() {
  showModal('🧨 Reset EVERYTHING — pantry, shopping list, purchase history & spending — on all devices? This cannot be undone.', [
    { label: 'Yes, wipe it all', kind: 'btn', fn: confirmResetAll2 },
    { label: 'Cancel', kind: 'secondary', fn: hideModal },
  ]);
}
function confirmResetAll2() {
  // second confirmation — this is destructive & syncs to the other phone
  showModal('Are you absolutely sure? Both your and your wife\u2019s app will be emptied. (Learned product names are kept so scanning stays smart.)', [
    { label: 'Reset now', kind: 'btn', fn: () => {
        const keepAliases = state.aliases || {};
        state.pantry = [];
        state.listExtras = [];
        state.purchases = [];
        state.aliases = keepAliases;      // keep learned names — scanning stays smart
        save(); hideModal();
        switchView('pantry');
        flash('Tally has been reset. Fresh start ✓');
      } },
    { label: 'Cancel', kind: 'secondary', fn: hideModal },
  ]);
}
function addToPantry() {
  const name = val('f-name');
  if (!name) return flash('Give it a name first.');
  const cat = val('f-cat');
  state.pantry.push({ id: uid(), name, orig: val('f-orig'), cat, status: val('f-status'), expiry: estimateExpiry(cat, null) });
  logPurchase(name, cat, null, 1, null, null);   // manual add counts as a purchase today
  save();
  switchView('pantry');
}
function addToListOnly() {
  const name = val('f-name');
  if (!name) return flash('Give it a name first.');
  const cat = val('f-cat');
  state.listExtras.push({ id: uid(), name, meta: 'added manually', reason: 'manual', done: false, cat });
  save();
  switchView('list');
}

/* ---------- Cook (v3.0) ---------- */
let cookState = { selected: null, results: [], loading: false, progress: '', mode: 'kitchen', error: '' };

/* Auto-seed the ingredient set: expiring items first, then other in-stock. */
function seedCookSelection() {
  const expiring = [], inStock = [];
  state.pantry.forEach(p => {
    if (p.status === 'out') return;               // don't cook around things you don't have
    const e = expiryInfo(p);
    if (e && (e.state === 'soon' || e.state === 'expired')) expiring.push(p.name);
    else inStock.push(p.name);
  });
  const sel = [...expiring];
  for (const n of inStock) { if (sel.length >= 5) break; if (!sel.includes(n)) sel.push(n); }
  return sel.slice(0, 6);
}

/* Items you seem to have plenty of (bought often) — offered as add-suggestions. */
function excessSuggestions(exclude) {
  const counts = {};
  (state.purchases || []).forEach(p => { counts[p.name] = (counts[p.name] || 0) + 1; });
  const inPantry = new Set(state.pantry.filter(p => p.status !== 'out').map(p => p.name));
  return Object.entries(counts)
    .filter(([n, c]) => c >= 2 && inPantry.has(n) && !exclude.includes(n))
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
}

function renderCook() {
  const el = document.getElementById('view');
  if (cookState.selected === null) cookState.selected = seedCookSelection();
  const sel = cookState.selected;
  const suggestions = excessSuggestions(sel);

  el.innerHTML = `
    <div class="section-title">Cook from your kitchen</div>
    <div class="cook-intro">Recipes are matched to what you have — items expiring soon are prioritised.</div>
    <div class="cook-chips" id="cook-chips">
      ${sel.map(n => `<span class="cook-chip" data-name="${esc(n)}">${esc(n)} <b class="x">✕</b></span>`).join('')}
      <button class="cook-add" id="cook-add">+ add</button>
    </div>
    ${suggestions.length ? `<div class="cook-sugg">Plenty of: ${suggestions.map(n => `<button class="sugg-pill" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
    <button class="btn" id="cook-find" ${sel.length ? '' : 'disabled'}>🍳 Find recipes</button>
    <button class="btn secondary" id="cook-explore" style="margin-top:10px">🔎 Explore recipes</button>
    <div class="cook-diet-bar">${dietSummary()}<button class="cook-diet-btn" id="cook-diet">Diet filters</button></div>
    <div class="cook-nav">
      <button class="btn secondary" id="cook-saved" style="flex:1">❤ Saved${state.saved && state.saved.length ? ' (' + state.saved.length + ')' : ''}</button>
      <button class="btn secondary" id="cook-plan" style="flex:1">📅 Meal plan</button>
    </div>
    <div id="cook-results" style="margin-top:16px"></div>`;

  // chip removal
  el.querySelectorAll('.cook-chip').forEach(c =>
    c.addEventListener('click', () => {
      cookState.selected = cookState.selected.filter(n => n !== c.dataset.name);
      renderCook();
    })
  );
  // add from pantry
  el.querySelector('#cook-add').addEventListener('click', cookAddIngredient);
  // excess suggestions
  el.querySelectorAll('.sugg-pill').forEach(b =>
    b.addEventListener('click', () => {
      if (!cookState.selected.includes(b.dataset.name)) cookState.selected.push(b.dataset.name);
      renderCook();
    })
  );
  el.querySelector('#cook-find').addEventListener('click', runFindRecipes);
  el.querySelector('#cook-explore').addEventListener('click', renderExplore);
  el.querySelector('#cook-saved').addEventListener('click', renderSaved);
  el.querySelector('#cook-plan').addEventListener('click', renderMealPlan);
  el.querySelector('#cook-diet').addEventListener('click', openDietModal);

  // restore any previous results
  if (cookState.loading) {
    document.getElementById('cook-results').innerHTML = `<div class="scan-progress"><div class="spinner"></div><div id="cook-status">${esc(cookState.progress || 'Finding recipes...')}</div></div>`;
  } else if (cookState.error) {
    document.getElementById('cook-results').innerHTML = `<div class="hint">${esc(cookState.error)}</div>`;
  } else if (cookState.results.length) {
    renderRecipeCards(cookState.results);
  }
}

/* v3.2: current diet filters as a short label. */
function dietSummary() {
  const d = state.diet || {};
  const labels = [];
  (d.presets || []).forEach(k => { if (DIET_PRESETS[k]) labels.push(DIET_PRESETS[k].label.replace(/^No /, 'no ')); });
  (d.custom || []).forEach(w => labels.push('no ' + w));
  return labels.length
    ? `<span class="cook-diet-active">${esc(labels.join(', '))}</span>`
    : `<span class="cook-diet-none">No diet filters</span>`;
}

/* v3.2: action-sheet to toggle diet/allergen presets + custom avoids. */
function openDietModal() {
  const d = state.diet || (state.diet = { presets: [], custom: [] });
  d.presets = d.presets || []; d.custom = d.custom || [];
  const actions = Object.keys(DIET_PRESETS).map(k => ({
    label: (d.presets.includes(k) ? '[x] ' : '[  ] ') + DIET_PRESETS[k].label,
    kind: 'secondary',
    fn: () => {
      const i = d.presets.indexOf(k);
      if (i >= 0) d.presets.splice(i, 1); else d.presets.push(k);
      save(); openDietModal();
    },
  }));
  d.custom.forEach(w => actions.push({
    label: '[x] no ' + w + '  (tap to remove)',
    kind: 'secondary',
    fn: () => { d.custom = d.custom.filter(x => x !== w); save(); openDietModal(); },
  }));
  actions.push({
    label: '+ add custom ingredient',
    kind: 'secondary',
    fn: () => {
      const w = prompt('Ingredient to always avoid (e.g. cilantro):', '');
      if (w && w.trim()) { const t = w.trim().toLowerCase(); if (!d.custom.includes(t)) d.custom.push(t); save(); }
      openDietModal();
    },
  });
  if (d.presets.length || d.custom.length) actions.push({
    label: 'Clear all diet filters',
    kind: 'secondary',
    fn: () => { d.presets = []; d.custom = []; save(); openDietModal(); },
  });
  actions.push({ label: 'Done', kind: 'btn', fn: () => { hideModal(); renderCook(); } });
  showModal('Never suggest recipes with:', actions);
}

function cookAddIngredient() {
  const inStock = state.pantry.filter(p => p.status !== 'out').map(p => p.name)
    .filter(n => !cookState.selected.includes(n));
  if (!inStock.length) return flash('No more pantry items to add.');
  const actions = inStock.slice(0, 20).map(n => ({
    label: n, kind: 'secondary',
    fn: () => { cookState.selected.push(n); hideModal(); renderCook(); },
  }));
  actions.push({ label: 'Cancel', kind: 'secondary', fn: hideModal });
  showModal('Add an ingredient to cook with:', actions);
}

async function runFindRecipes() {
  cookState.loading = true; cookState.error = ''; cookState.results = [];
  renderCook();
  const status = () => document.getElementById('cook-status');
  try {
    const results = await findRecipes(cookState.selected, msg => {
      cookState.progress = msg; const s = status(); if (s) s.textContent = msg;
    });
    cookState.loading = false;
    cookState.results = results;
    if (!results.length) cookState.error = 'No recipes found for those ingredients. Try different or fewer items.';
    renderCook();
  } catch (e) {
    cookState.loading = false;
    cookState.error = 'Couldn’t reach the recipe service. Check your connection and try again.';
    renderCook();
  }
}

function renderRecipeCards(results) {
  const box = document.getElementById('cook-results');
  if (!box) return;
  box.innerHTML = results.map((r, i) => {
    const canMake = r.missing.length === 0;
    const badge = canMake
      ? `<span class="rc-badge ok">You can make this</span>`
      : `<span class="rc-badge">missing ${r.missing.length}</span>`;
    const subNote = r.sub.length ? `<span class="rc-badge sub">${r.sub.length} substitutable</span>` : '';
    return `
      <div class="recipe-card" data-i="${i}">
        <div class="rc-thumb" style="background-image:url('${esc(r.meal.strMealThumb)}')"></div>
        <div class="rc-body">
          <div class="rc-title">${esc(r.meal.strMeal)}</div>
          <div class="rc-meta">${esc(r.meal.strArea || '')}${r.meal.strCategory ? ' · ' + esc(r.meal.strCategory) : ''}</div>
          <div class="rc-badges">${badge} ${subNote} <span class="rc-uses">uses ${r.usesSelected} of yours</span></div>
        </div>
      </div>`;
  }).join('');
  box.querySelectorAll('.recipe-card').forEach(c =>
    c.addEventListener('click', () => openRecipe(results[+c.dataset.i]))
  );
}

/* Recipe detail — full-screen overlay */
function openRecipe(r) {
  const meal = r.meal;
  const ingRows = [
    ...r.have.map(ig => `<div class="ir have">✅ ${esc(ig.name)} <span class="ir-m">${esc(ig.measure)}</span></div>`),
    ...r.sub.map(ig => `<div class="ir sub">🔁 ${esc(ig.name)} <span class="ir-m">${esc(ig.measure)}</span><div class="ir-sub">use your ${esc(ig.subWith)}</div></div>`),
    ...r.missing.map(ig => `<div class="ir miss">❌ ${esc(ig.name)} <span class="ir-m">${esc(ig.measure)}</span></div>`),
  ].join('');

  const ov = document.createElement('div');
  ov.className = 'recipe-detail';
  ov.id = 'recipe-detail';
  ov.innerHTML = `
    <div class="rd-hero" style="background-image:url('${esc(meal.strMealThumb)}')">
      <button class="rd-close" id="rd-close">✕</button>
      <button class="rd-save ${isSaved(meal) ? 'on' : ''}" id="rd-save">${isSaved(meal) ? '❤ Saved' : '🤍 Save'}</button>
    </div>
    <div class="rd-body">
      <h2 class="rd-title">${esc(meal.strMeal)}</h2>
      <div class="rc-meta">${esc(meal.strArea || '')}${meal.strCategory ? ' · ' + esc(meal.strCategory) : ''}</div>
      <div class="rd-section">Ingredients (${r.have.length}/${r.total} you have${r.sub.length ? ', ' + r.sub.length + ' substitutable' : ''})</div>
      <div class="rd-ings">${ingRows}</div>
      ${r.missing.length ? `<button class="btn" id="rd-addlist">➕ Add ${r.missing.length} missing to shopping list</button>` : `<div class="rd-canmake">✅ You have everything you need!</div>`}
      <div class="rd-section">Method</div>
      <div class="rd-steps">${esc(meal.strInstructions || '').split(/\r?\n/).filter(s => s.trim()).map(s => `<p>${esc(s)}</p>`).join('')}</div>
      ${meal.strYoutube ? `<a class="btn secondary" href="${esc(meal.strYoutube)}" target="_blank" rel="noopener">▶ Watch on YouTube</a>` : ''}
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#rd-close').addEventListener('click', () => ov.remove());
  const addBtn = ov.querySelector('#rd-addlist');
  if (addBtn) addBtn.addEventListener('click', () => { addMissingToList(r); ov.remove(); });
  const saveBtn = ov.querySelector('#rd-save');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    toggleSaveRecipe(meal);
    const on = isSaved(meal);
    saveBtn.classList.toggle('on', on);
    saveBtn.textContent = on ? '❤ Saved' : '🤍 Save';
  });
}

/* ---------- Saved recipes (v3.1) ---------- */
function isSaved(meal) { return (state.saved || []).some(s => s.id === meal.idMeal); }
function toggleSaveRecipe(meal) {
  state.saved = state.saved || [];
  if (isSaved(meal)) {
    state.saved = state.saved.filter(s => s.id !== meal.idMeal);
    save();
    toast('Removed from saved');
  } else {
    // store a compact copy (enough to re-open + re-score later)
    state.saved.push({ id: meal.idMeal, meal: meal, savedAt: Date.now() });
    save();
    toast('Recipe saved ❤');
  }
}

/* Add a recipe's missing ingredients to the shopping list. */
function addMissingToList(r) {
  const snap = snapshotState();
  let added = 0;
  r.missing.forEach(ig => {
    const name = ig.name.trim();
    const exists = state.listExtras.some(e => e.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      const match = CATALOG.find(c => c.en.toLowerCase() === name.toLowerCase());
      state.listExtras.push({ id: uid(), name, meta: 'for ' + r.meal.strMeal, reason: 'manual', done: false, cat: match ? match.cat : 'Other' });
      added++;
    }
  });
  save();
  toast(added ? `Added ${added} item${added > 1 ? 's' : ''} to list` : 'Already on your list', added ? { undo: () => restoreSnapshot(snap) } : {});
}

/* Explore: search by name + random */
function renderExplore() {
  cookState.mode = 'explore';
  const el = document.getElementById('view');
  el.innerHTML = `
    <div class="section-title">Explore recipes</div>
    <div class="pantry-tools">
      <input id="explore-q" class="pantry-search" placeholder="🔎 Search recipes by name..." autocomplete="off" />
    </div>
    <button class="btn secondary" id="explore-random">🎲 Surprise me</button>
    <button class="btn secondary" id="explore-back" style="margin-top:10px">← Back to your kitchen</button>
    <div id="explore-results" style="margin-top:16px"></div>`;
  const q = el.querySelector('#explore-q');
  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = q.value.trim();
      if (term.length < 2) return;
      const box = document.getElementById('explore-results');
      box.innerHTML = `<div class="scan-progress"><div class="spinner"></div><div>Searching...</div></div>`;
      try {
        const meals = await searchRecipes(term);
        showExploreMeals(meals);
      } catch (e) { box.innerHTML = `<div class="hint">Couldn’t reach the recipe service.</div>`; }
    }, 450);
  });
  el.querySelector('#explore-random').addEventListener('click', async () => {
    const box = document.getElementById('explore-results');
    box.innerHTML = `<div class="scan-progress"><div class="spinner"></div><div>Finding a recipe...</div></div>`;
    try { const m = await randomRecipe(); showExploreMeals(m ? [m] : []); }
    catch (e) { box.innerHTML = `<div class="hint">Couldn’t reach the recipe service.</div>`; }
  });
  el.querySelector('#explore-back').addEventListener('click', () => { cookState.mode = 'kitchen'; renderCook(); });
}

function showExploreMeals(meals) {
  const box = document.getElementById('explore-results');
  if (!box) return;
  if (!meals.length) { box.innerHTML = `<div class="hint">No recipes found.</div>`; return; }
  const allowed = meals.filter(meal => !mealViolatesDiet(meal));
  if (!allowed.length) { box.innerHTML = `<div class="hint">All matches are filtered out by your diet settings. Adjust them under Cook.</div>`; return; }
  const pantrySet = pantryCanonicalSet();
  const scored = allowed.map(meal => ({ meal, ...classifyMeal(meal, pantrySet, null) }));
  renderExploreCards(scored, box);
}
function renderExploreCards(results, box) {
  box.innerHTML = results.map((r, i) => `
    <div class="recipe-card" data-i="${i}">
      <div class="rc-thumb" style="background-image:url('${esc(r.meal.strMealThumb)}')"></div>
      <div class="rc-body">
        <div class="rc-title">${esc(r.meal.strMeal)}</div>
        <div class="rc-meta">${esc(r.meal.strArea || '')}${r.meal.strCategory ? ' · ' + esc(r.meal.strCategory) : ''}</div>
        <div class="rc-badges">${r.missing.length === 0 ? `<span class="rc-badge ok">You can make this</span>` : `<span class="rc-badge">have ${r.have.length}/${r.total}</span>`}</div>
      </div>
    </div>`).join('');
  box.querySelectorAll('.recipe-card').forEach(c =>
    c.addEventListener('click', () => openRecipe(results[+c.dataset.i]))
  );
}

/* ---------- Saved recipes view (v3.1) ---------- */
function renderSaved() {
  const el = document.getElementById('view');
  const saved = state.saved || [];
  el.innerHTML = `
    <div class="section-title">❤ Saved recipes</div>
    <button class="btn secondary" id="saved-back" style="margin-bottom:14px">← Back to Cook</button>
    <div id="saved-results"></div>`;
  el.querySelector('#saved-back').addEventListener('click', renderCook);
  const box = el.querySelector('#saved-results');
  if (!saved.length) { box.innerHTML = `<div class="hint">No saved recipes yet.<br>Open a recipe and tap 🤍 Save to keep it here.</div>`; return; }
  const scored = saved.map(s => scoreMeal(s.meal));
  renderExploreCards(scored, box);
}

/* ---------- Weekly meal plan + "inspired by" cuisine (v3.1) ---------- */
const PLAN_DAYS = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];
let cuisineList = null;

async function renderMealPlan() {
  const el = document.getElementById('view');
  const plan = state.mealPlan || {};
  el.innerHTML = `
    <div class="section-title">📅 Weekly meal plan</div>
    <button class="btn secondary" id="plan-back" style="margin-bottom:12px">← Back to Cook</button>
    <details class="plan-inspire">
      <summary>✨ Inspired by a cuisine <span class="plan-inspire-hint">— generate a themed week</span></summary>
      <div class="plan-cuisines" id="plan-cuisines"><span class="li-meta">Loading cuisines...</span></div>
    </details>`
    + (state.prefs && state.prefs.lastCuisine ? `<div class="li-meta" style="margin:-8px 2px 12px">Last used: ${esc(state.prefs.lastCuisine)}</div>` : '') + `
    <div id="plan-days"></div>
    <button class="btn" id="plan-buildlist" style="margin-top:14px">🛒 Build this week's shopping list</button>
    <button class="btn secondary" id="plan-clear" style="margin-top:10px">Clear plan</button>`;

  el.querySelector('#plan-back').addEventListener('click', renderCook);
  el.querySelector('#plan-clear').addEventListener('click', () => {
    showModal('Clear the whole weekly plan?', [
      { label: 'Clear', kind: 'btn', fn: () => { state.mealPlan = {}; save(); hideModal(); renderMealPlan(); } },
      { label: 'Cancel', kind: 'secondary', fn: hideModal },
    ]);
  });
  el.querySelector('#plan-buildlist').addEventListener('click', buildWeekList);

  renderPlanDays();
  loadCuisineChips();
}

function renderPlanDays() {
  const box = document.getElementById('plan-days');
  if (!box) return;
  const plan = state.mealPlan || {};
  box.innerHTML = PLAN_DAYS.map(([k, label]) => {
    const m = plan[k];
    return `
      <div class="plan-day">
        <div class="plan-daylabel">${label}</div>
        ${m ? `
          <div class="plan-meal" data-day="${k}">
            <div class="plan-thumb" style="background-image:url('${esc(m.strMealThumb)}')"></div>
            <div class="plan-name">${esc(m.strMeal)}</div>
            <button class="plan-x" data-clear="${k}">✕</button>
          </div>`
          : `<div class="plan-empty" data-day="${k}">+ add a recipe</div>`}
      </div>`;
  }).join('');
  // open assigned meal
  box.querySelectorAll('.plan-meal').forEach(pm =>
    pm.addEventListener('click', (e) => {
      if (e.target.classList.contains('plan-x')) return;
      const m = state.mealPlan[pm.dataset.day]; if (m) openRecipe(scoreMeal(m));
    })
  );
  box.querySelectorAll('.plan-x').forEach(x =>
    x.addEventListener('click', (e) => { e.stopPropagation(); delete state.mealPlan[x.dataset.clear]; save(); renderPlanDays(); })
  );
  // assign to empty day -> pick from saved or explore
  box.querySelectorAll('.plan-empty').forEach(pe =>
    pe.addEventListener('click', () => assignDay(pe.dataset.day))
  );
}

/* Assign a day: search any recipe, surprise, or pick from saved. */
function assignDay(day) {
  const saved = state.saved || [];
  const actions = [
    { label: '🔎 Search a recipe', kind: 'btn', fn: () => { hideModal(); assignBySearch(day); } },
    { label: '🎲 Surprise me', kind: 'secondary', fn: async () => {
      hideModal();
      try { const m = await randomRecipe(); if (m) { state.mealPlan[day] = m; save(); renderPlanDays(); toast('Added ' + m.strMeal); } }
      catch (e) { flash('Couldn’t reach the recipe service.'); }
    } },
  ];
  // quick-pick from saved (if any)
  saved.slice(0, 10).forEach(s => actions.push({
    label: '❤ ' + s.meal.strMeal, kind: 'secondary',
    fn: () => { state.mealPlan[day] = s.meal; save(); hideModal(); renderPlanDays(); },
  }));
  actions.push({ label: 'Cancel', kind: 'secondary', fn: hideModal });
  showModal('Add a recipe to this day:', actions);
}

/* Search by name, then pick a result to assign to the day. */
function assignBySearch(day) {
  const term = prompt('Search recipes by name:', '');
  if (term === null) return;
  const q = term.trim();
  if (q.length < 2) return;
  searchRecipes(q).then(meals => {
    if (!meals.length) return flash('No recipes found for “' + q + '”.');
    const actions = meals.slice(0, 12).map(m => ({
      label: m.strMeal, kind: 'secondary',
      fn: () => { state.mealPlan[day] = m; save(); hideModal(); renderPlanDays(); toast('Added ' + m.strMeal); },
    }));
    actions.push({ label: 'Cancel', kind: 'secondary', fn: hideModal });
    showModal('Pick a recipe:', actions);
  }).catch(() => flash('Couldn’t reach the recipe service.'));
}

/* Load cuisine chips once, wire "inspired by" generation. */
async function loadCuisineChips() {
  const box = document.getElementById('plan-cuisines');
  if (!box) return;
  try {
    if (!cuisineList) cuisineList = await listCuisines();
  } catch (e) { box.innerHTML = `<span class="li-meta">Couldn’t load cuisines.</span>`; return; }
  const popular = ['Mexican', 'Italian', 'Chinese', 'Thai', 'Indian', 'Japanese', 'Greek', 'French', 'Spanish', 'American'];
  const list = cuisineList.filter(c => popular.includes(c)).concat(cuisineList.filter(c => !popular.includes(c)));
  box.innerHTML = list.map(c => `<button class="cuisine-pill" data-area="${esc(c)}">${esc(c)}</button>`).join('');
  box.querySelectorAll('.cuisine-pill').forEach(b =>
    b.addEventListener('click', () => generateInspiredWeek(b.dataset.area))
  );
}

/* Generate a 7-day plan themed around a cuisine. */
async function generateInspiredWeek(area) {
  const daysBox = document.getElementById('plan-days');
  if (daysBox) daysBox.innerHTML = `<div class="scan-progress"><div class="spinner"></div><div>Cooking up a ${esc(area)} week...</div></div>`;
  try {
    const meals = await recipesByCuisine(area, 7);
    if (!meals.length) { flash('No recipes found for ' + area + '.'); renderPlanDays(); return; }
    state.mealPlan = {};
    PLAN_DAYS.forEach(([k], i) => { if (meals[i]) state.mealPlan[k] = meals[i]; });
    state.prefs = state.prefs || {}; state.prefs.lastCuisine = area;
    save();
    renderPlanDays();
    toast(`${area} week ready ✨`);
  } catch (e) {
    flash('Couldn’t reach the recipe service.');
    renderPlanDays();
  }
}

/* Everything the week's recipes need, minus what's in the pantry -> shopping list. */
function buildWeekList() {
  const plan = state.mealPlan || {};
  const meals = Object.values(plan);
  if (!meals.length) return flash('Your meal plan is empty. Add some recipes first.');
  const snap = snapshotState();
  const pantrySet = pantryCanonicalSet();
  let added = 0;
  meals.forEach(meal => {
    const r = classifyMeal(meal, pantrySet, null);
    r.missing.forEach(ig => {
      const name = ig.name.trim();
      if (!state.listExtras.some(e => e.name.toLowerCase() === name.toLowerCase())) {
        const match = CATALOG.find(c => c.en.toLowerCase() === name.toLowerCase());
        state.listExtras.push({ id: uid(), name, meta: 'for ' + meal.strMeal, reason: 'manual', done: false, cat: match ? match.cat : 'Other' });
        added++;
      }
    });
  });
  save();
  if (added) toast(`Added ${added} items to your list`, { undo: () => restoreSnapshot(snap) });
  else toast('You already have everything for the week 🎉');
}

/* ---------- Insights (v2.3) ---------- */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function money(n) { return '€' + (n || 0).toFixed(2); }
function monthKey(d) { const dt = new Date(d); return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0'); }
function monthLabel(key) { const [y, m] = key.split('-'); return MONTH_NAMES[(+m) - 1] + ' ' + y.slice(2); }

/* v3.2 Insights v2: toggle the spend chart between month and week. */
let insightsMode = 'month'; // 'month' | 'week'
function weekKey(d) {
  const dt = new Date(d);
  const day = (dt.getUTCDay() + 6) % 7;            // Mon=0 .. Sun=6
  dt.setUTCDate(dt.getUTCDate() - day + 3);        // Thursday of this ISO week
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return dt.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function weekLabel(key) { const [y, w] = key.split('-W'); return 'W' + (+w) + " '" + y.slice(2); }

function renderInsights() {
  const el = document.getElementById('view');
  const purchases = (state.purchases || []).filter(p => typeof p.price === 'number' && p.price > 0);

  if (!purchases.length) {
    el.innerHTML = `<div class="hint">No spending data yet 📊<br>Scan a few receipts and your spending insights will appear here — monthly totals, Austria vs Slovakia, and price history.</div>`;
    return;
  }

  // ---- This month ----
  const nowKey = monthKey(new Date());
  const thisMonth = purchases.filter(p => monthKey(p.date) === nowKey);
  const thisMonthTotal = thisMonth.reduce((s, p) => s + p.price * (p.qty || 1), 0);

  // ---- Monthly spend (last 6 months) ----
  const byMonth = {};
  purchases.forEach(p => { const k = monthKey(p.date); byMonth[k] = (byMonth[k] || 0) + p.price * (p.qty || 1); });
  const months = Object.keys(byMonth).sort().slice(-6);
  const maxMonth = Math.max(...months.map(k => byMonth[k]), 0.01);

  // ---- Weekly spend (last 8 weeks) ----
  const byWeek = {};
  purchases.forEach(p => { const k = weekKey(p.date); byWeek[k] = (byWeek[k] || 0) + p.price * (p.qty || 1); });
  const weeks = Object.keys(byWeek).sort().slice(-8);
  const maxWeek = Math.max(...weeks.map(k => byWeek[k]), 0.01);

  // ---- Active spend series (month|week toggle) ----
  const spendIsWeek = insightsMode === 'week';
  const spendKeys = spendIsWeek ? weeks : months;
  const spendMap  = spendIsWeek ? byWeek : byMonth;
  const spendMax  = spendIsWeek ? maxWeek : maxMonth;
  const spendLbl  = spendIsWeek ? weekLabel : monthLabel;

  // ---- Country split ----
  const byCountry = { AT: 0, SK: 0, '??': 0 };
  purchases.forEach(p => { const c = byCountry[p.country] !== undefined ? p.country : '??'; byCountry[c] += p.price * (p.qty || 1); });
  const totalAll = byCountry.AT + byCountry.SK + byCountry['??'];

  // ---- By store ----
  const byStore = {};
  purchases.forEach(p => { const s = p.store || 'Unknown'; byStore[s] = (byStore[s] || 0) + p.price * (p.qty || 1); });
  const stores = Object.entries(byStore).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxStore = Math.max(...stores.map(s => s[1]), 0.01);

  // ---- Top items (by total spend) + price range ----
  const byItem = {};
  purchases.forEach(p => {
    const k = p.name;
    if (!byItem[k]) byItem[k] = { total: 0, count: 0, min: p.price, max: p.price };
    byItem[k].total += p.price * (p.qty || 1);
    byItem[k].count += 1;
    byItem[k].min = Math.min(byItem[k].min, p.price);
    byItem[k].max = Math.max(byItem[k].max, p.price);
  });
  const topItems = Object.entries(byItem).sort((a, b) => b[1].total - a[1].total).slice(0, 8);

  // ---- Most bought (by count) ----
  const mostBought = Object.entries(byItem).sort((a, b) => b[1].count - a[1].count).slice(0, 8);

  // ---- Cheapest store per item (avg unit price; items sold in >1 store) ----
  const itemStore = {};
  purchases.forEach(p => {
    const st = p.store || 'Unknown';
    const perItem = (itemStore[p.name] = itemStore[p.name] || {});
    const bucket = (perItem[st] = perItem[st] || { sum: 0, count: 0 });
    bucket.sum += p.price; bucket.count += 1;
  });
  const cheapest = Object.entries(itemStore)
    .map(([name, storesMap]) => {
      const rows = Object.entries(storesMap)
        .map(([s, v]) => ({ store: s, avg: v.sum / v.count }))
        .sort((a, b) => a.avg - b.avg);
      return { name, best: rows[0], worst: rows[rows.length - 1], nStores: rows.length };
    })
    .filter(x => x.nStores > 1)
    .sort((a, b) => (b.worst.avg - b.best.avg) - (a.worst.avg - a.best.avg))
    .slice(0, 8);

  el.innerHTML = `
    <div class="section-title">This month</div>
    <div class="stat-card">
      <div class="stat-big">${money(thisMonthTotal)}</div>
      <div class="stat-sub">${monthLabel(nowKey)} · ${thisMonth.length} item${thisMonth.length !== 1 ? 's' : ''} · ${money(totalAll)} all-time</div>
    </div>

    <div class="section-title">${spendIsWeek ? 'Weekly spend' : 'Monthly spend'}
      <span style="float:right;font-size:12px;font-weight:400">
        <button id="ins-month" style="padding:2px 9px;border:1px solid rgba(128,128,128,.4);border-radius:8px 0 0 8px;cursor:pointer;${!spendIsWeek ? 'background:#3a7;color:#fff' : 'background:transparent;color:inherit'}">Month</button><button id="ins-week" style="padding:2px 9px;border:1px solid rgba(128,128,128,.4);border-left:none;border-radius:0 8px 8px 0;cursor:pointer;${spendIsWeek ? 'background:#3a7;color:#fff' : 'background:transparent;color:inherit'}">Week</button>
      </span>
    </div>
    <div class="chart">
      ${spendKeys.length ? spendKeys.map(k => barRow(spendLbl(k), spendMap[k], spendMax)).join('')
        : `<div class="li-meta" style="padding:8px">Not enough data yet.</div>`}
    </div>

    <div class="section-title">🇦🇹 Austria vs 🇸🇰 Slovakia</div>
    <div class="split">
      <div class="split-bar">
        <div class="seg at" style="width:${pct(byCountry.AT, totalAll)}%"></div>
        <div class="seg sk" style="width:${pct(byCountry.SK, totalAll)}%"></div>
        <div class="seg un" style="width:${pct(byCountry['??'], totalAll)}%"></div>
      </div>
      <div class="split-legend">
        <span><i class="dot at"></i>🇦🇹 ${money(byCountry.AT)} (${pct(byCountry.AT, totalAll)}%)</span>
        <span><i class="dot sk"></i>🇸🇰 ${money(byCountry.SK)} (${pct(byCountry.SK, totalAll)}%)</span>
        ${byCountry['??'] > 0 ? `<span><i class="dot un"></i>Other ${money(byCountry['??'])}</span>` : ''}
      </div>
    </div>

    <div class="section-title">By store</div>
    <div class="chart">
      ${stores.map(([name, val]) => barRow(name, val, maxStore)).join('')}
    </div>

    <div class="section-title">Most bought</div>
    <div class="chart">
      ${mostBought.map(([name, d]) => `
        <div class="item-row">
          <div class="li-body">
            <div class="li-name">${esc(name)}</div>
            <div class="li-meta">${d.min === d.max ? money(d.min) : money(d.min) + '–' + money(d.max)} each</div>
          </div>
          <div class="item-total">${d.count}×</div>
        </div>`).join('')}
    </div>

    <div class="section-title">Cheapest store per item</div>
    <div class="chart">
      ${cheapest.length ? cheapest.map(x => `
        <div class="item-row">
          <div class="li-body">
            <div class="li-name">${esc(x.name)}</div>
            <div class="li-meta">${esc(x.best.store)} · ${money(x.best.avg)} avg – cheapest of ${x.nStores} stores</div>
          </div>
          <div class="item-total">${money(x.best.avg)}</div>
        </div>`).join('')
        : `<div class="li-meta" style="padding:8px">Buy an item at more than one store to compare prices.</div>`}
    </div>

    <div class="section-title">Top items</div>
    <div class="chart">
      ${topItems.map(([name, d]) => `
        <div class="item-row">
          <div class="li-body">
            <div class="li-name">${esc(name)}</div>
            <div class="li-meta">bought ${d.count}× · ${d.min === d.max ? money(d.min) : money(d.min) + '–' + money(d.max)}</div>
          </div>
          <div class="item-total">${money(d.total)}</div>
        </div>`).join('')}
    </div>`;

  const mB = el.querySelector('#ins-month');
  const wB = el.querySelector('#ins-week');
  if (mB) mB.addEventListener('click', () => { insightsMode = 'month'; renderInsights(); });
  if (wB) wB.addEventListener('click', () => { insightsMode = 'week'; renderInsights(); });
}

function pct(part, whole) { return whole > 0 ? Math.round((part / whole) * 100) : 0; }
function barRow(label, val, max) {
  return `
    <div class="bar-row">
      <div class="bar-label">${esc(label)}</div>
      <div class="bar-track"><div class="bar-val" style="width:${Math.max(3, (val / max) * 100)}%"></div></div>
      <div class="bar-amt">${money(val)}</div>
    </div>`;
}

/* ---------- Modal / helpers ---------- */
function flash(msg) { showModal(msg, [{ label: 'OK', kind: 'btn', fn: hideModal }]); }
function showModal(msg, actions) {
  document.getElementById('modal-msg').textContent = msg;
  const box = document.getElementById('modal-actions');
  box.innerHTML = '';
  actions.forEach(a => {
    const b = document.createElement('button');
    b.className = a.kind === 'secondary' ? 'btn secondary' : 'btn';
    b.textContent = a.label;
    b.addEventListener('click', a.fn);
    box.appendChild(b);
  });
  document.getElementById('modal').classList.remove('hidden');
}
function hideModal() { document.getElementById('modal').classList.add('hidden'); }

/* ---------- Toast + Undo (v2.5) ---------- */
let toastTimer = null;
let undoSnapshot = null;   // JSON of {pantry,listExtras,purchases} before an action

/* Quick, non-blocking confirmation. Optional { undo: fn } adds an Undo button. */
function toast(msg, opts) {
  opts = opts || {};
  const el = document.getElementById('toast');
  const m = document.getElementById('toast-msg');
  const act = document.getElementById('toast-action');
  if (!el) { return; }
  m.textContent = msg;
  clearTimeout(toastTimer);
  if (opts.undo) {
    act.textContent = 'Undo';
    act.classList.remove('hidden');
    act.onclick = () => { opts.undo(); hideToast(); };
  } else {
    act.classList.add('hidden');
    act.onclick = null;
  }
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(hideToast, opts.undo ? 6000 : 2600);
}
function hideToast() {
  const el = document.getElementById('toast');
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => el.classList.add('hidden'), 250);
}

/* Snapshot the mutable state so an action can be undone. */
function snapshotState() {
  return JSON.stringify({
    pantry: state.pantry,
    listExtras: state.listExtras,
    purchases: state.purchases,
  });
}
function restoreSnapshot(snap) {
  try {
    const s = JSON.parse(snap);
    state.pantry = s.pantry || [];
    state.listExtras = s.listExtras || [];
    state.purchases = s.purchases || [];
    save();
    views[currentView] && views[currentView]();
  } catch (e) {}
}

function val(id) { return document.getElementById(id).value.trim(); }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

/* ---------- Boot ---------- */
bootSync();
