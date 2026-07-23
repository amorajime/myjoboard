# myjoboard
Manual job hunting eats 2–3 hours a day and still returns noise. JobMatch turns a
personal "ideal role profile" into an explainable ranking model, ingests recent
roles from selected sources, and shows only the jobs worth your attention — while
keeping your career data private on your own device.

This is a portfolio MVP: it demonstrates product judgment, an explainable AI
ranking layer, a local-first privacy model, and a practical static deployment.

## What it does

- Ranks each job `0–100%` against your profile with a transparent rubric.
- Shows only jobs scoring `60%+` (configurable).
- Explains every score with short bullets ("why this match").
- Filters by category, job type, location, work model, freshness, and match.
- Sorts by best match or newest.
- Learns locally from thumbs up/down feedback.
- Defaults to jobs posted in the last 7 days.

## Architecture

```
Job sources ──> GitHub Actions (scheduled ingest) ──> data/jobs.json (public)
                                                            │
                                                            ▼
                                            GitHub Pages static site (index.html)
                                                            │
                     Local profile + feedback (browser) ──> in-browser ranking ──> curated inbox
```

- **Frontend**: static HTML/CSS/vanilla JS (no build step) — ideal for GitHub Pages.
- **Ingestion**: `scripts/ingest.mjs` runs on a schedule via GitHub Actions,
  normalizes + deduplicates + freshness-filters jobs, and commits `data/jobs.json`.
- **Ranking**: `assets/ranking.js` scores jobs in the browser.
- **Privacy**: profile, preferences, feedback and scores live in `localStorage`.

Key constraint: GitHub Pages can't run crawlers. Crawling happens in the Action,
which publishes static data the page reads.

## File structure

```
job-match-app/
├── index.html              # UI
├── assets/
│   ├── app.js              # data loading, filtering, sorting, rendering, feedback
│   ├── ranking.js          # transparent scoring rubric + explanations + hard filters
│   ├── profile.js          # default Ideal Role Profile
│   ├── storage.js          # local-first storage (localStorage)
│   └── styles.css
├── data/
│   └── jobs.json           # generated PUBLIC job data (sample data included)
├── scripts/
│   ├── ingest.mjs          # ingestion entry point (adapters are stubbed)
│   └── sources.json        # source configuration
└── .github/workflows/
    ├── ingest.yml          # scheduled crawl + commit jobs.json
    └── pages.yml           # deploy static site to Pages
```

## Run locally

`fetch` is blocked on `file://`, so use a local server:

```bash
cd job-match-app
python3 -m http.server 8080
# open http://localhost:8080
```

(Or `npm start`, which runs the same command.)

## Deploy to GitHub Pages

1. Create a new GitHub repo and push the contents of `job-match-app/` to it:
   ```bash
   cd job-match-app
   git init
   git add .
   git commit -m "feat: JobMatch MVP"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The `pages.yml` workflow publishes the site; your URL appears in the Actions run.

## Going live (real jobs)

The sample `data/jobs.json` lets the UI work immediately. To ingest real jobs,
implement the adapters in `scripts/ingest.mjs`, starting with Tier 1 sources in
`scripts/sources.json`. Run locally with:

```bash
node scripts/ingest.mjs --dry-run   # preview
node scripts/ingest.mjs             # write data/jobs.json
```

Then the scheduled `ingest.yml` workflow keeps the data fresh.

Be a good citizen: respect each source's terms and `robots.txt`, prefer official
APIs/RSS where available, and keep request rates polite.

## Ranking rubric

Weighted components (total 100): role fit 25, skills 20, seniority 15, domain 15,
location 10, company 10, freshness/quality 5. Hard filters exclude expired,
internship/trainee, pure sales, and pure engineering/design roles. Thumbs feedback
nudges keyword/company weights locally (capped at ±10).

## Privacy model

- **Public** (safe to commit): job postings and source metadata in `data/jobs.json`.
- **Local only** (never committed, never uploaded): your CV-derived profile,
  preferences, thumbs feedback, and match scores.
- The "Profile & privacy" dialog includes a one-click **Clear all local data**.

Because feedback is local, the app learns per browser/device. Cross-device learning
would require an optional sync layer (out of scope for the MVP).

## Out of scope (for now)

Application tracking, cover-letter generation, CV tailoring, and interview workflow.
The MVP bet is that ranking quality matters more than workflow at this stage.
