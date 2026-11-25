'use strict';
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const OWNER_KEY = process.env.OWNER_KEY || '';
if (OWNER_KEY.length < 6) { console.error('Set OWNER_KEY (at least 6 characters)'); process.exit(1); }

/* ---------- Firebase: Firestore (storage) + FCM (push) ---------- */
const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
if (!raw) { console.error('Set FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
try {
  const json = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(json) });
} catch (e) { console.error('Firebase init failed:', e.message); process.exit(1); }
const fs = admin.firestore();
const fcm = admin.messaging();
const dataRef = fs.collection('rahamnet').doc('data');
const devCol = fs.collection('devices');

const seed = () => ({
  updated: Date.now(), currency: 'د.ع',
  news: [{ id: 'n1', title: 'مرحباً بكم في رهام نت', body: 'نسعد بخدمتكم. تابعوا هنا آخر الأخبار والعروض.', date: new Date().toISOString().slice(0, 10) }],
  packages: [
    { id: 'p1', name: 'الأساسية', speed: 10, price: 15000, note: 'للتصفح والتواصل' },
    { id: 'p2', name: 'المميزة', speed: 30, price: 25000, note: 'للعائلة والبث' },
    { id: 'p3', name: 'البلاتينية', speed: 100, price: 50000, note: 'ألعاب وتحميل سريع' }],
  notifications: []
});

let db = seed();
const devices = new Map(); // token -> {token, role, added}
const devId = t => crypto.createHash('sha1').update(t).digest('hex');

async function loadAll() {
  const s = await dataRef.get();
  if (s.exists) db = { ...seed(), ...s.data() }; else await dataRef.set(db);
  const ds = await devCol.get();
  ds.forEach(d => { const x = d.data(); devices.set(x.token, x); });
  console.log('Loaded from Firestore. devices:', devices.size);
}
const persist = () => dataRef.set(db);

/* ---------- Push ---------- */
async function pushAll(n) {
  const all = [...devices.keys()];
  if (!all.length) return;
  const dead = [];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const r = await fcm.sendEachForMulticast({
      tokens: chunk,
      notification: { title: n.title, body: n.body },
      data: { id: n.id },
      android: { priority: 'high' }
    });
    r.responses.forEach((x, j) => {
      const c = x.error && x.error.code;
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.push(chunk[j]);
    });
  }
  if (dead.length) {
    const b = fs.batch();
    dead.forEach(t => { devices.delete(t); b.delete(devCol.doc(devId(t))); });
    await b.commit();
  }
}
async function addNotification(title, body) {
  const n = { id: crypto.randomUUID(), title: clip(title, 120), body: clip(body, 500), date: new Date().toISOString() };
  db.notifications.unshift(n); db.notifications = db.notifications.slice(0, 30);
  db.updated = Date.now(); await persist();
  pushAll(n).catch(e => console.error('push error:', e.message));
  return n;
}

/* ---------- Helpers ---------- */
const clip = (s, n) => String(s ?? '').slice(0, n);
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fails = new Map();
function auth(req, res, next) {
  const ip = req.ip, now = Date.now();
  const f = fails.get(ip) || { n: 0, t: now };
  if (now - f.t > 60000) { f.n = 0; f.t = now; }
  if (f.n >= 8) return res.status(429).json({ error: 'too_many_attempts' });
  if (eq(req.get('x-owner-key') || '', OWNER_KEY)) return next();
  f.n++; fails.set(ip, f);
  res.status(401).json({ error: 'unauthorized' });
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'server_error' }); });
const pub = () => ({ updated: db.updated, currency: db.currency, news: db.news, packages: db.packages, notifications: db.notifications });
function cleanNews(a) {
  if (!Array.isArray(a) || a.length > 100) throw new Error('bad news');
  return a.map(n => ({ id: clip(n.id, 40) || crypto.randomUUID(), title: clip(n.title, 200), body: clip(n.body, 2000), date: clip(n.date, 40) }));
}
function cleanPk(a) {
  if (!Array.isArray(a) || a.length > 50) throw new Error('bad packages');
  return a.map(p => ({ id: clip(p.id, 40) || crypto.randomUUID(), name: clip(p.name, 80), speed: Math.max(0, Math.min(100000, +p.speed || 0)), price: Math.max(0, +p.price || 0), note: clip(p.note, 200) }));
}

/* ---------- Routes ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '300kb' }));

app.get('/', (_, res) => res.send('RahamNet server OK'));
app.get('/health', (_, res) => res.json({ ok: true, devices: devices.size, push: true, storage: 'firestore' }));
app.get('/api/data', (_, res) => res.set('Cache-Control', 'no-store').json(pub()));
app.post('/api/owner/check', auth, (_, res) => res.json({ ok: true }));

app.put('/api/data', auth, wrap(async (req, res) => {
  const b = req.body || {};
  let news, packages;
  try { news = cleanNews(b.news); packages = cleanPk(b.packages); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  db.news = news; db.packages = packages;
  db.currency = clip(b.currency, 12) || db.currency;
  db.updated = Date.now(); await persist();
  if (b.notify && b.notify.title) await addNotification(b.notify.title, b.notify.body);
  res.json(pub());
}));

app.post('/api/broadcast', auth, wrap(async (req, res) => {
  const { title, body } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title_required' });
  res.json(await addNotification(title, body));
}));

app.post('/api/devices', wrap(async (req, res) => {
  const token = clip(req.body && req.body.token, 400);
  const role = req.body && req.body.role === 'owner' ? 'owner' : 'customer';
  if (token.length < 20) return res.status(400).json({ error: 'bad_token' });
  if (!devices.has(token) && devices.size >= 50000) return res.status(507).json({ error: 'full' });
  const d = { token, role, added: (devices.get(token) || {}).added || new Date().toISOString() };
  devices.set(token, d);
  await devCol.doc(devId(token)).set(d);
  res.json({ ok: true });
}));

loadAll()
  .then(() => app.listen(PORT, () => console.log('RahamNet server on :' + PORT)))
  .catch(e => { console.error('Startup failed (is Firestore enabled?):', e.message); process.exit(1); });
