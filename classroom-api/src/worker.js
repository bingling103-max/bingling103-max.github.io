import { DurableObject } from 'cloudflare:workers';

/**
 * Ling's Classroom — live class API (v3: real-time).
 *
 * v3 adds GET /ws?class=XX — a WebSocket to one Durable Object per class. The
 * teacher's actions reach every phone at once and each answer reaches the
 * teacher at once, without polling. Everything below keeps working as before
 * and is what the page falls back to if the WebSocket cannot connect.
 *
 * Students post anonymously (no login). The teacher signs in with the secret
 * TEACHER_KEY, sent in the Authorization header (never in the address), and
 * can then read every answer, run the class (current activity, timer),
 * answer raised hands and send feedback.
 *
 * Public (students):
 *   POST /submit          {id, data}                     store one student's whole doc
 *   GET  /state?class=&id=                               teacher's current activity, timer, my feedback
 *   GET  /avatars?class=                                 avatars already used in this class today
 * Teacher (Authorization: Bearer TEACHER_KEY):
 *   GET  /verify                                         is this the teacher key?
 *   GET  /docs                                           every student doc + feedback
 *   GET  /export.csv                                     one row per student × activity
 *   POST /teacher/state     {class, state}               start / stop activity, timer
 *   POST /teacher/feedback  {id, form_id?, text?, hand_ack?}
 *   POST /teacher/delete    {id}                         remove one student row
 *   GET  /                                               plain status text
 *
 * Tables are created automatically on first use.
 */

const MAX_BODY = 512 * 1024;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY, class_code TEXT, student TEXT, updated_at INTEGER, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_progress_class ON progress(class_code)`,
  `CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at)`,
  `CREATE TABLE IF NOT EXISTS class_state (class_code TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER)`,
];
let ready = null;
function ensureSchema(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

/* ---------- helpers ---------- */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function corsHeaders(request, env) {
  const list = allowedOrigins(env);
  const origin = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (!list.length) h['Access-Control-Allow-Origin'] = '*';
  else if (list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(body, request, env, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env), ...extra },
  });
}
function sameSecret(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0 && x.length > 0;
}
/* Slow down password guessing (per Worker instance): 10 wrong keys per IP per 15 min. */
const fails = new Map();
function ipOf(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }
function blocked(request) { const f = fails.get(ipOf(request)); return !!f && f.n >= 10 && Date.now() - f.at < 15 * 60 * 1000; }
function noteFail(request) { const ip = ipOf(request), f = fails.get(ip) || { n: 0, at: 0 }; if (Date.now() - f.at > 15 * 60 * 1000) f.n = 0; f.n++; f.at = Date.now(); fails.set(ip, f); }
function isTeacher(request, env) {
  const key = env.TEACHER_KEY;
  if (!key) return false;
  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return sameSecret(given, key);
}
function str(v, max) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}
function classOf(v) { return str(v, 40).toUpperCase().replace(/\s+/g, '-'); }
async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw Object.assign(new Error('too_large'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}
function parse(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

/* ---------- student routes ---------- */
async function submit(request, env) {
  const payload = await readBody(request);
  const id = str(payload && payload.id, 80);
  const data = payload && payload.data;
  if (!id || !data || typeof data !== 'object') return json({ error: 'bad_request' }, request, env, 400);
  const classCode = classOf(data.class_code), student = str(data.student, 60);
  if (!classCode || !student) return json({ error: 'missing_identity' }, request, env, 400);
  const doc = JSON.stringify({
    class_code: classCode,
    student,
    avatar: str(data.avatar, 8),
    updated_at: Number(data.updated_at) || Date.now(),
    hand_at: Number(data.hand_at) || 0,
    at_form: str(data.at_form, 120),
    forms: data.forms && typeof data.forms === 'object' ? data.forms : {},
  });
  await env.DB.prepare(
    `INSERT INTO progress (id, class_code, student, updated_at, data) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET class_code = excluded.class_code, student = excluded.student, updated_at = excluded.updated_at, data = excluded.data`
  ).bind(id, classCode, student, Date.now(), doc).run();
  return json({ ok: true }, request, env);
}

async function classState(request, env, url) {
  const cls = classOf(url.searchParams.get('class'));
  const id = str(url.searchParams.get('id'), 80);
  const [st, fb] = await Promise.all([
    cls ? env.DB.prepare('SELECT data, updated_at FROM class_state WHERE class_code = ?1').bind(cls).first() : null,
    id ? env.DB.prepare('SELECT data FROM feedback WHERE id = ?1').bind(id).first() : null,
  ]);
  return json({ now: Date.now(), state: st ? parse(st.data, {}) : {}, feedback: fb ? parse(fb.data, {}) : {} }, request, env);
}

async function avatars(request, env, url) {
  const cls = classOf(url.searchParams.get('class'));
  if (!cls) return json({ avatars: [] }, request, env);
  const since = Date.now() - 12 * 3600 * 1000;
  const { results } = await env.DB.prepare('SELECT id, data FROM progress WHERE class_code = ?1 AND updated_at > ?2 LIMIT 300').bind(cls, since).all();
  // Only the picture and an anonymous id are returned — never names.
  const list = (results || []).map((r) => ({ id: r.id, avatar: (parse(r.data, {}).avatar || '') })).filter((x) => x.avatar);
  return json({ avatars: list }, request, env);
}

/* ---------- teacher routes ---------- */
async function listDocs(request, env) {
  const [p, f, s] = await Promise.all([
    env.DB.prepare('SELECT id, data FROM progress ORDER BY updated_at DESC LIMIT 2000').all(),
    env.DB.prepare('SELECT id, data FROM feedback').all(),
    env.DB.prepare('SELECT class_code, data FROM class_state').all(),
  ]);
  const fb = {};
  (f.results || []).forEach((r) => { fb[r.id] = parse(r.data, {}); });
  const states = {};
  (s.results || []).forEach((r) => { states[r.class_code] = parse(r.data, {}); });
  const docs = (p.results || []).map((r) => ({ id: r.id, data: parse(r.data, {}), feedback: fb[r.id] || {} }));
  return json({ now: Date.now(), docs, states }, request, env);
}

async function setState(request, env) {
  const body = await readBody(request);
  const cls = classOf(body && body.class);
  if (!cls) return json({ error: 'bad_request' }, request, env, 400);
  const clean = cleanState(body.state && typeof body.state === 'object' ? body.state : {});
  await env.DB.prepare(
    `INSERT INTO class_state (class_code, data, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(class_code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(cls, JSON.stringify(clean), Date.now()).run();
  await tellRoom(env, cls, { kind: 'state' });
  return json({ ok: true, state: clean }, request, env);
}

async function setFeedback(request, env) {
  const body = await readBody(request);
  const id = str(body && body.id, 80);
  if (!id) return json({ error: 'bad_request' }, request, env, 400);
  const row = await env.DB.prepare('SELECT data FROM feedback WHERE id = ?1').bind(id).first();
  const fb = row ? parse(row.data, {}) : {};
  fb.forms = fb.forms && typeof fb.forms === 'object' ? fb.forms : {};
  if (body.form_id) {
    const fid = str(body.form_id, 120), text = str(body.text, 2000);
    if (text) fb.forms[fid] = { text, at: Date.now() };
    else delete fb.forms[fid];
  }
  if (body.hand_ack) fb.hand_ack = Date.now();
  await env.DB.prepare(
    `INSERT INTO feedback (id, data, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(id, JSON.stringify(fb), Date.now()).run();
  const prow = await env.DB.prepare('SELECT class_code FROM progress WHERE id = ?1').bind(id).first();
  await tellRoom(env, prow && prow.class_code, { kind: 'feedback', id });
  return json({ ok: true, feedback: fb }, request, env);
}

async function removeStudent(request, env) {
  const body = await readBody(request);
  const id = str(body && body.id, 80);
  if (!id) return json({ error: 'bad_request' }, request, env, 400);
  const prow = await env.DB.prepare('SELECT class_code FROM progress WHERE id = ?1').bind(id).first();
  await tellRoom(env, (prow && prow.class_code) || classOf(body.class), { kind: 'delete', id });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM progress WHERE id = ?1').bind(id),
    env.DB.prepare('DELETE FROM feedback WHERE id = ?1').bind(id),
  ]);
  return json({ ok: true }, request, env);
}

function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
async function exportCsv(request, env) {
  const { results } = await env.DB.prepare('SELECT data FROM progress ORDER BY class_code, student').all();
  const head = ['class_code', 'student', 'activity_id', 'activity_title', 'correct', 'total', 'answered', 'questions', 'checked_at', 'updated_at'];
  const lines = [head.join(',')];
  for (const row of results || []) {
    const d = parse(row.data, null); if (!d) continue;
    const forms = d.forms || {};
    for (const key of Object.keys(forms)) {
      const f = forms[key] || {};
      lines.push([d.class_code, d.student, f.form_id || key, f.form_title, f.correct, f.total, f.answered, f.questions,
        f.checked_at ? new Date(f.checked_at).toISOString() : '', f.updated_at ? new Date(f.updated_at).toISOString() : ''].map(csvCell).join(','));
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + lines.join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="lings-classroom-${stamp}.csv"`, 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

/* ---------- entry ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (path === '/') return new Response("Ling's Classroom API is running (v3 real-time).\n", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (path === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, request, env, 426);
      const list = allowedOrigins(env), origin = request.headers.get('Origin') || '';
      if (list.length && !list.includes(origin)) return new Response('forbidden origin', { status: 403 });
      const cls = classOf(url.searchParams.get('class'));
      if (!cls || !env.ROOM) return new Response('no class', { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(cls)).fetch(request);
    }
    try {
      await ensureSchema(env);
      if (path === '/submit' && request.method === 'POST') return await submit(request, env);
      if (path === '/state' && request.method === 'GET') return await classState(request, env, url);
      if (path === '/avatars' && request.method === 'GET') return await avatars(request, env, url);

      const teacherRoutes = { 'GET /verify': 1, 'GET /docs': 1, 'GET /export.csv': 1, 'POST /teacher/state': 1, 'POST /teacher/feedback': 1, 'POST /teacher/delete': 1 };
      if (teacherRoutes[request.method + ' ' + path]) {
        if (blocked(request)) return json({ error: 'too_many_attempts' }, request, env, 429);
        if (!isTeacher(request, env)) { noteFail(request); return json({ error: 'forbidden' }, request, env, 403); }
        if (path === '/verify') return json({ ok: true }, request, env);
        if (path === '/docs') return await listDocs(request, env);
        if (path === '/export.csv') return await exportCsv(request, env);
        if (path === '/teacher/state') return await setState(request, env);
        if (path === '/teacher/feedback') return await setFeedback(request, env);
        if (path === '/teacher/delete') return await removeStudent(request, env);
      }
      return json({ error: 'not_found' }, request, env, 404);
    } catch (e) {
      return json({ error: e.status ? e.message : 'server_error' }, request, env, e.status || 500);
    }
  },
};

/* ================= real-time: one Durable Object per class =================
   Phones and the teacher board keep one WebSocket open here. Sockets hibernate
   between messages, so a quiet class costs nothing; incoming messages are
   billed at 20:1 and outgoing ones are free. */
export class ClassRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.docs = null;        // id -> student doc (latest)
    this.st = null;          // class state
    this.fb = new Map();     // id -> feedback (cache)
    this.cls = '';
    this.flushedAt = 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load() {
    if (this.docs) return;
    this.docs = new Map();
    const list = await this.ctx.storage.list({ prefix: 's:' });
    for (const [k, v] of list) this.docs.set(k.slice(2), v);
    this.cls = (await this.ctx.storage.get('cls')) || this.cls;
  }
  async state() {
    if (this.st) return this.st;
    await ensureSchema(this.env);
    const row = this.cls ? await this.env.DB.prepare('SELECT data FROM class_state WHERE class_code = ?1').bind(this.cls).first() : null;
    this.st = row ? parse(row.data, {}) : {};
    return this.st;
  }
  async feedbackOf(id) {
    if (this.fb.has(id)) return this.fb.get(id);
    await ensureSchema(this.env);
    const row = await this.env.DB.prepare('SELECT data FROM feedback WHERE id = ?1').bind(id).first();
    const f = row ? parse(row.data, {}) : {};
    this.fb.set(id, f);
    return f;
  }
  sockets(role) { return this.ctx.getWebSockets(role); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  toTeachers(obj) { for (const ws of this.sockets('teacher')) { const a = ws.deserializeAttachment() || {}; if (a.ok) this.send(ws, obj); } }
  taken() { const since = Date.now() - 12 * 3600 * 1000; return [...this.docs.entries()].filter(([, d]) => (d.updated_at || 0) > since && d.avatar).map(([id, d]) => ({ id, avatar: d.avatar })); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/changed') {            // an HTTP teacher action changed D1: refresh and broadcast
      const body = await request.json();
      this.cls = body.class || this.cls; await this.ctx.storage.put('cls', this.cls);
      if (body.kind === 'state') { this.st = null; await this.broadcastState(); }
      if (body.kind === 'feedback' && body.id) { this.fb.delete(body.id); await this.pushFeedback(body.id); }
      if (body.kind === 'delete' && body.id) { await this.load(); this.docs.delete(body.id); await this.ctx.storage.delete('s:' + body.id); this.fb.delete(body.id); this.toTeachers({ type: 'gone', id: body.id }); }
      return new Response('ok');
    }
    const cls = classOf(url.searchParams.get('class'));
    if (cls && cls !== this.cls) { this.cls = cls; await this.ctx.storage.put('cls', cls); }
    const pair = new WebSocketPair();
    const role = url.searchParams.get('role') === 'teacher' ? 'teacher' : 'student';
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ role, ok: false, id: '' });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const a = ws.deserializeAttachment() || {};
    await this.load();

    /* ----- students ----- */
    if (a.role === 'student') {
      if (m.type === 'hello') {
        const id = str(m.id, 80); if (!id) return;
        ws.serializeAttachment({ role: 'student', ok: true, id });
        this.send(ws, { type: 'state', now: Date.now(), state: await this.state(), feedback: await this.feedbackOf(id), taken: this.taken() });
        return;
      }
      if (m.type === 'progress' && a.ok && m.data && typeof m.data === 'object') {
        const d = m.data, student = str(d.student, 60);
        if (!student) return;
        const doc = { class_code: this.cls, student, avatar: str(d.avatar, 8), updated_at: Date.now(), hand_at: Number(d.hand_at) || 0, at_form: str(d.at_form, 120),
          forms: d.forms && typeof d.forms === 'object' ? d.forms : {} };
        if (JSON.stringify(doc).length > MAX_BODY) return;
        this.docs.set(a.id, doc);
        await this.ctx.storage.put('s:' + a.id, doc);
        this.toTeachers({ type: 'doc', id: a.id, data: doc, feedback: this.fb.get(a.id) });
        if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 20000);
      }
      return;
    }

    /* ----- teacher ----- */
    if (m.type === 'auth') {
      if (!sameSecret(m.key, this.env.TEACHER_KEY)) { this.send(ws, { type: 'denied' }); ws.close(4003, 'denied'); return; }
      ws.serializeAttachment({ role: 'teacher', ok: true, id: '' });
      const docs = [];
      for (const [id, data] of this.docs) docs.push({ id, data, feedback: await this.feedbackOf(id) });
      this.send(ws, { type: 'snapshot', now: Date.now(), cls: this.cls, state: await this.state(), docs, online: this.online() });
      return;
    }
    if (!a.ok) return;
    if (m.type === 'setState' && m.state) {
      const clean = cleanState(m.state);
      await ensureSchema(this.env);
      await this.env.DB.prepare(`INSERT INTO class_state (class_code, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(class_code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(this.cls, JSON.stringify(clean), Date.now()).run();
      this.st = clean; await this.broadcastState();
      return;
    }
    if (m.type === 'feedback' && m.id) {
      const id = str(m.id, 80), fb = await this.feedbackOf(id);
      fb.forms = fb.forms && typeof fb.forms === 'object' ? fb.forms : {};
      if (m.form_id) { const fid = str(m.form_id, 120), text = str(m.text, 2000); if (text) fb.forms[fid] = { text, at: Date.now() }; else delete fb.forms[fid]; }
      if (m.hand_ack) fb.hand_ack = Date.now();
      await ensureSchema(this.env);
      await this.env.DB.prepare(`INSERT INTO feedback (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(id, JSON.stringify(fb), Date.now()).run();
      this.fb.set(id, fb); await this.pushFeedback(id);
      return;
    }
    if (m.type === 'delete' && m.id) {
      const id = str(m.id, 80);
      this.docs.delete(id); this.fb.delete(id); await this.ctx.storage.delete('s:' + id);
      await this.env.DB.batch([this.env.DB.prepare('DELETE FROM progress WHERE id = ?1').bind(id), this.env.DB.prepare('DELETE FROM feedback WHERE id = ?1').bind(id)]);
      this.toTeachers({ type: 'gone', id });
    }
  }

  online() { const ids = {}; for (const ws of this.sockets('student')) { const a = ws.deserializeAttachment() || {}; if (a.id) ids[a.id] = 1; } return Object.keys(ids); }
  async broadcastState() {
    const st = await this.state();
    for (const ws of this.sockets('student')) { const a = ws.deserializeAttachment() || {}; if (a.ok) this.send(ws, { type: 'state', now: Date.now(), state: st, feedback: await this.feedbackOf(a.id) }); }
    this.toTeachers({ type: 'state', state: st });
  }
  async pushFeedback(id) {
    const fb = await this.feedbackOf(id);
    for (const ws of this.sockets('student')) { const a = ws.deserializeAttachment() || {}; if (a.id === id) this.send(ws, { type: 'feedback', feedback: fb }); }
    this.toTeachers({ type: 'fb', id, feedback: fb });
  }
  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.role === 'student' && a.id) this.toTeachers({ type: 'presence', online: this.online().filter((x) => x !== a.id) });
    try { ws.close(); } catch (e) {}
  }
  async webSocketError(ws) { try { ws.close(); } catch (e) {} }

  /* Copy recent answers to D1 (for the board's other classes, CSV and backups) at most every 20 s. */
  async alarm() {
    await this.load(); await ensureSchema(this.env);
    const since = this.flushedAt, now = Date.now(), stmts = [];
    for (const [id, d] of this.docs) {
      if ((d.updated_at || 0) <= since) continue;
      stmts.push(this.env.DB.prepare(`INSERT INTO progress (id, class_code, student, updated_at, data) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET class_code = excluded.class_code, student = excluded.student, updated_at = excluded.updated_at, data = excluded.data`)
        .bind(id, d.class_code || this.cls, d.student, d.updated_at || now, JSON.stringify(d)));
    }
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
    this.flushedAt = now;
  }
}

function cleanState(st) {
  return {
    activity: st.activity && st.activity.id ? { id: str(st.activity.id, 120), title: str(st.activity.title, 200), at: Number(st.activity.at) || Date.now() } : null,
    timer: st.timer && Number(st.timer.end) ? { end: Number(st.timer.end), minutes: Number(st.timer.minutes) || 0, at: Number(st.timer.at) || Date.now() } : null,
    notice: st.notice ? { text: str(st.notice.text, 300), at: Number(st.notice.at) || Date.now() } : null,
    updated_at: Date.now(),
  };
}
async function tellRoom(env, cls, body) {
  if (!env.ROOM || !cls) return;
  try { await env.ROOM.get(env.ROOM.idFromName(cls)).fetch('https://room/internal/changed', { method: 'POST', body: JSON.stringify({ ...body, class: cls }) }); } catch (e) {}
}
