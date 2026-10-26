# Ling's Classroom — live class (Cloudflare Worker + D1)

Students open the class link and answer. No account, no sign-in: they tap a picture and type their name.
Answers go to a D1 database that only you can read.

- **Student link** — one per class, e.g. `https://bingling103-max.github.io/classroom/?class=PM`
  (copy it from the Teacher Board → 🔗 Student link). The class comes from the link, so students never type it.
- **Teacher** — open `https://bingling103-max.github.io/classroom/?teacher` and type your teacher password
  on the page. It is sent in a request header, never in the address, and remembered on that device.
- **Class whiteboard** — the front of the room. One question, written on a blackboard or a whiteboard.
  Students on the class link write a sentence on it and see each other's lines. Switch the look from the tray.
  Class records still open the Teacher Board.
- **Teacher Board** — start an activity for the whole class (students' pages follow), class timer,
  raised hands, live answers per student and per question, 📺 show an answer big on the projector,
  written feedback to a student, CSV export.

## Real-time (v3) — one-time setup, then updates deploy by themselves

v3 keeps one live connection open between each phone and the class, so the teacher's actions
reach every phone at once and every answer reaches the Teacher Board at once. It uses a
Durable Object, which is free on the Workers Free plan — but it cannot be pasted into the
dashboard editor, so connect the Worker to this GitHub repository once:

1. Cloudflare dashboard → **Workers & Pages** → `ling-classroom` → **Settings** → **Build** →
   **Connect** (Git repository).
2. Choose GitHub → `bingling103-max/bingling103-max.github.io`, branch `main`.
3. **Root directory**: `classroom-api` · **Build command**: leave empty ·
   **Deploy command**: `npx wrangler deploy` → **Save / Connect**.
4. Wait for the first build to finish (Deployments tab). Check
   `https://<your-worker-url>/` says *running (v3 real-time)*.

From then on every change pushed to `main` deploys the Worker automatically. `TEACHER_KEY`
stays as it is (secrets are not in this repository). The database tables are created by the
Worker itself.

Until this is done the page still works over plain requests (answers arrive every few
seconds); the board shows **Live · every 4 s** instead of **Live · instant**.

## What is stored

One row per student device:

| column | meaning |
| --- | --- |
| `id` | random id generated in the browser — not a login, not an email |
| `class_code` | the class code the student typed (e.g. `MORNING`) |
| `student` | the name the student typed |
| `updated_at` | server time of the last write |
| `data` | full JSON: every activity, every answer, score, and when it was checked |

No email address, IP, or account is recorded. A student who clears their browser
data gets a new id and appears as a new row.

## Deploy — no terminal, in the browser

Everything below can be done with a mouse at <https://dash.cloudflare.com>. A free
account is enough.

1. **Workers & Pages** → **Create** → **Start with Hello World!** → name it
   `lings-classroom` → **Deploy**.
2. **Edit code**. Select everything in the editor, delete it, and paste the whole
   of [`src/worker.js`](src/worker.js). **Deploy**.
3. **Storage & Databases** → **D1 SQL Database** → **Create** → name it
   `lings-classroom` → **Create**.
4. Open that database → **Console** tab → paste the whole of
   [`schema.sql`](schema.sql) → **Execute**.
5. Back to your Worker → **Settings** → **Bindings** → **Add** → **D1 database**.
   Variable name must be exactly `DB`, database `lings-classroom` → **Deploy**.
6. Still in **Settings** → **Variables and Secrets** → **Add**:
   - type **Secret**, name `TEACHER_KEY`, value: a long password of your own.
   - type **Text**, name `ALLOWED_ORIGINS`, value `https://bingling103-max.github.io`
   → **Deploy**.
7. The Worker's address is on its overview page, like
   `https://lings-classroom.<you>.workers.dev`. That is what goes into
   `classroom/index.html`.

Check it worked: open `https://<your-worker-url>/` in a browser. It should say
*Ling's Classroom API is running.*

## Deploy — one command

If you'd rather use a terminal, from inside this folder:

```sh
node deploy.mjs
```

It signs you in (a browser window opens — click Allow), creates the database,
creates the table, asks for your teacher password, and deploys. Running it twice
is safe; it skips whatever is already done.

## Deploy — step by step

You need a free Cloudflare account. Run these from inside this folder.

```sh
npx wrangler login                      # 1. opens a browser, sign in, Allow

npx wrangler d1 create ling-classroom
#    paste that id into wrangler.toml, replacing PASTE_DATABASE_ID_HERE

npx wrangler d1 execute lings-classroom --remote --file=schema.sql   # 3. create the table

npx wrangler secret put TEACHER_KEY     # 4. type a password of your own, press Enter
#    this is the only thing protecting your students' answers — make it long

npx wrangler deploy                     # 5. prints https://lings-classroom.<you>.workers.dev
```

Then put that URL into `classroom/index.html`, on the line near the top:

```js
window.LINGS_API = "";  // <-- paste the Worker URL here
```

Commit and push, and the student page is live.

### If the page is served from somewhere other than GitHub Pages

`ALLOWED_ORIGINS` in `wrangler.toml` lists the sites allowed to post answers.
Add the new address there (comma-separated) and `npx wrangler deploy` again.
Leaving it empty allows any site to post.

## Day to day

- Change the teacher key at any time: dashboard → Worker → Settings → Variables and Secrets → `TEACHER_KEY`
  (or `npx wrangler secret put TEACHER_KEY`), then open `…/classroom/?teacher` and sign in again.
- Read the raw rows: `npx wrangler d1 execute lings-classroom --remote --command "SELECT class_code, student, updated_at FROM progress ORDER BY updated_at DESC LIMIT 20"`
- Clear a class after term ends: `npx wrangler d1 execute lings-classroom --remote --command "DELETE FROM progress WHERE class_code = 'MORNING'"`

## Worth knowing

Anonymous posting is what makes "no login" possible, and it cuts both ways:
anyone who finds the Worker URL can post a row under any name. For a classroom
that is normally fine — the cost of a junk row is deleting it. What is protected
is **reading and running the class**: `/docs`, `/verify`, `/export.csv` and `/teacher/*` all require `TEACHER_KEY`
in the `Authorization` header (10 wrong tries per IP → 15-minute pause),
so nobody can see your students' answers without it. Treat the key like a
password and don't put it in anything you hand to students.

Free plan: with real-time on, a phone sends about two tiny messages a minute and these are
counted 20 to 1, so a whole class uses only a few hundred requests a day out of 100,000.
Answers are copied from the class room into D1 every 20 s for the CSV and other classes.
If a limit were ever reached the Worker stops answering until midnight UTC; nothing is charged.
