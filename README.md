# CBRE REA EV Siting Workbench

A single guided flow for EV siting at retail centers:
1. **Analysis** — upload the REA/OEA documents (base + amendments); AI returns the
   full written analysis (parties, control zones, approval matrix, risks, next steps).
2. **Map** — upload the site plan (PDF or image); AI drafts charging zones onto it
   **using the real findings from your analysis**, then drag/resize/relabel them.
3. **Save** — store the analysis + the marked-up map together, per property, in a
   shared library your team can reopen.

Built with React + Vite, deployed on Netlify, data in Supabase, AI by Claude.

### Already deployed an earlier version?
Run these once in the Supabase SQL Editor (safe to run again):
- **`supabase/migration-add-analysis.sql`** — column that stores the written analysis.
- **`supabase/migration-add-jobs.sql`** — the `jobs` table for background analysis.

### Why a background function?
A full OEA plus amendments can take ~60 seconds for the AI — longer than any
serverless function may run. So the analysis runs in a **background function**
(`analyze-rea-background.mjs`, up to 15 min) that writes its result to the `jobs`
table; the browser polls that table and shows a progress note. No timeouts.

---

## What's in here

```
rea-siting-map/
├── index.html
├── package.json
├── vite.config.js
├── netlify.toml
├── .env.example                  ← copy to .env for local dev
├── public/
│   └── CBRE_logo.png
├── src/
│   ├── main.jsx
│   ├── App.jsx                   ← the whole map tool
│   └── supabaseClient.js         ← database save/load helpers
├── netlify/functions/
│   └── draft-zones.mjs           ← server-side: holds the Anthropic key
└── supabase/
    └── schema.sql                ← run this once in Supabase
```

**The security model, in plain terms:**
- Your **Anthropic key** lives only in the serverless function — never in the browser.
- Your **Supabase anon key** *is* in the browser, and that's correct: it's a public
  key, and your data is protected by Row Level Security (the schema sets this up).
- Site-plan images go in a Supabase Storage bucket; the database stores the zones.

---

## Step 1 — Set up Supabase (your database)

1. Go to https://supabase.com, sign in, and open your project (or create one).
2. Left sidebar → **SQL Editor** → **New query**.
3. Open `supabase/schema.sql` from this project, copy all of it, paste it in, and
   click **Run**. This creates the tables, the image bucket, and the access rules.
4. Left sidebar → **Project Settings** → **API**. Copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string under "Project API keys")

Keep these handy for Step 3.

---

## Step 2 — Get an Anthropic API key

1. Go to https://console.anthropic.com → **API Keys** → create one.
2. Copy it (starts with `sk-ant-...`). Keep it private.

---

## Step 3 — Deploy on Netlify (no terminal needed)

1. Put this project in a GitHub repo (the web uploader at github.com/new works).
2. Go to https://app.netlify.com → **Add new site** → **Import an existing project**
   → pick your repo. Build settings auto-fill from `netlify.toml`
   (build `npm run build`, publish `dist`).
3. Add **three environment variables** (Site configuration → Environment variables):
   - `ANTHROPIC_API_KEY` = your `sk-ant-...` key
   - `VITE_SUPABASE_URL` = your Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon public key
4. Deploy. You get a live URL like `https://your-site.netlify.app`.
   Future pushes to GitHub redeploy automatically.

---

## Run it locally first (optional)

Needs Node.js (LTS) from https://nodejs.org

```bash
npm install
npm install -g netlify-cli      # one time
cp .env.example .env            # then paste your 3 keys into .env
netlify dev
```

Open the URL it prints. `netlify dev` runs the app AND the serverless function
together (plain `npm run dev` won't run the AI function).

---

## How to use it

1. **Upload** a site plan — **PDF, PNG, or JPG**. For a PDF, the tool shows a thumbnail
   of every page so you click the one with the site plan (e.g. the Exhibit X-1 page);
   that page is rendered to an image and becomes your map surface.
2. **Auto-draft zones** — Claude reads the plan and drops color-coded boxes
   (Best / Conditional / No-go), each with a guessed controlling party and approval note.
3. **Adjust** — drag a box to move it, grab the corner to resize, click it to edit the
   label, viability, controlling party, and approval notes.
4. **Save property** — name it and save. It appears in the library on the home screen,
   and anyone with the app can reopen it.

The app still works without Supabase keys — you just can't save. Good for a quick demo.

---

## Notes & limits

- AI box placement is a **starting draft**. Vision models estimate positions from the
  image, so always nudge them to the real plan — that's what the edit tools are for.
- This is an internal team tool with no per-user login, so the database is open to
  anyone who has the app URL. If you need per-user access later, add Supabase Auth and
  tighten the policies in `schema.sql`.
- To use the licensed CBRE fonts (Financier Display, Calibre) instead of the web
  stand-ins, self-host the font files and add them in `index.html`.
