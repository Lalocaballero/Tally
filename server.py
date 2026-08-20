#!/usr/bin/env python3
"""
Tally sync server — serves the static app AND a tiny shared-state API.

Pure Python standard library. NO dependencies, NO pip install.
Shared household state is persisted to  state.json  next to this file.

Run:
    python3 server.py            # listens on 0.0.0.0:8080
    python3 server.py 9000       # custom port

Put nginx (TLS + Basic Auth) in front and reverse-proxy to this.
"""
import json, os, sys, threading, time, urllib.request, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, 'state.json')
LOCK = threading.Lock()

DEFAULT_STATE = {"pantry": [], "listExtras": [], "purchases": [], "aliases": {},
                 "saved": [], "mealPlan": {}, "prefs": {}, "updatedAt": 0}

# ---------- TheMealDB proxy (v3.0) ----------
# The key lives HERE on the server, never in client JS. Free dev key = "1";
# swap to a paid key here later without touching the app. All calls are proxied
# so we (a) avoid CORS, (b) hide the key, (c) cache to cut API traffic.
MEALDB_KEY = os.environ.get('MEALDB_KEY', '1')
MEALDB_BASE = f"https://www.themealdb.com/api/json/v1/{MEALDB_KEY}/"
RECIPE_CACHE_FILE = os.path.join(HERE, 'recipe_cache.json')
CACHE_LOCK = threading.Lock()
# recipe details never change -> cache forever; ingredient/search lists -> few days
TTL = {'lookup': 0, 'filter': 3 * 86400, 'search': 3 * 86400, 'categories': 7 * 86400,
       'random': 60, 'area': 3 * 86400, 'list': 30 * 86400}

def _load_recipe_cache():
    try:
        with open(RECIPE_CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

RECIPE_CACHE = _load_recipe_cache()

def _save_recipe_cache():
    try:
        tmp = RECIPE_CACHE_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(RECIPE_CACHE, f, ensure_ascii=False)
        os.replace(tmp, RECIPE_CACHE_FILE)
    except Exception:
        pass

def mealdb_fetch(op, param):
    """Whitelisted proxy to TheMealDB with caching. Returns (bytes, ok)."""
    # Build the upstream path for the allowed op only
    if op == 'filter':      upstream = 'filter.php?i=' + urllib.parse.quote(param)
    elif op == 'lookup':    upstream = 'lookup.php?i=' + urllib.parse.quote(param)
    elif op == 'search':    upstream = 'search.php?s=' + urllib.parse.quote(param)
    elif op == 'categories':upstream = 'categories.php'
    elif op == 'random':    upstream = 'random.php'
    elif op == 'area':      upstream = 'filter.php?a=' + urllib.parse.quote(param)  # recipes by cuisine
    elif op == 'list':      upstream = 'list.php?a=list'                             # all cuisines
    else:
        return (b'{"error":"bad op"}', False)

    key = op + '|' + (param or '')
    now = time.time()
    ttl = TTL.get(op, 3 * 86400)
    # 'random' must always hit upstream — caching it returns the same meal repeatedly
    no_cache = (op == 'random')
    with CACHE_LOCK:
        hit = None if no_cache else RECIPE_CACHE.get(key)
        if hit and (ttl == 0 or now - hit['t'] < ttl):
            return (hit['d'].encode('utf-8'), True)

    try:
        req = urllib.request.Request(MEALDB_BASE + upstream, headers={'User-Agent': 'Tally/3.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read().decode('utf-8')
        # validate it's JSON before caching
        json.loads(data)
    except Exception as e:
        # serve a stale cache entry if we have one, else report the failure
        if hit:
            return (hit['d'].encode('utf-8'), True)
        return (json.dumps({"error": "upstream", "detail": str(e)}).encode('utf-8'), False)

    if not no_cache:
        with CACHE_LOCK:
            RECIPE_CACHE[key] = {'t': now, 'd': data}
            _save_recipe_cache()
    return (data.encode('utf-8'), True)

def read_state():
    with LOCK:
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return dict(DEFAULT_STATE)

def write_state(state):
    with LOCK:
        tmp = STATE_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, STATE_FILE)   # atomic

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.md':   'text/plain; charset=utf-8',
}
# Never serve these over the static handler
BLOCKED = {'state.json', 'state.json.tmp', 'server.py',
           'recipe_cache.json', 'recipe_cache.json.tmp'}

class Handler(BaseHTTPRequestHandler):
    server_version = "TallySync/1.0"

    def _send(self, code, body=b'', ctype='application/json; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/api/state':
            body = json.dumps(read_state(), ensure_ascii=False).encode('utf-8')
            return self._send(200, body)
        if path == '/api/recipes':
            qs = parse_qs(parsed.query)
            op = (qs.get('op', [''])[0]) or ''
            param = (qs.get('q', [''])[0]) or ''
            body, ok = mealdb_fetch(op, param)
            return self._send(200 if ok else 502, body)
        return self.serve_static(path)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != '/api/state':
            return self._send(404, b'{"error":"not found"}')
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            state = json.loads(raw.decode('utf-8'))
            assert isinstance(state, dict)
        except Exception:
            return self._send(400, b'{"error":"bad json"}')
        state.setdefault('pantry', [])
        state.setdefault('listExtras', [])
        state.setdefault('purchases', [])
        state.setdefault('aliases', {})
        state.setdefault('saved', [])
        state.setdefault('mealPlan', {})
        state.setdefault('prefs', {})
        state.setdefault('updatedAt', 0)
        write_state(state)
        return self._send(200, b'{"ok":true}')

    def serve_static(self, path):
        if path in ('/', ''):
            path = '/index.html'
        safe = os.path.normpath(path).lstrip('/\\')
        if safe in BLOCKED:
            return self._send(404, b'Not found', 'text/plain; charset=utf-8')
        full = os.path.join(HERE, safe)
        if not full.startswith(HERE) or not os.path.isfile(full):
            return self._send(404, b'Not found', 'text/plain; charset=utf-8')
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            data = f.read()
        self._send(200, data, MIME.get(ext, 'application/octet-stream'))

    def log_message(self, *args):
        pass  # keep the console quiet

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"Tally sync server running on http://0.0.0.0:{port}  (data: {STATE_FILE})")
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
