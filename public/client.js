// JadeGate in-page helper: catches links, forms, popups and scripts that the
// server could not rewrite, so everything stays inside the JadeGate window.
(() => {
  if (window.__JG_LOADED) return;
  window.__JG_LOADED = true;

  const PAGE = (window.__JG && window.__JG.url) || location.href;
  const PAGE_ORIGIN = new URL(PAGE).origin;
  const ORIGIN = location.origin;
  const SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

  // Opened directly in the tab instead of inside the JadeGate window? Move it back into the window.
  if (window.top === window) {
    location.replace('/?url=' + encodeURIComponent(PAGE));
    return;
  }
  let shell = null;
  try { if (window.parent.__JG_SHELL) shell = window.parent; } catch {}

  function px(u) {
    if (u == null) return u;
    u = String(u).trim();
    if (!u || SKIP.test(u)) return u;
    if (u.startsWith('/p/') || u.startsWith(ORIGIN + '/p/') || u.startsWith('/jadegate/')) return u;
    let abs;
    try { abs = new URL(u, PAGE); } catch { return u; }
    if (abs.origin === ORIGIN) {
      // Site code built a URL using location.origin (which is JadeGate) - point it at the real site.
      abs = new URL(abs.pathname + abs.search + abs.hash, PAGE_ORIGIN);
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
    return '/p/' + encodeURIComponent(abs.origin) + abs.pathname + abs.search + abs.hash;
  }
  window.__jgpx = px;

  // --- tell the JadeGate toolbar which page we're on ---
  function currentUrl() {
    try {
      const p = location.pathname;
      if (p.startsWith('/p/')) {
        const i = p.indexOf('/', 3);
        const origin = decodeURIComponent(i < 0 ? p.slice(3) : p.slice(3, i));
        return new URL(origin + (i < 0 ? '/' : p.slice(i)) + location.search + location.hash).href;
      }
      return new URL(p + location.search + location.hash, PAGE_ORIGIN).href;
    } catch { return PAGE; }
  }
  // --- show the site its real path ---
  // Single-page apps read location.pathname to choose what to render, and "/p/https%3A.../guide/"
  // looks like a 404 to them. So inside the JadeGate window we swap the address to "/guide/".
  // A cookie remembers which site that path belongs to, and when the page is left (navigation, reload)
  // we swap back to the full /p/ address so history and reload still land on the right site.
  if (shell && location.pathname.startsWith('/p/')) {
    const nativeReplace = history.replaceState.bind(history);
    const toReal = () => {
      try {
        const r = new URL(currentUrl());
        document.cookie = 'jg_last=' + encodeURIComponent(r.origin) + '; path=/; SameSite=Lax';
        nativeReplace(history.state, '', r.pathname + r.search + r.hash);
      } catch {}
    };
    const toProxied = () => {
      try {
        const r = new URL(currentUrl());
        nativeReplace(history.state, '', '/p/' + encodeURIComponent(r.origin) + r.pathname + r.search + r.hash);
      } catch {}
    };
    toReal();
    addEventListener('pagehide', toProxied);
    addEventListener('pageshow', (e) => { if (e.persisted) toReal(); });
  }

  const notify = () => shell && shell.postMessage({ jadegate: 'nav', url: currentUrl() }, ORIGIN);
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) { const r = orig.apply(this, args); notify(); return r; };
  }
  addEventListener('popstate', notify);
  addEventListener('hashchange', notify);
  addEventListener('beforeunload', () => shell && shell.postMessage({ jadegate: 'loading' }, ORIGIN));
  notify();

  // --- keep links/forms/media pointed through JadeGate ---
  const ATTRS = ['href', 'src', 'action', 'formaction', 'poster'];

  function fix(el) {
    if (!el || el.nodeType !== 1) return;
    const t = el.getAttribute('target');
    if (t != null && t.toLowerCase() !== '_self' && el.tagName !== 'IFRAME') el.removeAttribute('target');
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v != null) { const n = px(v); if (n !== v) el.setAttribute(a, n); }
    }
    const ss = el.getAttribute('srcset');
    if (ss) {
      const n = ss.split(',').map((p) => { const b = p.trim().split(/\s+/); b[0] = px(b[0]); return b.join(' '); }).join(', ');
      if (n !== ss) el.setAttribute('srcset', n);
    }
  }
  const fixTree = (root) => { fix(root); root.querySelectorAll && root.querySelectorAll('[href],[src],[action],[formaction],[poster],[srcset],[target]').forEach(fix); };

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') fix(m.target);
      else m.addedNodes.forEach(fixTree);
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: [...ATTRS, 'srcset', 'target'],
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    fix(a);
    // Ctrl/Shift/Cmd-click would try to open a new tab or window: open it here instead.
    if ((e.ctrlKey || e.shiftKey || e.metaKey) && !SKIP.test(a.getAttribute('href') || '')) {
      e.preventDefault();
      location.href = px(a.getAttribute('href'));
    }
  }, true);
  document.addEventListener('auxclick', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && e.button === 1) { e.preventDefault(); location.href = px(a.getAttribute('href')); }
  }, true);
  document.addEventListener('submit', (e) => fixTree(e.target), true);

  // --- popups open in this window instead ---
  window.open = function (u) {
    if (u) location.href = px(u);
    return {
      closed: false, close() {}, focus() {}, blur() {}, postMessage() {},
      get location() { return location; },
      set location(v) { location.href = px(v); },
    };
  };

  // --- script navigations: location.href = ..., location.assign/replace, form.submit(), a.click() ---
  // These skip the link and form fixes above. Left alone, the frame would load the real site directly,
  // and most sites refuse to be shown inside a frame ("refused to connect"). Catch them and send them
  // through JadeGate instead. (Navigation API: Chrome, Edge, Brave and other Chromium browsers.)
  if (window.navigation && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigate', (e) => {
      if (e.navigationType === 'traverse' || !e.cancelable || e.hashChange || e.downloadRequest != null) return;
      let dest;
      try { dest = new URL(e.destination.url); } catch { return; }
      if (dest.origin === ORIGIN || (dest.protocol !== 'http:' && dest.protocol !== 'https:')) return;
      e.preventDefault();
      // Loop guard. Some sites check their own address and, when it isn't theirs, send the page back
      // to themselves. Through JadeGate that check fails on every load, so the page would reload forever.
      // Stay put when a script sends us to the page we're already on, or after too many redirects in a row.
      if (dest.href.split('#')[0] === currentUrl().split('#')[0]) return;
      let hits = [];
      try { hits = JSON.parse(sessionStorage.getItem('__jg_redirects') || '[]'); } catch {}
      const now = Date.now();
      hits = (Array.isArray(hits) ? hits : []).filter((t) => now - t < 10000);
      if (hits.length >= 4) return;
      hits.push(now);
      try { sessionStorage.setItem('__jg_redirects', JSON.stringify(hits)); } catch {}
      const to = px(dest.href);
      const replace = e.navigationType === 'replace';
      const data = e.formData;
      setTimeout(() => {
        if (!data) return replace ? location.replace(to) : location.assign(to);
        // A form posted straight to the real site: post the same fields through JadeGate.
        const f = document.createElement('form');
        f.method = 'post'; f.action = to; f.enctype = 'multipart/form-data'; f.style.display = 'none';
        for (const [k, v] of data) {
          const i = document.createElement('input');
          i.name = k;
          if (typeof v === 'string') { i.type = 'hidden'; i.value = v; }
          else { i.type = 'file'; const dt = new DataTransfer(); dt.items.add(v); i.files = dt.files; }
          f.appendChild(i);
        }
        document.documentElement.appendChild(f);
        HTMLFormElement.prototype.submit.call(f);
      }, 0);
    });
  }

  // --- network calls made by page scripts ---
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) input = px(String(input));
      else if (input instanceof Request) input = new Request(px(input.url), input);
    } catch {}
    return nativeFetch.call(this, input, init);
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, u, ...rest) {
    return nativeOpen.call(this, method, px(u), ...rest);
  };
  if (navigator.sendBeacon) {
    const nb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => nb(px(u), d);
  }
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = () => Promise.reject(new Error('Service workers are disabled in JadeGate'));
  }
})();
