'use strict';
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const OWNER_KEY = process.env.OWNER_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (OWNER_KEY.length < 6) { console.error('Set OWNER_KEY (at least 6 characters)'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

const SEED = {
  updated: Date.now(), currency: 'د.ع',
  news: [{ id: 'n1', title: 'مرحباً بكم في رهام نت', body: 'نسعد بخدمتكم. تابعوا هنا آخر الأخبار والعروض.', date: new Date().toISOString().slice(0, 10) }],
  packages: [
    { id: 'p1', name: 'الأساسية', speed: 10, price: 15000, note: 'للتصفح والتواصل' },
    { id: 'p2', name: 'المميزة', speed: 30, price: 25000, note: 'للعائلة والبث' },
    { id: 'p3', name: 'البلاتينية', speed: 100, price: 50000, note: 'ألعاب وتحميل سريع' }],
  notifications: [], devices: []
};
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = structuredClone(SEED); persist(); }
function persist() { const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DB_FILE); }

/* ---------- Firebase Cloud Messaging ---------- */
let fcm = null;
try {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    const json = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(json) });
    fcm = admin.messaging();
    console.log('FCM ready');
  } else console.warn('FIREBASE_SERVICE_ACCOUNT not set: push disabled');
} catch (e) { console.error('Firebase init failed:', e.message); }

async function pushAll(n) {
  if (!fcm || !db.devices.length) return;
  const dead = new Set();
  for (let i = 0; i < db.devices.length; i += 500) {
    const chunk = db.devices.slice(i, i + 500);
    const r = await fcm.sendEachForMulticast({
      tokens: chunk.map(d => d.token),
      notification: { title: n.title, body: n.body },
      data: { id: n.id },
      android: { priority: 'high' }
    });
    r.responses.forEach((x, j) => {
      const c = x.error && x.error.code;
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.add(chunk[j].token);
    });
  }
  if (dead.size) { db.devices = db.devices.filter(d => !dead.has(d.token)); persist(); }
}
function addNotification(title, body) {
  const n = { id: crypto.randomUUID(), title: clip(title, 120), body: clip(body, 500), date: new Date().toISOString() };
  db.notifications.unshift(n); db.notifications = db.notifications.slice(0, 30);
  db.updated = Date.now(); persist();
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
const pub = () => ({ updated: db.updated, currency: db.currency, news: db.news, packages: db.packages, notifications: db.notifications });
function cleanNews(a) {
  if (!Array.isArray(a) || a.length > 200) throw new Error('bad news');
  return a.map(n => ({ id: clip(n.id, 40) || crypto.randomUUID(), title: clip(n.title, 200), body: clip(n.body, 4000), date: clip(n.date, 40) }));
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
app.get('/health', (_, res) => res.json({ ok: true, devices: db.devices.length, push: !!fcm }));
app.get('/api/data', (_, res) => res.set('Cache-Control', 'no-store').json(pub()));

app.post('/api/owner/check', auth, (_, res) => res.json({ ok: true }));

app.put('/api/data', auth, (req, res) => {
  try {
    const b = req.body || {};
    db.news = cleanNews(b.news); db.packages = cleanPk(b.packages);
    db.currency = clip(b.currency, 12) || db.currency;
    db.updated = Date.now(); persist();
    if (b.notify && b.notify.title) addNotification(b.notify.title, b.notify.body);
    res.json(pub());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/broadcast', auth, (req, res) => {
  const { title, body } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title_required' });
  res.json(addNotification(title, body));
});

app.post('/api/devices', (req, res) => {
  const token = clip(req.body && req.body.token, 400);
  const role = req.body && req.body.role === 'owner' ? 'owner' : 'customer';
  if (token.length < 20) return res.status(400).json({ error: 'bad_token' });
  const d = db.devices.find(x => x.token === token);
  if (d) d.role = role; else {
    if (db.devices.length >= 50000) return res.status(507).json({ error: 'full' });
    db.devices.push({ token, role, added: new Date().toISOString() });
  }
  persist(); res.json({ ok: true });
});

app.listen(PORT, () => console.log('RahamNet server on :' + PORT));
