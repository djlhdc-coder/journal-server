# Journal Server — Deployment Guide

## What this is
A small Node.js server that:
- Holds Humberto's Anthropic API key securely (never exposed to the browser)
- Proxies requests to Claude
- Stores all journal entries in a database on the server
- Serves the journal app to any phone or browser

---

## Step 1 — Get the code onto GitHub

1. Go to **github.com** and create a free account if you don't have one
2. Click **New repository**, name it `journal-server`, make it **Private**, click Create
3. On your computer, install **GitHub Desktop** (desktop.github.com) — easiest way to do this without command line
4. In GitHub Desktop: File → Clone Repository → paste your new repo URL
5. Copy all the files from this folder into the cloned folder
6. In GitHub Desktop: commit all files with message "Initial deploy", then click Push

---

## Step 2 — Deploy to Railway (free tier)

1. Go to **railway.app** and sign up with your GitHub account
2. Click **New Project** → **Deploy from GitHub repo**
3. Select `journal-server`
4. Railway will detect it's a Node.js app and deploy automatically
5. Wait ~2 minutes — you'll get a URL like `journal-server-production.up.railway.app`

---

## Step 3 — Add Humberto's API Key

1. In Railway, click your project → **Variables** tab
2. Add these two variables:
   ```
   ANTHROPIC_API_KEY = sk-ant-... (Humberto's key from console.anthropic.com)
   APP_SECRET        = (any long random string — generate at uuidgenerator.net)
   ```
3. Railway will automatically restart the server with the new variables

---

## Step 4 — Test it

Open your Railway URL in a browser. You should see the journal app.
The status bar at the top will confirm the API key is configured.

---

## Step 5 — Add to Humberto's phone

**iPhone:**
1. Open Safari, go to your Railway URL
2. Tap the Share button (box with arrow)
3. Tap **Add to Home Screen**
4. Name it "Daily Journal", tap Add
5. It now lives on his home screen like a native app

**Android:**
1. Open Chrome, go to your Railway URL
2. Tap the three-dot menu
3. Tap **Add to Home Screen**

---

## Upgrading to Render later

When ready to move to Render (for always-on uptime, custom domain, more reliability):
1. Go to **render.com**, connect your GitHub account
2. New Web Service → select `journal-server`
3. Set the same environment variables (ANTHROPIC_API_KEY, APP_SECRET)
4. The $25 credit covers several months of their Starter plan
5. Update any bookmarks to the new Render URL

---

## Research data export

At any time, visit:
`https://your-railway-url/api/export/humberto`

This returns a JSON file with all finalized entries plus computed metrics
(PSA trend, adherence rates, exercise correlation, etc.) — ready for analysis.

---

## Files in this project

```
journal-server/
├── server.js          ← the backend (API proxy + database + file server)
├── package.json       ← dependencies
├── .env.example       ← template for environment variables (never commit .env itself)
├── .gitignore         ← keeps secrets and data off GitHub
├── README.md          ← this file
└── public/
    └── index.html     ← the journal app (served to Humberto's phone)
```

The database (`data/journal.db`) is created automatically on first run and lives on the server.
