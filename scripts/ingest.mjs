#!/usr/bin/env node
// ingest.mjs
// Scheduled ingestion entry point. Reads sources.json, fetches each enabled
// source's RSS/JSON feed, normalizes + deduplicates + freshness-filters the
// results, and writes data/jobs.json (public data only — no personal data).
//
// Only sources with a real, reachable feed/API are enabled. Sources behind
// bot-protected or JS-rendered APIs (Spotify, TUI/Phenom, Hiberus, etc.) are
// disabled until a dedicated adapter is written.
//
// Supported methods: rss, greenhouse, ashby, recruitee, workable, eightfold,
// lever, smartrecruiters, wpajax, html.
// Dependency-free: uses Node 20+ global fetch, a small RSS parser, and JSON.
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

function inferTags(text, extra = [], base = []) {
  // `base` carries the source's sector tags (e.g. wine, fintech, saas). Wine
  // boards pass ["wine"]; tech ATS sources pass their own sector.
  const tags = new Set([...base, ...extra].filter(Boolean).map((t) => t.toLowerCase()));
  for (const [tagName, re] of TAG_RULES) {
    if (re.test(text)) tags.add(tagName);
  }
  return [...tags];
}

// Product/digital relevance filter for large generic tech boards, so we only
// store roles aligned to the profile instead of the company's entire ATS.
const ROLE_INCLUDE = /\b(product owner|product manager|producto|product|growth|digital|e-?commerce|ecommerce|crm|platform|plataforma|personali[sz]ation|marketing|analytic|analytics|data|program manager|project manager|ux\/?ui|ux|discovery|roadmap|merchandising)\b/i;
const ROLE_EXCLUDE_TITLE = /\b(engineer|developer|desarrollador|programador|architect|arquitecto|devops|sre|qa|quality assurance|tester|security|ciberseguridad|sysadmin|system administrator|administrador|scientist|android|ios|frontend|front-?end|backend|back-?end|full-?stack|network)\b/i;

function passesRoleFilter(title, department) {
  const t = `${title} ${department || ""}`;
  if (ROLE_EXCLUDE_TITLE.test(title)) return false;
  return ROLE_INCLUDE.test(t);
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
        tags: inferTags(searchText, [role, department], source.baseTags || ["wine"]),
        salary: null,
      };
    })
    .filter(Boolean);
}

// ---- JSON / ATS adapters ---------------------------------------------------
async function fetchJson(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config.ingestion.userAgent, Accept: "application/json, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const toIso = (d) => {
  if (!d) return null;
  const t = new Date(typeof d === "number" ? d : String(d).replace(" UTC", "Z").replace(" ", "T"));
  return isNaN(t) ? null : t.toISOString().slice(0, 10);
};

function companyFor(source) {
  if (source.company?.from === "fixed") return source.company.value;
  return source.name;
}

// Greenhouse job board API: <board url>?content=true → { jobs:[…] }
async function greenhouseAdapter(source, config) {
  const data = await fetchJson(`${source.url}?content=true`, config);
  const jobs = data.jobs || [];
  return jobs
    .map((j) => {
      const title = decodeEntities(j.title || "");
      const department = (j.departments || []).map((d) => d.name).join(", ");
      if (source.filter && !passesRoleFilter(title, department)) return null;
      const locationText = j.location?.name || source.countryDefault || "";
      const description = stripHtml(j.content || "").slice(0, 800);
      const searchText = `${title} ${description} ${department}`;
      return baseJob(source, {
        url: j.absolute_url,
        title,
        locationText,
        postedDate: toIso(j.updated_at),
        description,
        searchText,
        extraTags: [department],
      });
    })
    .filter(Boolean);
}

// Ashby posting API: { jobs:[…] }
async function ashbyAdapter(source, config) {
  const data = await fetchJson(source.url, config);
  const jobs = data.jobs || [];
  return jobs
    .map((j) => {
      const title = j.title || "";
      const department = [j.department, j.team].filter(Boolean).join(" · ");
      if (source.filter && !passesRoleFilter(title, department)) return null;
      const description = (j.descriptionPlain || "").replace(/\s+/g, " ").trim().slice(0, 800);
      const searchText = `${title} ${description} ${department}`;
      return baseJob(source, {
        url: j.jobUrl || j.applyUrl,
        title,
        locationText: j.location || "",
        postedDate: toIso(j.publishedAt),
        description,
        searchText,
        remote: j.isRemote,
        extraTags: [department],
      });
    })
    .filter(Boolean);
}

// Recruitee offers API: { offers:[…] }
async function recruiteeAdapter(source, config) {
  const data = await fetchJson(source.url, config);
  const offers = data.offers || [];
  return offers
    .map((o) => {
      const title = o.title || "";
      const department = o.department || o.category_code || "";
      if (source.filter && !passesRoleFilter(title, department)) return null;
      const locationText = [o.city, o.country].filter(Boolean).join(", ") || o.location || "";
      const description = stripHtml(o.description || "").slice(0, 800);
      const searchText = `${title} ${description} ${department}`;
      return baseJob(source, {
        url: o.careers_url,
        title,
        locationText,
        postedDate: toIso(o.created_at),
        description,
        searchText,
        remote: /remote/i.test(o.location || ""),
        extraTags: [department],
      });
    })
    .filter(Boolean);
}

// Workable widget API: { jobs:[…] } (list has no description)
async function workableAdapter(source, config) {
  const data = await fetchJson(source.url, config);
  const jobs = data.jobs || [];
  return jobs
    .map((j) => {
      const title = j.title || "";
      const department = [j.department, j.function, j.industry].filter(Boolean).join(" · ");
      if (source.filter && !passesRoleFilter(title, department)) return null;
      const locationText = [j.city, j.state, j.country].filter(Boolean).join(", ");
      const searchText = `${title} ${department}`;
      return baseJob(source, {
        url: j.url || j.shortlink,
        title,
        locationText,
        postedDate: toIso(j.published_on || j.created_at),
        description: department,
        searchText,
        remote: !!j.telecommuting,
        extraTags: [j.department, j.function],
      });
    })
    .filter(Boolean);
}

// Eightfold "explore" API (Netflix): ?query=product → { positions:[…] }
// The API caps each response at 10 positions, so we page via `start` up to a
// sensible ceiling to avoid one large employer dominating the board.
async function eightfoldAdapter(source, config) {
  const cap = source.maxPositions || 60;
  const positions = [];
  for (let start = 0; start < cap; start += 10) {
    const data = await fetchJson(`${source.url}&num=10&start=${start}`, config);
    const page = data.positions || [];
    positions.push(...page);
    if (page.length < 10) break;
  }
  return positions
    .map((p) => {
      const title = p.name || p.posting_name || "";
      const department = [p.department, p.business_unit].filter(Boolean).join(" · ");
      if (source.filter && !passesRoleFilter(title, department)) return null;
      const loc = String(p.location || "").split(",");
      const locationText = [loc[0], loc[loc.length - 1]].filter(Boolean).join(", ");
      const description = stripHtml(p.job_description || "").slice(0, 800);
      const searchText = `${title} ${description} ${department}`;
      return baseJob(source, {
        url: p.canonicalPositionUrl,
        title,
        locationText,
        postedDate: toIso((p.t_create || p.t_update) * 1000),
        description,
        searchText,
        remote: p.work_location_option === "remote",
        extraTags: [department],
      });
    })
    .filter(Boolean);
}

// Lever postings API: [ … ] (array)
async function leverAdapter(source, config) {
  const data = await fetchJson(source.url, config);
  const list = Array.isArray(data) ? data : data.data || [];
  return list
    .map((j) => {
      const title = j.text || "";
      const c = j.categories || {};
      const department = [c.department, c.team].filter(Boolean).join(" · ");
      if (source.filter && !passesRoleFilter(title, department)) return null;
      const description = (j.descriptionPlain || "").replace(/\s+/g, " ").trim().slice(0, 800);
      const searchText = `${title} ${description} ${department}`;
      return baseJob(source, {
        url: j.hostedUrl || j.applyUrl,
        title,
        locationText: c.location || (c.allLocations || []).join(", "),
        postedDate: toIso(Number(j.createdAt) || j.createdAt),
        description,
        searchText,
        remote: /remote/i.test(`${c.workplaceType || ""} ${c.location || ""}`),
        extraTags: [c.department, c.team],
      });
    })
    .filter(Boolean);
}

// SmartRecruiters posting API. Lists postings, then fetches each kept posting's
// detail for the description (only for roles that pass the product filter).
async function smartRecruitersAdapter(source, config) {
  const company = source.companyCode;
  const delay = config.ingestion.requestDelayMs || 400;
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const data = await fetchJson(
      `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100&offset=${offset}`,
      config
    );
    const content = data.content || [];
    for (const p of content) {
      const title = p.name || "";
      const department = p.department?.label || "";
      if (source.filter && !passesRoleFilter(title, department)) continue;
      let description = "";
      try {
        const det = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${p.id}`, config);
        const s = det.jobAd?.sections || {};
        description = stripHtml([s.jobDescription?.text, s.qualifications?.text].filter(Boolean).join(" ")).slice(0, 800);
        await sleep(delay);
      } catch { /* description stays empty */ }
      const loc = p.location || {};
      const locationText = loc.fullLocation || [loc.city, loc.region, (loc.country || "").toUpperCase()].filter(Boolean).join(", ");
      const searchText = `${title} ${description} ${department}`;
      out.push(
        baseJob(source, {
          url: `https://jobs.smartrecruiters.com/${company}/${p.id}`,
          title,
          locationText,
          postedDate: toIso(p.releasedDate),
          description,
          searchText,
          remote: !!loc.remote,
          extraTags: [department, p.industry?.label],
        })
      );
    }
    if (content.length < 100 || offset + 100 >= (data.totalFound || 0)) break;
  }
  return out;
}

// WordPress admin-ajax adapter (Adevinta). POSTs the jobs-search action and
// reads the returned rows. Endpoint is live even when there are 0 open roles.
async function wpAjaxAdapter(source, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${source.ajaxUrl}?action=${source.ajaxAction}`, {
      method: "POST",
      headers: {
        "User-Agent": config.ingestion.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, */*",
      },
      body: "search=&country=&city=&brand=&function=&fulltime_parttime=&job-page=1",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.data || [];
    return items
      .map((it) => {
        const title = stripHtml(it.title || "");
        const department = it.job_family_group || "";
        if (source.filter && !passesRoleFilter(title, department)) return null;
        const city = stripHtml(it.city || "");
        return baseJob(source, {
          url: it.url,
          title,
          locationText: [city, source.countryDefault].filter(Boolean).join(", "),
          postedDate: null,
          description: department,
          searchText: `${title} ${department}`,
          extraTags: [department],
        });
      })
      .filter(Boolean);
  } finally {
    clearTimeout(timeout);
  }
}

function metaContent(html, prop) {
  const m = html.match(new RegExp(`<meta\\s+property="${prop}"\\s+content="([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Config-driven HTML adapter. Reads a listing page for offer links matching
// `linkPattern`, pre-filters slugs (so we don't fetch every engineering role),
// then reads each offer page's OpenGraph tags. Used for Hiberus (Drupal).
async function htmlAdapter(source, config) {
  const listing = await fetchText(source.url, config);
  const pattern = new RegExp(source.linkPattern, "gi");
  const listPath = new URL(source.url).pathname.replace(/\/$/, "");
  const slugs = [...new Set((listing.match(pattern) || []))].filter((p) => p.replace(/\/$/, "") !== listPath);

  const delay = config.ingestion.requestDelayMs || 800;
  const out = [];
  for (const path of slugs) {
    const words = path.split("/").pop().replace(/-/g, " ");
    // Cheap pre-filter on the slug to avoid fetching obvious non-matches.
    if (source.filter && (ROLE_EXCLUDE_TITLE.test(words) || !ROLE_INCLUDE.test(words))) continue;
    const url = path.startsWith("http") ? path : `${source.baseUrl}${path}`;

    // Some boards (e.g. Factorial) are JS-rendered with no OG tags, but the
    // slug encodes the title. Derive it from the slug and skip the page fetch.
    if (source.titleFromSlug) {
      const title = path
        .split("/")
        .pop()
        .replace(/-\d+$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      if (!title || (source.filter && !passesRoleFilter(title, ""))) continue;
      out.push(
        baseJob(source, {
          url,
          title,
          locationText: source.countryDefault || "",
          postedDate: null,
          description: "",
          searchText: title,
          extraTags: [],
        })
      );
      continue;
    }
    try {
      const html = await fetchText(url, config);
      const title = metaContent(html, "og:title") || (html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] || "").trim();
      const description = metaContent(html, "og:description").slice(0, 800);
      if (source.filter && !passesRoleFilter(title, "")) continue;
      out.push(
        baseJob(source, {
          url,
          title,
          locationText: source.countryDefault || "",
          postedDate: null,
          description,
          searchText: `${title} ${description}`,
          extraTags: [],
        })
      );
    } catch (e) {
      console.warn(`    · ${source.name}: skipped ${url} (${e.message})`);
    }
    await sleep(delay);
  }
  return out.filter(Boolean);
}

// Shared builder for JSON adapters.
function baseJob(source, { url, title, locationText, postedDate, description, searchText, remote, extraTags = [] }) {
  if (!title || !url) return null;
  const parts = String(locationText).split(",").map((s) => s.trim());
  const city = parts.length > 1 ? parts[0] : "";
  const country = parts.length ? parts[parts.length - 1] : source.countryDefault || "";
  const workModel = remote ? "remote" : inferWorkModel(`${searchText} ${locationText}`, null);
  return {
    id: slug(url),
    url,
    title,
    company: companyFor(source),
    locationText,
    city,
    country,
    workModel,
    contractType: inferContract(searchText),
    seniority: inferSeniority(searchText),
    postedDate,
    description,
    descriptionQuality: description.length > 120 ? "full" : description ? "partial" : "summary",
    tags: inferTags(searchText, extraTags, source.baseTags || []),
    salary: null,
  };
}

const adapters = {
  rss: rssAdapter,
  greenhouse: greenhouseAdapter,
  ashby: ashbyAdapter,
  recruitee: recruiteeAdapter,
  workable: workableAdapter,
  eightfold: eightfoldAdapter,
  lever: leverAdapter,
  smartrecruiters: smartRecruitersAdapter,
  wpajax: wpAjaxAdapter,
  html: htmlAdapter,
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
