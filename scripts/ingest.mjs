#!/usr/bin/env node
// ingest.mjs
// Scheduled ingestion entry point. Reads sources.json, runs a per-source
// adapter, normalizes + deduplicates + freshness-filters the results, and
// writes data/jobs.json (public data only — no personal/user data).
//
// Adapters are intentionally stubbed: each site needs its own parser, and
// scraping must respect each source's terms and rate limits. Implement the
// adapters in `adapters` below one source at a time (Tier 1 first).
//
// Usage:
//   node scripts/ingest.mjs            # run all enabled sources, keep sample data if none implemented
//   node scripts/ingest.mjs --dry-run  # print results, do not write

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCES_PATH = join(__dirname, "sources.json");
const OUT_PATH = join(ROOT, "data", "jobs.json");

const DRY_RUN = process.argv.includes("--dry-run");

// ---- Adapter registry -------------------------------------------------------
// Each adapter receives its source config and returns an array of raw jobs.
// Return [] until implemented. Keep requests polite (see config.ingestion).
const adapters = {
  async "static-html"(source) {
    // TODO: fetch(source.url) then parse with a DOM parser / regex.
    // Return raw job objects (see normalizeJob for the target shape).
    return [];
  },
  async "dynamic-or-api"(source) {
    // TODO: locate the underlying JSON API (often available behind these boards)
    // and fetch it directly instead of rendering HTML.
    return [];
  },
  async "dynamic-eightfold"(source) {
    // TODO: Eightfold exposes a search API; reverse-engineer the request.
    return [];
  },
};

// ---- Normalization ----------------------------------------------------------
function normalizeJob(raw, source) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: raw.id || slug(`${source.id}-${raw.title}-${raw.company}`),
    source: source.name,
    sourceUrl: source.url,
    url: raw.url || source.url,
    title: (raw.title || "").trim(),
    company: (raw.company || "").trim(),
    locationText: (raw.locationText || "").trim(),
    country: raw.country || "",
    city: raw.city || "",
    workModel: raw.workModel || "unknown",
    contractType: raw.contractType || "unknown",
    seniority: raw.seniority || "unknown",
    postedDate: raw.postedDate || null,
    firstSeen: raw.firstSeen || today,
    lastChecked: today,
    isExpired: Boolean(raw.isExpired),
    salary: raw.salary || null,
    description: raw.description || "",
    descriptionQuality: raw.descriptionQuality || (raw.description ? "partial" : "missing"),
    tags: raw.tags || [],
    sourceHistory: [source.name],
  };
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

// ---- Dedup + freshness ------------------------------------------------------
function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dedupe(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = job.url || `${job.company}|${normTitle(job.title)}|${job.city}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, job);
      continue;
    }
    // Keep the most complete description; merge source history + dates.
    const keep = (job.description || "").length > (existing.description || "").length ? job : existing;
    const other = keep === job ? existing : job;
    keep.sourceHistory = [...new Set([...(existing.sourceHistory || []), ...(job.sourceHistory || [])])];
    keep.firstSeen = min(existing.firstSeen, job.firstSeen);
    keep.lastChecked = max(existing.lastChecked, job.lastChecked);
    if (!keep.postedDate) keep.postedDate = other.postedDate;
    byKey.set(key, keep);
  }
  return [...byKey.values()];
}

function min(a, b) {
  return a && b ? (a < b ? a : b) : a || b;
}
function max(a, b) {
  return a && b ? (a > b ? a : b) : a || b;
}

function withinFreshness(job, days) {
  const d = job.postedDate || job.firstSeen;
  if (!d) return true;
  const ageDays = (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= days;
}

// ---- Main -------------------------------------------------------------------
async function main() {
  const config = JSON.parse(await readFile(SOURCES_PATH, "utf8"));
  const { freshnessDays, excludeExpired } = config.ingestion;
  const enabled = config.sources.filter((s) => s.enabled);

  console.log(`Ingesting from ${enabled.length} enabled source(s)…`);

  let collected = [];
  for (const source of enabled) {
    const adapter = adapters[source.method];
    if (!adapter) {
      console.warn(`  ! No adapter for method "${source.method}" (${source.name})`);
      continue;
    }
    try {
      const raw = await adapter(source);
      const normalized = raw.map((r) => normalizeJob(r, source));
      console.log(`  - ${source.name}: ${normalized.length} job(s)`);
      collected.push(...normalized);
    } catch (e) {
      console.error(`  ! ${source.name} failed: ${e.message}`);
    }
  }

  if (collected.length === 0) {
    console.log("\nNo adapters have been implemented yet, so no new jobs were fetched.");
    console.log("Keeping the existing data/jobs.json (sample data) untouched.");
    console.log("Implement an adapter in scripts/ingest.mjs to go live (start with Tier 1 sources).");
    return;
  }

  let jobs = dedupe(collected);
  if (excludeExpired) jobs = jobs.filter((j) => !j.isExpired);
  jobs = jobs.filter((j) => withinFreshness(j, freshnessDays));

  const output = {
    generatedAt: new Date().toISOString(),
    freshnessDays,
    jobs,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${jobs.length} job(s) to data/jobs.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
