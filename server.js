// JadeGate - a lightweight rewriting web proxy.
// Every page is fetched by this server and its links are rewritten so that
// browsing always stays inside JadeGate, in the same tab.

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { Readable } = require('stream');
const chat = require('./chat');

// Some sites (YouTube, Google) send response headers bigger than Node's 16 KB default.
// If we weren't started with a bigger limit, restart ourselves with one.
if (http.maxHeaderSize < 262144 && !process.env.JADEGATE_CHILD) {
  const child = require('child_process').spawn(process.execPath,
    ['--max-http-header-size=262144', __filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, JADEGATE_CHILD: '1' } });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  return;
}

const PORT = process.env.PORT || 8080;
// JadeGate's password. Kept out of the code (the repo is public): set JADEGATE_PASSWORD.
const PASSWORD = process.env.JADEGATE_PASSWORD || crypto.randomBytes(6).toString('hex');
// Search engines, tried in order. Engines sometimes refuse requests from servers (HTTP 202/403/429);
// when that happens JadeGate retries the same search on the next one.
const ENGINES = ['https://html.duckduckgo.com/html/', 'https://www.bing.com/search', 'https://lite.duckduckgo.com/lite/'];
const SEARCH = process.env.JADEGATE_SEARCH || ENGINES[0] + '?q=';

function nextEngine(target) {
  const i = ENGINES.findIndex((e) => target.href.startsWith(e));
  const q = target.searchParams.get('q');
  if (i < 0 || i === ENGINES.length - 1 || !q) return null;
  return ENGINES[i + 1] + '?q=' + encodeURIComponent(q);
}
const AUTH_TOKEN = crypto.createHash('sha256').update('jg:' + PASSWORD).digest('hex');

const PUBLIC = path.join(__dirname, 'public');
const SHELL_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); // toolbar + frame
// Same page, told it's already unlocked (sent once the password has been entered this browser session).
const SHELL_UNLOCKED = SHELL_HTML.replace('window.__JG_LOCKED = true;', 'window.__JG_LOCKED = false;');
const START_HTML =fs.readFileSync(path.join(PUBLIC, 'start.html'), 'utf8'); // search page shown in the frame
const CLIENT_JS = fs.readFileSync(path.join(PUBLIC, 'client.js'), 'utf8');

// ---------- URL helpers ----------

const SKIP_RE = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

// Turn any URL found on a page into a JadeGate URL (/p/<encoded url>#hash).
function px(u, base) {
  if (u == null) return u;
  u = String(u).trim();
  if (!u || SKIP_RE.test(u) || u.startsWith('/p/') || u.startsWith('/jadegate/')) return u;
  let abs;
  try { abs = new URL(u, base); } catch { return u; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
  return proxyPath(abs);
}

// https://site.com/a/b.js?x=1  ->  /p/https%3A%2F%2Fsite.com/a/b.js?x=1
// Only the origin is encoded, so the real folder structure stays in the path and
// relative URLs (like dynamic imports of "./chunk.js") resolve correctly in the browser.
function proxyPath(abs) {
  return '/p/' + encodeURIComponent(abs.origin) + abs.pathname + abs.search + abs.hash;
}

// Reverse of proxyPath. `exact` is false for old-style or slightly malformed links that should be redirected.
function parseProxied(pathname, search) {
  const rest = pathname.slice(3);
  const i = rest.indexOf('/');
  const seg = i < 0 ? rest : rest.slice(0, i);
  let dec;
  try { dec = decodeURIComponent(seg); } catch { return null; }
  if (/^https?:\/\/[^/?#]+$/i.test(dec)) {
    try { return { url: new URL(dec + (i < 0 ? '/' : rest.slice(i)) + search), exact: i >= 0 }; } catch { return null; }
  }
  if (i < 0 && /^https?:\/\//i.test(dec)) { // old format: whole URL encoded in one piece
    try { const u = new URL(dec); if (search) u.search = search; return { url: u, exact: false }; } catch {}
  }
  return null;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;|&#47;/gi, '/');
}
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function rewriteSrcset(value, base) {
  return value.split(',').map((part) => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return part;
    bits[0] = px(bits[0], base);
    return bits.join(' ');
  }).join(', ');
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url("${px(decodeEntities(u.trim()), base)}")`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import "${px(u, base)}"`);
}

const URL_ATTRS = /(\s)(href|src|action|formaction|poster|data|background|xlink:href)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const SRCSET_ATTRS = /(\s)(srcset|imagesrcset)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_ATTR = /(\s)style(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
// Remove every link target (_blank, _top, ...) so links always open inside the JadeGate window.
// Also strip integrity/nonce (rewritten files won't match them).
const TARGET_ATTR = /\starget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi;
const STRIP_ATTRS = /\s(?:integrity|nonce)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function rewriteTag(tag, base) {
  if (/^<meta\b/i.test(tag)) {
    if (/http-equiv\s*=\s*["']?content-security-policy/i.test(tag)) return '';
    if (/name\s*=\s*["']?referrer/i.test(tag)) return '';
    if (/http-equiv\s*=\s*["']?refresh/i.test(tag)) {
      return tag.replace(/(url\s*=\s*)([^"'>;]+)/i, (m, pre, u) => pre + px(decodeEntities(u.trim()), base));
    }
    return tag;
  }
  return tag
    .replace(TARGET_ATTR, '')
    .replace(STRIP_ATTRS, '')
    .replace(URL_ATTRS, (m, sp, attr, eq, d, s, bare) => `${sp}${attr}="${escAttr(px(decodeEntities(d ?? s ?? bare), base))}"`)
    .replace(SRCSET_ATTRS, (m, sp, attr, eq, d, s) => `${sp}${attr}="${escAttr(rewriteSrcset(decodeEntities(d ?? s), base))}"`)
    .replace(STYLE_ATTR, (m, sp, eq, d, s) => `${sp}style="${escAttr(rewriteCss(decodeEntities(d ?? s), base))}"`);
}

const TOKEN_RE = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[a-zA-Z][^>]*>/gi;

function rewriteHtml(html, pageUrl) {
  let base = pageUrl;
  const baseTag = html.match(/<base\b[^>]*\shref\s*=\s*["']?([^"'\s>]+)/i);
  if (baseTag) { try { base = new URL(decodeEntities(baseTag[1]), pageUrl).href; } catch {} }
  html = html.replace(/<base\b[^>]*>/gi, '');

  html = html.replace(TOKEN_RE, (tok) => {
    if (tok.startsWith('<!--')) return tok;
    if (/^<script\b/i.test(tok)) {
      const open = tok.match(/^<script\b[^>]*>/i)[0];
      return rewriteTag(open, base) + tok.slice(open.length);
    }
    if (/^<style\b/i.test(tok)) {
      const open = tok.match(/^<style\b[^>]*>/i)[0];
      return rewriteTag(open, base) + rewriteCss(tok.slice(open.length), base);
    }
    return rewriteTag(tok, base);
  });

  const inject = `<script>window.__JG=${JSON.stringify({ url: base }).replace(/</g, '\\u003c')};</script>` +
    `<script src="/jadegate/client.js"></script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + inject);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + inject);
  return inject + html;
}

// ---------- safety: don't let the proxy reach your own network ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function isBlockedHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  try {
    const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return false; // DNS failure: let fetch report the error
  }
}

// ---------- request helpers ----------

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  return out;
}

// Which real page made this request? (decoded from the Referer, or the last-visited site cookie)
function contextUrl(req) {
  try {
    const ref = new URL(req.headers.referer);
    if (ref.host === req.headers.host && ref.pathname.startsWith('/p/')) {
      const parsed = parseProxied(ref.pathname, ref.search);
      if (parsed) return parsed.url;
    }
  } catch {}
  const last = parseCookies(req.headers.cookie).jg_last;
  if (last) { try { return new URL(decodeURIComponent(last)); } catch {} }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Each site's cookies live under its own /p/<origin>/ path, so sites can't see each other's cookies.
function rewriteSetCookie(cookie, target) {
  const parts = cookie.split(';').map((s) => s.trim()).filter(Boolean);
  const pathPart = parts.find((p) => /^path=/i.test(p));
  const sitePath = pathPart && pathPart.slice(5).startsWith('/') ? pathPart.slice(5) : '/';
  const kept = parts.filter((p) => !/^(domain|path)=/i.test(p));
  kept.push('Path=/p/' + encodeURIComponent(target.origin) + sitePath);
  return kept.join('; ');
}

const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'content-length', 'accept-encoding', 'cookie', 'referer', 'origin', 'forwarded', 'via',
  'x-real-ip', 'true-client-ip']);
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security',
  'set-cookie', 'location', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'alt-svc', 'report-to', 'nel', 'clear-site-data', 'permissions-policy',
  'referrer-policy']);

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, ...extra });
  res.end(body);
}

function errorPage(title, msg) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JadeGate - ${esc(title)}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1f17;color:#d9f2e6;font-family:system-ui,sans-serif">
<div style="max-width:520px;padding:24px;text-align:center"><h1 style="color:#3ddc97">${esc(title)}</h1>
<p>${esc(msg)}</p><p><a href="/" style="color:#3ddc97">Back to JadeGate</a></p></div></body>`;
}

// ---------- the proxy itself ----------

async function proxy(req, res, target) {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return send(res, 400, errorPage('Unsupported link', 'Only http and https sites can be opened.'));
  }
  if (await isBlockedHost(target.hostname)) {
    return send(res, 403, errorPage('Blocked', 'JadeGate will not open local or private network addresses.'));
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP_REQ.has(k) || k.startsWith('x-forwarded') || k.startsWith('cf-') || k.startsWith('x-render')) continue;
    headers[k] = v;
  }
  const cookies = (req.headers.cookie || '').split(';').map((c) => c.trim())
    .filter((c) => c && !c.startsWith('jg_'));
  if (cookies.length) headers.cookie = cookies.join('; ');
  const ctx = contextUrl(req);
  if (ctx) headers.referer = ctx.href;
  if (req.headers.origin) headers.origin = target.origin;

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: req.method,
      headers,
      body: hasBody ? await readBody(req) : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    return send(res, 502, errorPage('Could not reach site', `${target.host}: ${err.cause?.code || err.message}`));
  }

  const out = {};
  // Search engine refused us? Retry the same search on the next engine.
  if (req.method === 'GET' && [202, 403, 429].includes(upstream.status)) {
    const next = nextEngine(target);
    if (next) {
      upstream.body?.cancel().catch(() => {});
      res.writeHead(302, { location: px(next) });
      return res.end();
    }
  }

  upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k)) out[k] = v; });
  out['referrer-policy'] = 'same-origin'; // lets JadeGate see which page requested a file
  const loc = upstream.headers.get('location');
  if (loc) out.location = px(loc, target.href);
  const setCookies = upstream.headers.getSetCookie().map((c) => rewriteSetCookie(c, target));

  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  const isHtml = type.includes('text/html') || type.includes('application/xhtml');
  const isCss = type.includes('text/css');

  if (setCookies.length) out['set-cookie'] = setCookies;

  if (!upstream.body || req.method === 'HEAD' || [204, 304].includes(upstream.status)) {
    res.writeHead(upstream.status, out);
    return res.end();
  }

  if (isHtml || isCss) {
    const charset = (type.match(/charset=([^;]+)/) || [])[1] || 'utf-8';
    let text;
    const buf = Buffer.from(await upstream.arrayBuffer());
    try { text = new TextDecoder(charset.trim()).decode(buf); } catch { text = buf.toString('utf8'); }
    text = isHtml ? rewriteHtml(text, target.href) : rewriteCss(text, target.href);
    out['content-type'] = (isHtml ? 'text/html' : 'text/css') + '; charset=utf-8';
    res.writeHead(upstream.status, out);
    return res.end(text);
  }

  res.writeHead(upstream.status, out);
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

function toTarget(query) {
  const q = query.trim();
  if (/^https?:\/\//i.test(q)) return q;
  if (/^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(q) || /^localhost(:\d+)?/.test(q)) return 'https://' + q;
  return SEARCH + encodeURIComponent(q);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://jadegate.local');

  // Password check (the page itself never knows the password).
  if (url.pathname === '/jadegate/unlock' && req.method === 'POST') {
    let pw = '';
    try { pw = String(JSON.parse((await readBody(req)).toString()).password || ''); } catch {}
    const ok = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(pw).digest(), crypto.createHash('sha256').update(PASSWORD).digest());
    if (!ok) {
      await new Promise((r) => setTimeout(r, 500)); // slow down guessing
      return send(res, 401, '{"ok":false}', 'application/json');
    }
    return send(res, 200, '{"ok":true}', 'application/json',
      { 'set-cookie': `jg_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax` });
  }
  // Until the password is entered, the only thing anyone can load is the password screen.
  if (parseCookies(req.headers.cookie).jg_auth !== AUTH_TOKEN) {
    if (url.pathname === '/') return send(res, 200, SHELL_HTML);
    return send(res, 401, 'Locked', 'text/plain; charset=utf-8');
  }

  if (url.pathname.startsWith('/jadegate/api/')) return chat.handle(req, res, url);

  // "/" opened inside the JadeGate window is a site's own home page (e.g. YouTube's "/"), not ours.
  const inFrame = req.headers['sec-fetch-dest'] === 'iframe';
  if (url.pathname === '/' && !(inFrame && contextUrl(req))) return send(res, 200, SHELL_UNLOCKED);
  if (url.pathname === '/jadegate/start') return send(res, 200, START_HTML);
  if (url.pathname === '/jadegate/client.js') {
    return send(res, 200, CLIENT_JS, 'application/javascript; charset=utf-8', { 'cache-control': 'no-cache' });
  }
  if (url.pathname === '/go') {
    const q = url.searchParams.get('q') || '';
    res.writeHead(302, { location: q.trim() ? px(toTarget(q)) : '/' });
    return res.end();
  }

  if (url.pathname.startsWith('/p/')) {
    const parsed = parseProxied(url.pathname, url.search);
    if (parsed && parsed.exact) return proxy(req, res, parsed.url);
    let target = parsed && parsed.url;
    if (!target) {
      // A relative link that slipped through (e.g. /p/image.png): resolve it against the page that asked.
      const ctx = contextUrl(req);
      try { target = ctx && new URL(url.pathname.slice(3) + url.search, ctx); } catch {}
      if (!target) return send(res, 400, errorPage('Bad link', 'JadeGate could not work out where this link goes.'));
    }
    res.writeHead(307, { location: proxyPath(target) });
    return res.end();
  }

  // Anything else is a site's own path (e.g. /api/data) that escaped rewriting.
  const ctx = contextUrl(req);
  if (ctx) {
    res.writeHead(307, { location: px(new URL(req.url, ctx).href) });
    return res.end();
  }
  send(res, 404, errorPage('Not found', 'That page does not exist on JadeGate.'));
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, errorPage('JadeGate error', err.message));
    else res.destroy();
  });
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use - an older JadeGate server is probably still running.`);
    console.error('Close its "JadeGate Server" window (or end node.exe in Task Manager) and start JadeGate again.\n');
    process.exit(1);
  }
  throw err;
}).listen(PORT, () => {
  console.log(`JadeGate running at http://localhost:${PORT}`);
  if (!process.env.JADEGATE_PASSWORD) {
    console.log(`No JADEGATE_PASSWORD set - using a temporary password for this run: ${PASSWORD}`);
  }
});
