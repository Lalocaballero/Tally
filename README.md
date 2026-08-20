<div align="center">

# 🥫 Tally

### Bilingual Grocery & Pantry Tracker — Snap a receipt, done.

*Photo or PDF in → OCR → auto-translate (SK/DE → EN) → confirm → your pantry updates and syncs across every device. A real PWA, used daily by two people.*

<br/>

![JavaScript](https://img.shields.io/badge/Vanilla_JS-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![PWA](https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white)
![Tesseract.js](https://img.shields.io/badge/Tesseract.js_OCR-5C3EE8?style=flat-square&logo=tesseract&logoColor=white)
![PDF.js](https://img.shields.io/badge/PDF.js-E4322B?style=flat-square&logo=mozilla&logoColor=white)

</div>

---

## ✨ What it does

Tally turns the annoying part of groceries — logging what you bought — into a two-tap flow.

| | Feature |
|---|---|
| 📸 | **Receipt scanning** — snap a photo or drop a PDF; in-browser **Tesseract.js OCR** + **PDF.js** extract the items |
| 🌍 | **Bilingual** — auto-translates Slovak & German product names to English (real receipts from Lidl, Billa, Kaufland, SPAR, Tesco, DM, Action, TEDi...) |
| 🧾 | **Smart parser** — per-store logic for tax classes, price anchoring, and messy OCR; word-boundary matching to avoid false hits |
| 🔄 | **Multi-device sync** — shared pantry state across phones via a lightweight sync API |
| 📦 | **Pantry management** — search, filter & sort by category, low-stock and expiry tracking |
| 🍳 | **Cook From Your Kitchen** — recipe suggestions (TheMealDB) matched to what you actually have, with substitution logic |
| 📊 | **Spending insights** — per-store price comparison, most-bought, cheapest-store-per-item |
| 📴 | **Offline-first** — full PWA with a versioned service worker; installs to your home screen |

## 🏗️ How it works

A **zero-dependency Python** backend (`server.py`) exposes a small shared-state API (`GET/PUT /api/state`) that persists to a JSON file, plus a recipe proxy. The frontend is **vanilla JS** — no framework, no build step — with a cache-first **service worker** for offline use. OCR and PDF parsing run entirely **in the browser** (Tesseract.js + PDF.js), so receipts never leave the device until you confirm.

## 🚀 Run locally

```bash
python3 server.py     # serves on http://localhost:8080
```
Open `http://localhost:8080` and add items or scan a receipt. For a shared deployment, put nginx (TLS + auth) in front and point a domain at it.

## 🎯 What this demonstrates

- Client-side OCR + PDF parsing pipeline (Tesseract.js / PDF.js)
- A genuinely messy real-world parsing problem solved per-store
- Offline-first PWA architecture with service-worker cache versioning
- Shared multi-device state with a tiny, dependency-free backend
- Shipped and maintained for **real daily users**

<div align="center">
<br/>
<sub>Built by <a href="https://github.com/Lalocaballero">Eduardo Caballero</a></sub>
</div>
