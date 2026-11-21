// JadeGate accounts + messenger.
// Privacy by design: everything lives ONLY in this process's memory. Nothing is written to disk,
// nothing is logged, no IP addresses are stored. Restarting the server erases every account and message.
// Messages also expire on their own after 24 hours.

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const ROOM = '#caravanserai';
const MESSAGE_TTL = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 5000;
const MAX_USERS = 5000;

const users = new Map();    // lowercase name -> { name, salt, hash }
const sessions = new Map(); // token -> lowercase name
const streams = new Map();  // lowercase name -> Set of live event-stream responses
let messages = [];          // { id, from, to, text, at }  (to = display name or ROOM)
let nextId = 1;
const sendLog = new Map();  // lowercase name -> recent send timestamps (rate limiting)

setInterval(() => {
  const cutoff = Date.now() - MESSAGE_TTL;
  messages = messages.filter((m) => m.at > cutoff);
}, 60 * 1000).unref();

// ---------- helpers ----------

const key = (name) => String(name).toLowerCase();

function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { req.destroy(); resolve(null); } else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function currentUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)jg_session=([a-f0-9]{64})/);
  if (!m) return null;
  const k = sessions.get(m[1]);
  return k && users.has(k) ? { token: m[1], key: k, name: users.get(k).name } : null;
}

// Session cookie only (no expiry date): the browser forgets it when it closes.
const sessionCookie = (token) => `jg_session=${token}; Path=/; HttpOnly; SameSite=Lax`;
const clearCookie = 'jg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 32)).toString('hex');
}

function startSession(res, k, name) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, k);
  json(res, 200, { name }, { 'set-cookie': sessionCookie(token) });
}

const isOnline = (k) => (streams.get(k)?.size || 0) > 0;

function push(k, event) {
  const set = streams.get(k);
  if (!set) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(line);
}
const pushAll = (event) => { for (const k of streams.keys()) push(k, event); };

const visibleTo = (k, m) => m.to === ROOM || key(m.from) === k || key(m.to) === k;

// ---------- API: /jadegate/api/... ----------

async function handle(req, res, url) {
  const route = url.pathname.slice('/jadegate/api/'.length);
  const me = currentUser(req);

  if (req.method === 'POST' && (route === 'register' || route === 'login')) {
    const body = await readJson(req);
    const name = String(body?.username || '').trim();
    const password = String(body?.password || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
      return json(res, 400, { error: 'Usernames are 3-20 letters, numbers or underscores.' });
    }
    if (password.length < 6 || password.length > 200) {
      return json(res, 400, { error: 'Passwords must be at least 6 characters.' });
    }
    const k = key(name);

    if (route === 'register') {
      if (users.has(k)) return json(res, 409, { error: 'That name is already taken.' });
      if (users.size >= MAX_USERS) return json(res, 503, { error: 'The caravan is full. Try again later.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users.set(k, { name, salt, hash: await hashPassword(password, salt) });
      pushAll({ type: 'user', name, online: false });
      return startSession(res, k, name);
    }

    const user = users.get(k);
    const ok = user && crypto.timingSafeEqual(
      Buffer.from(await hashPassword(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 500)); // slow down password guessing
      return json(res, 401, { error: 'Wrong username or password.' });
    }
    return startSession(res, k, user.name);
  }

  if (req.method === 'POST' && route === 'logout') {
    if (me) sessions.delete(me.token);
    return json(res, 200, { ok: true }, { 'set-cookie': clearCookie });
  }

  if (!me) return json(res, 401, { error: 'Sign in first.' });

  if (req.method === 'POST' && route === 'delete-account') {
    users.delete(me.key);
    for (const [t, k] of sessions) if (k === me.key) sessions.delete(t);
    messages = messages.filter((m) => key(m.from) !== me.key && key(m.to) !== me.key);
    for (const s of streams.get(me.key) || []) s.end();
    streams.delete(me.key);
    sendLog.delete(me.key);
    pushAll({ type: 'gone', name: me.name });
    return json(res, 200, { ok: true }, { 'set-cookie': clearCookie });
  }

  if (req.method === 'GET' && route === 'state') {
    return json(res, 200, {
      me: me.name,
      room: ROOM,
      users: [...users.entries()].filter(([k]) => k !== me.key).map(([k, u]) => ({ name: u.name, online: isOnline(k) })),
      messages: messages.filter((m) => visibleTo(me.key, m)),
    });
  }

  if (req.method === 'POST' && route === 'send') {
    const body = await readJson(req);
    const text = String(body?.text || '').trim();
    const to = String(body?.to || '');
    if (!text || text.length > 1000) return json(res, 400, { error: 'Messages must be 1-1000 characters.' });
    const target = to === ROOM ? null : users.get(key(to));
    if (to !== ROOM && !target) return json(res, 404, { error: 'No traveler by that name.' });

    const now = Date.now();
    const recent = (sendLog.get(me.key) || []).filter((t) => now - t < 10000);
    if (recent.length >= 8) return json(res, 429, { error: 'Slow down a little.' });
    recent.push(now);
    sendLog.set(me.key, recent);

    const msg = { id: nextId++, from: me.name, to: target ? target.name : ROOM, text, at: now };
    messages.push(msg);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
    if (msg.to === ROOM) pushAll({ type: 'message', msg });
    else { push(me.key, { type: 'message', msg }); if (key(msg.to) !== me.key) push(key(msg.to), { type: 'message', msg }); }
    return json(res, 200, { msg });
  }

  if (req.method === 'GET' && route === 'events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const wasOnline = isOnline(me.key);
    if (!streams.has(me.key)) streams.set(me.key, new Set());
    streams.get(me.key).add(res);
    if (!wasOnline) pushAll({ type: 'presence', name: me.name, online: true });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      const set = streams.get(me.key);
      if (!set) return;
      set.delete(res);
      if (!set.size) { streams.delete(me.key); pushAll({ type: 'presence', name: me.name, online: false }); }
    });
    return;
  }

  json(res, 404, { error: 'Unknown request.' });
}

module.exports = { handle };
