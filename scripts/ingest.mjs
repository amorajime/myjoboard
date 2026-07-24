#!/usr/bin/env node
// ingest.mjs
// Scheduled ingestion entry point. Reads sources.json, fetches each enabled
// source's RSS/JSON feed, normalizes + deduplicates + freshness-filters the
// results, and writes data/jobs.json (public data only — no personal data).
//
// Only sources with a real, reachable feed are enabled. Sources behind
// authenticated/JS-rendered APIs (Vodafone/Eightfold, Founderful/Consider,
// Pearson, Merck) are disabled until a dedicated adapter is written.
//
// Dependency-free: uses Node 20+ global fetch and a small RSS parser.
//
// Usage:
//   node scripts/ingest.mjs            # fetch enabled sources, write data/jobs.json
//   node scripts/ingest.mjs --dry-run  # print results, do not write

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCES_PATH = join(__dirname, "sources.json");
const OUT_PATH = join(ROOT, "data", "jobs.json");
const DRY_RUN = process.argv.includes("--dry-run");

// ---- Tiny RSS helpers (no dependencies) ------------------------------------
function getItems(xml) {
  return xml.match(/<item[\s\S]*?<\/item>/gi) || [];
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return stripCdata(m[1]).trim();
}

function stripCdata(s) {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function stripHtml(s) {
  return decodeEntities(decodeEntities(s))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Text classifiers ------------------------------------------------------
function inferWorkModel(text, remoteStatus) {
  if (remoteStatus) {
    const r = remoteStatus.toLowerCase();
    if (r === "fully" || r === "temporary") return "remote";
    if (r === "hybrid") return "hybrid";
    if (r === "none") return "onsite";
  }
  const t = text.toLowerCase();
  if (/\b(remoto|remote|teletrabajo|100% remoto)\b/.test(t)) return "remote";
  if (/\b(híbrido|hibrido|hybrid|semipresencial)\b/.test(t)) return "hybrid";
  if (/\b(presencial|on-?site|en oficina)\b/.test(t)) return "onsite";
  return "unknown";
}

function inferSeniority(text) {
  const t = text.toLowerCase();
  if (/\b(intern|internship|trainee|prácticas|practicas|becari|aprendiz|graduate program)\b/.test(t)) return "internship";
  if (/\b(senior|sénior|lead|principal|head of|director|jefe|responsable)\b/.test(t)) return "senior";
  if (/\b(junior)\b/.test(t)) return "junior";
  return "unknown";
}

function inferContract(text) {
  const t = text.toLowerCase();
  if (/\b(prácticas|practicas|internship|intern|trainee|becari)\b/.test(t)) return "internship";
  if (/\b(freelance|autónomo|autonomo)\b/.test(t)) return "freelance";
  if (/\b(temporal|campaña|campana|fijo discontinuo|fixed[- ]term|seasonal|vendimia)\b/.test(t)) return "fixed_term";
  if (/\b(indefinido|permanent|permanente)\b/.test(t)) return "permanent";
  return "unknown";
}

const TAG_RULES = [
  ["product", /\b(product manager|product owner|producto|product lead|roadmap)\b/i],
  ["digital", /\b(digital|e-?commerce|ecommerce|online|web|crm|dtc)\b/i],
  ["data", /\b(data|datos|bi|business intelligence|erp|analytic|analítica|analitica)\b/i],
  ["ai", /\b(ai|ia|machine learning|inteligencia artificial)\b/i],
  ["marketing", /\b(marketing|brand|comunicación|comunicacion|social media|content)\b/i],
  ["sales", /\b(comercial|ventas|sales|delegado|account|business development)\b/i],
  ["engineering", /\b(developer|desarrollador|engineer|programador|prestashop)\b/i],
  ["marketplace", /\b(marketplace|distribución|distribucion)\b/i],
];

function inferTags(text, extra = []) {
  const tags = new Set(extra.filter(Boolean).map((t) => t.toLowerCase()));
  tags.add("wine"); // all current sources are wine-sector boards
  for (const [tagName, re] of TAG_RULES) {
    if (re.test(text)) tags.add(tagName);
  }
  return [...tags];
}

// ---- Adapters --------------------------------------------------------------
async function fetchText(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config.ingestion.userAgent, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// RSS adapter that covers both Teamtailor and WordPress (WP Job Manager) feeds.
async function rssAdapter(source, config) {
  const xml = await fetchText(source.url, config);
  const channelTitle = tag(xml, "title") || source.name;
  const items = getItems(xml);

  return items
    .map((block) => {
      const title = decodeEntities(tag(block, "title"));
      const link = tag(block, "link");
      if (!title || !link) return null;

      const rawDesc = tag(block, "content:encoded") || tag(block, "description");
      const description = stripHtml(rawDesc).slice(0, 800);
      const pubDate = tag(block, "pubDate");
      const creator = decodeEntities(tag(block, "dc:creator"));

      // Location (Teamtailor exposes structured fields).
      const city = tag(block, "tt:city");
      const country = tag(block, "tt:country") || source.countryDefault || "";
      const remoteStatus = tag(block, "tt:remoteStatus") || tag(block, "remoteStatus");
      const role = tag(block, "tt:role");
      const department = tag(block, "tt:department");

      const locationText = [city, country].filter(Boolean).join(", ");
      const searchText = `${title} ${description} ${role} ${department}`;

      // Resolve company per source config.
      let company = channelTitle;
      if (source.company?.from === "creator" && creator) company = creator;
      else if (source.company?.from === "fixed") company = source.company.value;

      return {
        id: slug(link),
        url: link,
        title,
        company,
        locationText,
        city,
        country,
        workModel: inferWorkModel(searchText, remoteStatus),
        contractType: inferContract(searchText),
        seniority: inferSeniority(searchText),
        postedDate: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : null,
        description,
        descriptionQuality: description.length > 120 ? "full" : description ? "partial" : "summary",
        tags: inferTags(searchText, [role, department]),
        salary: null,
      };
    })
    .filter(Boolean);
}

const adapters = {
  rss: rssAdapter,
};

// ---- Normalization ---------------------------------------------------------
function normalizeJob(raw, source) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: raw.id || slug(`${source.id}-${raw.title}`),
    source: source.name,
    sourceUrl: source.page || source.url,
    url: raw.url,
    title: (raw.title || "").trim(),
    company: (raw.company || "").trim(),
    locationText: (raw.locationText || "").trim(),
    country: raw.country || "",
    city: raw.city || "",
    workModel: raw.workModel || "unknown",
    contractType: raw.contractType || "unknown",
    seniority: raw.seniority || "unknown",
    postedDate: raw.postedDate || null,
    firstSeen: today,
    lastChecked: today,
    isExpired: false,
    salary: raw.salary || null,
    description: raw.description || "",
    descriptionQuality: raw.descriptionQuality || "summary",
    tags: raw.tags || [],
    sourceHistory: [source.name],
  };
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 90);
}

// ---- Dedup + freshness -----------------------------------------------------
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
    const keep = (job.description || "").length > (existing.description || "").length ? job : existing;
    const other = keep === job ? existing : job;
    keep.sourceHistory = [...new Set([...(existing.sourceHistory || []), ...(job.sourceHistory || [])])];
    keep.firstSeen = minStr(existing.firstSeen, job.firstSeen);
    keep.lastChecked = maxStr(existing.lastChecked, job.lastChecked);
    if (!keep.postedDate) keep.postedDate = other.postedDate;
    byKey.set(key, keep);
  }
  return [...byKey.values()];
}

const minStr = (a, b) => (a && b ? (a < b ? a : b) : a || b);
const maxStr = (a, b) => (a && b ? (a > b ? a : b) : a || b);

function withinFreshness(job, days) {
  const d = job.postedDate || job.firstSeen;
  if (!d) return true;
  const ageDays = (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= days;
}

// ---- Main ------------------------------------------------------------------
async function main() {
  const config = JSON.parse(await readFile(SOURCES_PATH, "utf8"));
  const { freshnessDays, excludeExpired } = config.ingestion;
  // Store a wider window than the UI default so the "14 / 30 days / Any time"
  // filters are meaningful and lower-frequency digital roles are not dropped.
  const storeMaxAgeDays = config.ingestion.storeMaxAgeDays || freshnessDays;
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
      const raw = await adapter(source, config);
      const normalized = raw.map((r) => normalizeJob(r, source));
      console.log(`  - ${source.name}: ${normalized.length} job(s)`);
      collected.push(...normalized);
    } catch (e) {
      console.error(`  ! ${source.name} failed: ${e.message}`);
    }
  }

  if (collected.length === 0) {
    console.log("\nNo jobs fetched. Leaving data/jobs.json untouched.");
    return;
  }

  let jobs = dedupe(collected);
  if (excludeExpired) jobs = jobs.filter((j) => !j.isExpired);
  const total = jobs.length;
  jobs = jobs.filter((j) => withinFreshness(j, storeMaxAgeDays));
  jobs.sort((a, b) => (b.postedDate || "").localeCompare(a.postedDate || ""));

  const output = { generatedAt: new Date().toISOString(), freshnessDays, storeMaxAgeDays, jobs };

  if (DRY_RUN) {
    console.log(`\n(dry-run) ${jobs.length}/${total} job(s) within ${storeMaxAgeDays} days`);
    console.log(JSON.stringify(output.jobs.slice(0, 3), null, 2));
    return;
  }

  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${jobs.length} job(s) to data/jobs.json (within ${storeMaxAgeDays} days; UI defaults to ${freshnessDays})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
