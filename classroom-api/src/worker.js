/**
 * Ling's Classroom — answer collection API.
 *
 * Students post anonymously (no login). The teacher reads everything with a
 * secret key kept in TEACHER_KEY.
 *
 *   POST /submit        {id, data}            → store one student's whole doc
 *   GET  /verify?key=   → {ok:true}           → is this the teacher key?
 *   GET  /docs?key=     → {docs:[{id,data}]}  → every student doc (teacher)
 *   GET  /export.csv?key=                     → one row per student × activity
 *   GET  /                                    → plain status text
 */

const MAX_BODY = 512 * 1024; // a full 22-activity doc is ~30 KB; this is generous

/* ---------- helpers ---------- */

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const list = allowedOrigins(env);
  const origin = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // No list configured → allow any page to post. With a list, only those origins.
  if (!list.length) h['Access-Control-Allow-Origin'] = '*';
  else if (list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(body, request, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

/** Compare without leaking the key through response timing. */
function sameSecret(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function isTeacher(url, env) {
  const key = env.TEACHER_KEY;
  if (!key) return false; // secret not set → no teacher access at all
  return sameSecret(url.searchParams.get('key'), key);
}

function str(v, max) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

/* ---------- routes ---------- */

async function submit(request, env) {
  let payload;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too_large' }, request, env, 413);
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json' }, request, env, 400);
  }

  const id = str(payload && payload.id, 80);
  const data = payload && payload.data;
  if (!id || !data || typeof data !== 'object') {
    return json({ error: 'bad_request' }, request, env, 400);
  }

  const classCode = str(data.class_code, 40);
  const student = str(data.student, 60);
  if (!classCode || !student) {
    return json({ error: 'missing_identity' }, request, env, 400);
  }

  // Re-serialise from the parsed object so only well-formed JSON is stored.
  const doc = JSON.stringify({
    class_code: classCode,
    student,
    avatar: str(data.avatar, 8),
    updated_at: Number(data.updated_at) || Date.now(),
    forms: data.forms && typeof data.forms === 'object' ? data.forms : {},
  });

  await env.DB.prepare(
    `INSERT INTO progress (id, class_code, student, updated_at, data)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET
       class_code = excluded.class_code,
       student    = excluded.student,
       updated_at = excluded.updated_at,
       data       = excluded.data`
  )
    .bind(id, classCode, student, Date.now(), doc)
    .run();

  return json({ ok: true }, request, env);
}

async function listDocs(request, env) {
  const { results } = await env.DB.prepare(
    'SELECT id, data FROM progress ORDER BY updated_at DESC LIMIT 2000'
  ).all();
  const docs = (results || []).map((r) => {
    let data = {};
    try {
      data = JSON.parse(r.data);
    } catch {
      /* skip a corrupt row rather than failing the whole board */
    }
    return { id: r.id, data };
  });
  return json({ docs }, request, env);
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv(request, env) {
  const { results } = await env.DB.prepare(
    'SELECT data FROM progress ORDER BY class_code, student'
  ).all();

  const head = [
    'class_code', 'student', 'activity_id', 'activity_title',
    'correct', 'total', 'answered', 'questions', 'checked_at', 'updated_at',
  ];
  const lines = [head.join(',')];

  for (const row of results || []) {
    let d;
    try {
      d = JSON.parse(row.data);
    } catch {
      continue;
    }
    const forms = d.forms || {};
    for (const key of Object.keys(forms)) {
      const f = forms[key] || {};
      lines.push([
        d.class_code, d.student, f.form_id || key, f.form_title,
        f.correct, f.total, f.answered, f.questions,
        f.checked_at ? new Date(f.checked_at).toISOString() : '',
        f.updated_at ? new Date(f.updated_at).toISOString() : '',
      ].map(csvCell).join(','));
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lings-classroom-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

/* ---------- entry ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === '/submit' && request.method === 'POST') {
      try {
        return await submit(request, env);
      } catch (e) {
        return json({ error: 'server_error', detail: String(e && e.message) }, request, env, 500);
      }
    }

    // Everything below is teacher-only.
    const teacherRoutes = ['/verify', '/docs', '/export.csv'];
    if (teacherRoutes.includes(url.pathname)) {
      if (!isTeacher(url, env)) return json({ error: 'forbidden' }, request, env, 403);
      try {
        if (url.pathname === '/verify') return json({ ok: true }, request, env);
        if (url.pathname === '/docs') return await listDocs(request, env);
        return await exportCsv(request, env);
      } catch (e) {
        return json({ error: 'server_error', detail: String(e && e.message) }, request, env, 500);
      }
    }

    if (url.pathname === '/') {
      return new Response("Ling's Classroom API is running.\n", {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return json({ error: 'not_found' }, request, env, 404);
  },
};
