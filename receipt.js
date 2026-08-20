/* Tally — receipt pipeline
   photo -> OCR (Tesseract.js) -> line parsing -> language detect
        -> normalize/translate -> confidence -> review list.
   100% in-browser, no server. */

/* ---------- Learned aliases (SHARED across devices via synced state) ---------- */
/* Learned name mappings live in the shared `state.aliases` object, which syncs
   to the server like the pantry — so a correction on ONE phone is instantly
   known on the OTHER. (`state` and `save()` are globals from app.js and exist
   at call time, since these run only during a scan/save.) */
const LEARN_KEY = 'tally.aliases';   // legacy per-device key (migrated on boot)
function loadLearned() {
  try {
    if (typeof state !== 'undefined' && state && state.aliases) return state.aliases;
  } catch (e) {}
  return {};
}
function learnAlias(rawFolded, englishName) {
  if (!rawFolded || !englishName) return;
  if (typeof state === 'undefined' || !state) return;
  if (!state.aliases) state.aliases = {};
  state.aliases[rawFolded] = englishName;
  if (typeof save === 'function') save();   // persist locally + push to the other device
}

/* ---------- Text extraction (PDF direct, image via OCR) ---------- */
/* Digital receipts (PDF) usually carry REAL embedded text — far more accurate
   than OCR since there's nothing to misread. So:
     - PDF with a text layer  -> read it directly (fast, exact)
     - PDF that's just a scan -> render pages to canvas, then OCR
     - image (jpg/png/heic)   -> OCR
   Returns { text, source } where source is 'pdf-text' | 'pdf-ocr' | 'ocr'. */
async function extractText(file, onProgress) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (isPdf) return extractPdf(file, onProgress);
  // Photos: preprocess (grayscale + contrast + upscale) to help the OCR a lot.
  let ocrInput = file;
  try { ocrInput = await preprocessImage(file); } catch (e) { ocrInput = file; }
  const text = await runOCR(ocrInput, onProgress);
  return { text, source: 'ocr' };
}

/* Preprocess a photo for OCR: upscale small images, convert to grayscale, and
   stretch contrast around the mean. Thermal-receipt photos improve markedly.
   Returns a <canvas> (runOCR accepts canvas or File). Falls back to the raw
   file if anything throws. */
async function preprocessImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('no image dimensions');

    // upscale so the shorter side is ~1800px (bigger text = better OCR)
    const scale = Math.min(3, Math.max(1, 1800 / Math.min(w, h)));
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    applyGrayContrast(canvas);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* In-place grayscale + contrast stretch on a canvas — shared by the photo-upload
   path and the live-camera capture path. */
function applyGrayContrast(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, n = w * h;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const gray = new Float32Array(n);
  let mean = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g; mean += g;
  }
  mean /= n;
  const contrast = 1.6;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = (gray[p] - mean) * contrast + mean;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
}

/* Quality gate for a captured frame -> { ok, reason }. Lenient by design: the
   camera UI also offers "use anyway", so we never trap the user. */
function assessQuality(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = [];
  let mean = 0, count = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {          // sample every 7th px
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    lum.push(g); mean += g; count++;
  }
  mean /= count;
  let varr = 0;
  for (const g of lum) varr += (g - mean) * (g - mean);
  const sd = Math.sqrt(varr / count);                  // stddev ~ contrast/sharpness

  if (mean < 55)  return { ok: false, reason: 'Too dark — find better light' };
  if (mean > 225) return { ok: false, reason: 'Too bright / glare — avoid direct light' };
  if (sd < 28)    return { ok: false, reason: 'Low contrast or blurry — hold steady & fill the frame' };
  return { ok: true };
}

async function extractPdf(file, onProgress) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF reader not loaded. Connect to the internet once so the app can fetch it — then it caches for offline use.');
  }
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Reconstruct visual LINES: group text items by their y-coordinate,
    // then order left-to-right by x. (Joining raw items would explode the
    // receipt into one word per line.)
    const rows = {};
    content.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const y = Math.round(it.transform[5]);          // vertical position
      (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str });
    });
    Object.keys(rows).map(Number).sort((a, b) => b - a) // top -> bottom
      .forEach(y => {
        const line = rows[y].sort((a, b) => a.x - b.x).map(o => o.s).join(' ')
          .replace(/\s+/g, ' ').trim();
        if (line) text += line + '\n';
      });
  }
  // If the PDF has a real text layer, use it (best case).
  if (fold(text).replace(/[^a-z]/g, '').length >= 20) {
    if (onProgress) onProgress(1);
    return { text, source: 'pdf-text' };
  }
  // Otherwise it's a scanned/image PDF -> render pages and OCR them.
  let ocrText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const { text: t } = await runOCR(canvas, prog => {
      if (onProgress) onProgress(((p - 1) + prog) / pdf.numPages);
    }).then(r => ({ text: r })).catch(() => ({ text: '' }));
    ocrText += t + '\n';
  }
  return { text: ocrText, source: 'pdf-ocr' };
}

/* ---------- OCR ---------- */
/* Tesseract is loaded from CDN on first use, then cached.
   If unavailable we throw a clear message (never fake results).
   Accepts a File/Blob OR a canvas element. */
async function runOCR(image, onProgress) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('OCR engine not loaded. Connect to the internet once so the app can fetch it — then it caches for offline use.');
  }
  const { data } = await Tesseract.recognize(image, 'deu+slk+eng', {
    logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); }
  });
  return data.text || '';
}

/* ---------- Language detect ---------- */
function detectLang(text) {
  const f = ' ' + fold(text) + ' ';
  let sk = 0, de = 0;
  LANG_HINTS.sk.forEach(w => { if (f.includes(' ' + w + ' ')) sk++; });
  LANG_HINTS.de.forEach(w => { if (f.includes(' ' + w + ' ')) de++; });
  return de > sk ? 'de' : sk > de ? 'sk' : 'unknown';
}

/* ---------- Date detect ---------- */
/* Find the purchase date on the receipt. Handles dd.mm.yyyy, dd-mm-yyyy,
   dd/mm/yyyy and 2-digit years (SPAR 30.06.2026, Kaufland 07-07-2026 /
   07.07.26, DM 16.04.2026). Returns ISO 'YYYY-MM-DD' or today's date. */
function detectDate(text) {
  const re = /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) {
      const dt = new Date(Date.UTC(y, mo - 1, d));
      // sanity: not in the future by more than a day
      if (dt.getTime() <= Date.now() + 86400000) {
        return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      }
    }
  }
  return new Date().toISOString().slice(0, 10); // fallback: today
}

/* ---------- Store detect ---------- */
function detectStore(text, lang) {
  // Only look at the HEADER (first ~8 lines) — the store name is always up top,
  // and this avoids false hits from body/footer text.
  const head = fold(text.split(/\r?\n/).slice(0, 8).join(' '));
  const full = fold(text);
  for (const key in STORE_HINTS) {
    const re = new RegExp('\\b' + key + '\\b');   // WHOLE-WORD match, so "sparen"
    if (re.test(head) || re.test(full)) {         // /"ersparnis" don't match "spar"
      const hint = STORE_HINTS[key];
      let country = hint.country;
      // Chains present in both countries (Lidl, Rossmann): infer from language.
      if (country === '??') country = countryFromLang(lang);
      return { name: hint.display || cap(key), country };
    }
  }
  // Unknown store: still tag a country from the receipt language if we can.
  return { name: 'Unknown store', country: countryFromLang(lang) };
}
/* Slovak receipt -> SK, German receipt -> AT, otherwise unknown. */
function countryFromLang(lang) {
  return lang === 'sk' ? 'SK' : lang === 'de' ? 'AT' : '??';
}

/* ---------- Line parsing ---------- */
/* Words that mark a NON-product line (headers, footers, totals, payment,
   deposits, discounts, legal, address). Any line containing one is skipped.
   Covers German (AT) + Slovak (SK). */
const SKIP_WORDS = [
  // totals / payment
  'summe','gesamt','total','spolu','zwischensumme','mwst','dph','ust','betrag',
  'bar','hotovost','karte','kreditkarte','mastercard','maestro','visa','debit',
  'zahlung','zahlen','kundenbeleg','contactless','wechselgeld','rueckgeld','gegeben',
  'uhradu','uhrade','karta','platba','suma','sadzba','zaklad','netto','brutto','nettobetr',
  // deposits / discounts / promos / loyalty
  'pfand','einweg','mehrweg','ersparnis','aktion','rabatt','zlava','gutschein',
  'preisvorteil','vorteil','gratis','xtra','payback','punkte','usetril','uspora',
  'lidl plus','card',
  // tax breakdown table
  'netto','brutto','nettobetr','spezifikation','bezahlweise','inkl','exkl',
  // receipt meta / legal / address / footer
  'rechnung','beleg','datum','uhr','uhrzeit','cas','kasse','kassa','kassier','pokladna',
  'ucet','bon','pos','posten','artikel','kaufsumme','terminal','tender',
  'trm','aid','trx','acq','rrn','tid','mid','rec','pan','auth','autorisier','autcod',
  'verarbeitung','rezim','einkauf','filiale','filialka','strasse','strase','platz','cesta',
  'bratislava','kittsee','vienna','wien','warenhandels','republika','gmbh','danubia',
  'tel','fax','www','http','uid','atu','ico','dic','okp','emv','online','date','time',
  'registrierkasse','sicherheitsverordnung','fiskale','transaktion','transakcia','doklad',
  'zakaznik','navstevu','linka','reklamacie','overte','schvalene','verified','device',
  'vielen','dank','danke','dakujeme','wiedersehen','umtausch','kassenzettel','retail',
  'fuer','ihren','ihr','bei','prosim','odlozte',
  'oeffnungszeiten','offnungszeiten','mensch','thank','shopping','buchung',
];

/* A product line ends with a price. It may be followed by a tax-class token —
   a LETTER (SPAR "1,99 B", Kaufland "1,26 F", Lidl "4,99 E") or a DIGIT
   (DM "13,95 1") — but that token AND the space before it are BOTH optional,
   because some stores print no tax class (Action "0,99") or glue it to the
   price (TEDi "3.00A"). Price-anchored, not tax-anchored. */
const PRICE_TAX = /(-?\d{1,4})[.,](\d{2})\s*([A-Za-z0-9])?\s*$/;
/* A quantity line: "2 x 2,49" (SPAR) or "2 ks * 0,63" (Kaufland). */
const QTY_LINE  = /^\s*(\d{1,3})\s*(?:ks|stk|st)?\s*[x×*]\s*\d/i;
const HAS_PRICE = /-?\d{1,4}[.,]\d{2}/;

function looksLikeName(s) {
  return /[A-Za-zÄÖÜäöüßÁ-ža-ž]/.test(s) && !HAS_PRICE.test(s);
}

/* Strip prices, quantity multipliers and unit tokens out of a product name */
function cleanName(s) {
  return (s || '')
    .replace(/^\W*\d{4,}\s*/, ' ')                 // leading article number "2578534 ..."
    .replace(/-?\d{1,4}[.,]\d{2}/g, ' ')          // prices  "1,99"
    .replace(/\b\d{1,3}\s*[x×*]/gi, ' ')          // "2 x", "2*"
    .replace(/[x×*]\s*\d{1,3}\b/gi, ' ')          // "x 2", "*2"
    .replace(/\b\d{1,3}\s*(ks|stk|st)\b/gi, ' ')  // "1 ks"
    .replace(/[*#]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseLines(text) {
  const lines = text.split(/\r?\n/);

  // 1) Item region: everything up to the totals line. We do NOT cut a "start"
  //    (dashes and "EUR" are unreliable markers — they also appear in the
  //    payment footer). Header lines lack a price+tax-class ending, so the
  //    product-pattern + skip-word filters below exclude them naturally.
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const f = fold(lines[i]);
    // substring match (not \b) so "kaufsumme"/"gesamtsumme" are caught too
    if (/(summe|kaufsumme|zwischensumme|spolu|medzisucet|na uhradu|na uhrade|zu zahlen|gesamt|total)/.test(f)) { end = i; break; }
  }
  const region = lines.slice(0, end);

  // 2) Extract products
  const out = [];
  for (let i = 0; i < region.length; i++) {
    const raw = (region[i] || '').trim();
    if (raw.length < 2) continue;
    const f = fold(raw);
    if (!/[a-z]/.test(f)) continue;                       // must have letters
    // skip non-product lines — WORD-BOUNDARY match so "einweg" (deposit)
    // doesn't wrongly kill "Einwegkamera" (a product)
    if (SKIP_WORDS.some(w => new RegExp('\\b' + w + '\\b').test(f))) continue;
    // discount / promo markers — SUBSTRING match, since they appear inside
    // compound words (e.g. "Aktionsersparnis", "Preisvorteil"). NOTE: do NOT
    // put "einweg"/"pfand" here — that would kill "Einwegkamera" (a product);
    // those are matched as whole words in SKIP_WORDS above.
    if (/(ersparnis|vorteil|rabatt|gutschein|payback|zwischensumme)/.test(f)) continue;

    let name = null, price = null, qty = 1;

    const pm = raw.match(PRICE_TAX);
    if (pm) {
      if (raw[pm.index] === '-' || pm[1].startsWith('-')) continue; // negative = discount
      price = parseFloat(pm[1] + '.' + pm[2]);
      name = raw.slice(0, pm.index).trim();
    } else if (looksLikeName(raw)) {
      // name-only line (multi-qty item): next line is "2 x 2,49 .. B" / "2 ks * .."
      const next = region[i + 1] || '';
      if (QTY_LINE.test(next)) {
        name = raw;
        const qm = next.match(QTY_LINE);
        if (qm) qty = parseInt(qm[1], 10);
        const tp = next.match(PRICE_TAX);
        if (tp && !tp[1].startsWith('-')) price = parseFloat(tp[1] + '.' + tp[2]);
        i++;                                              // consume the qty line
      }
    }
    if (!name) continue;

    name = cleanName(name);
    if (fold(name).replace(/[0-9 ]/g, '').length < 2) continue; // no real word
    out.push({ raw: name, name, qty, price });
  }
  return out;
}

/* ---------- Normalize / translate one item ---------- */
function normalizeItem(name) {
  const f = fold(name);
  if (!f) return { englishName: name, cat: 'Other', confidence: 'low' };

  // 1) learned aliases -> high confidence
  const learned = loadLearned();
  for (const key in learned) {
    if (f === key || f.includes(key) || key.includes(f)) {
      const c = CATALOG.find(x => x.en === learned[key]);
      return { englishName: learned[key], cat: c ? c.cat : 'Other', confidence: 'high', matchedAlias: key };
    }
  }
  // 2) exact alias -> high
  for (const p of CATALOG) {
    for (const a of p.aliases) {
      if (f === fold(a)) return { englishName: p.en, cat: p.cat, confidence: 'high', matchedAlias: a };
    }
  }
  // 3) contains alias -> medium
  for (const p of CATALOG) {
    for (const a of p.aliases) {
      const fa = fold(a);
      if (fa.length >= 4 && (f.includes(fa) || fa.includes(f))) {
        return { englishName: p.en, cat: p.cat, confidence: 'med', matchedAlias: a };
      }
    }
  }
  // 4) fuzzy similarity
  let best = null, bestScore = 0;
  for (const p of CATALOG) {
    for (const a of p.aliases) {
      const s = sim(f, fold(a));
      if (s > bestScore) { bestScore = s; best = p; }
    }
  }
  // Only trust a STRONG fuzzy match — a weak one guessing "Ihren"->Carrots is
  // worse than honestly keeping the original name at low confidence.
  if (best && bestScore >= 0.85) return { englishName: best.en, cat: best.cat, confidence: 'med', matchedAlias: '~' };

  // 5) unknown -> keep the real product name, mark low (user confirms/renames)
  return { englishName: cap(name), cat: 'Other', confidence: 'low' };
}

/* crude bigram similarity 0..1 */
function sim(a, b) {
  if (!a || !b) return 0;
  const bg = s => { const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; };
  const A = bg(a), B = bg(b);
  if (!A.length || !B.length) return 0;
  let hit = 0; const used = [...B];
  A.forEach(g => { const i = used.indexOf(g); if (i > -1) { hit++; used.splice(i, 1); } });
  return (2 * hit) / (A.length + B.length);
}
function cap(s) { s = (s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* ---------- Full pipeline ---------- */
/* Shared: turn extracted text into the review result object. */
function analyzeText(text, source) {
  const lang = detectLang(text);
  const store = detectStore(text, lang);
  const date = detectDate(text);
  const rawItems = parseLines(text);
  const items = rawItems.map(it => {
    const n = normalizeItem(it.name);
    return {
      raw: it.name, rawFolded: fold(it.name),
      qty: it.qty, price: it.price,
      englishName: n.englishName, cat: n.cat, confidence: n.confidence,
      keep: true,
    };
  });
  return { text, source, lang, store, date, items };
}

/* Upload path (photo file or PDF). */
async function processReceipt(file, onProgress) {
  const { text, source } = await extractText(file, onProgress);
  return analyzeText(text, source);
}

/* Live-camera path: OCR an already-captured+processed canvas directly. */
async function processCanvas(canvas, onProgress) {
  const text = await runOCR(canvas, onProgress);
  return analyzeText(text, 'photo');
}
