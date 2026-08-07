// app.js
// Wires together data loading, local profile, ranking, filtering, sorting,
// rendering and thumbs feedback. Runs fully client-side.

import { cloneDefaultProfile } from "./profile.js";
import { storage } from "./storage.js";
import { scoreJob, freshnessDays } from "./ranking.js";

const el = (id) => document.getElementById(id);

const state = {
  jobs: [],
  profile: null,
  generatedAt: null,
};

const controls = {
  searchText: el("searchText"),
  searchLocation: el("searchLocation"),
  category: el("filterCategory"),
  jobType: el("filterJobType"),
  companySource: el("filterCompanySource"),
  location: el("filterLocation"),
  remote: el("filterRemote"),
  score: el("filterScore"),
  freshness: el("filterFreshness"),
  sortBy: el("sortBy"),
};

async function init() {
  state.profile = storage.getProfile(cloneDefaultProfile());
  bindEvents();

  try {
    const res = await fetch("./data/jobs.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.jobs = data.jobs || [];
    state.generatedAt = data.generatedAt || null;
  } catch (e) {
    console.error("Failed to load jobs.json", e);
    renderError();
    return;
  }
  populateCompanySourceFilter();
  restorePrefs();
  render();
}

function bindEvents() {
  [
    controls.searchText,
    controls.searchLocation,
    controls.category,
    controls.jobType,
    controls.companySource,
    controls.location,
    controls.remote,
    controls.score,
    controls.freshness,
    controls.sortBy,
  ].forEach((c) => {
    if (!c) return;
    const evt = c.tagName === "INPUT" ? "input" : "change";
    c.addEventListener(evt, () => {
      savePrefs();
      render();
    });
  });

  el("showFiltered").addEventListener("change", () => {
    savePrefs();
    render();
  });

  el("applyFilters").addEventListener("click", render);
  el("profileBtn").addEventListener("click", openProfile);
  el("profileDialog").addEventListener("close", handleProfileClose);
  el("resetLocal").addEventListener("click", () => {
    storage.clearAll();
    state.profile = cloneDefaultProfile();
    render();
    el("profileDialog").close("cancel");
  });
}

// ---- Preferences persistence ----
function savePrefs() {
  storage.savePrefs({
    searchText: controls.searchText.value,
    searchLocation: controls.searchLocation.value,
    category: controls.category.value,
    jobType: controls.jobType.value,
    companySource: controls.companySource.value,
    location: controls.location.value,
    remote: controls.remote.value,
    score: controls.score.value,
    freshness: controls.freshness.value,
    sortBy: controls.sortBy.value,
    showFiltered: el("showFiltered").checked,
  });
}

function restorePrefs() {
  const p = storage.getPrefs(null);
  if (!p) return;
  for (const [key, control] of Object.entries(controls)) {
    if (!control || p[key] == null) continue;
    control.value = p[key];
    // Guard against stale saved values that no longer exist as <select> options.
    if (control.tagName === "SELECT" && control.selectedIndex === -1) {
      control.selectedIndex = 0;
    }
  }
  if (p.showFiltered != null) el("showFiltered").checked = p.showFiltered;
}

function populateCompanySourceFilter() {
  const values = new Set();
  for (const job of state.jobs) {
    if (job.company) values.add(job.company.trim());
    if (job.source) values.add(job.source.trim());
  }

  for (const value of [...values].filter(Boolean).sort((a, b) => a.localeCompare(b))) {
    const option = document.createElement("option");
    option.value = value.toLowerCase();
    option.textContent = value;
    controls.companySource.appendChild(option);
  }
}

// ---- Rendering ----
function render() {
  const feedback = storage.getFeedback();
  const signals = storage.getSignals();
  const minScore = Number(controls.score.value || 20);
  const freshnessWindow = Number(controls.freshness.value || 7);

  // Score every job locally.
  let scored = state.jobs.map((job) => {
    const result = scoreJob(job, state.profile, signals);
    return { job, ...result, days: freshnessDays(job), vote: feedback[job.id] || null };
  });

  // Classify each job: either a visible match, or filtered out with a reason.
  const visible = [];
  const filtered = [];
  for (const s of scored) {
    const reason = dropReason(s, minScore, freshnessWindow);
    if (reason) filtered.push({ ...s, dropReason: reason });
    else visible.push(s);
  }

  // Sort matches.
  if (controls.sortBy.value === "newest") {
    visible.sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));
  } else {
    visible.sort((a, b) => b.score - a.score);
  }
  // Sort filtered by score so the "closest" near-misses show first.
  filtered.sort((a, b) => b.score - a.score);

  updateSummary(visible.length, scored.length, filtered.length);
  renderList(visible, feedback);
  renderFiltered(el("showFiltered").checked ? filtered : []);
}

// Returns the reason a job is not shown, or null if it is a visible match.
function dropReason(s, minScore, freshnessWindow) {
  if (s.vote === "down") return "You gave this role a thumbs down";
  if (s.excluded) return s.reason || "Filtered out";
  if (!(s.days === null || s.days <= freshnessWindow)) {
    return freshnessWindow === 0 ? "Older than 24 hours" : `Older than ${freshnessWindow} days`;
  }
  if (!matchesUiFilters(s.job)) return "Doesn't match current filters";
  if (s.score < minScore) return `Below ${minScore}% match (scored ${s.score}%)`;
  return null;
}

function matchesUiFilters(job) {
  const text = `${job.title} ${job.company}`.toLowerCase();
  const loc = `${job.locationText} ${job.city} ${job.country}`.toLowerCase();
  const tags = (job.tags || []).map((t) => t.toLowerCase());

  const st = controls.searchText.value.trim().toLowerCase();
  if (st && !text.includes(st)) return false;

  const sl = controls.searchLocation.value.trim().toLowerCase();
  if (sl && !loc.includes(sl)) return false;

  const cat = controls.category.value;
  if (cat && !tags.includes(cat)) return false;

  const jt = controls.jobType.value;
  if (jt && job.contractType !== jt) return false;

  const companySource = controls.companySource.value;
  if (
    companySource &&
    ![job.company, job.source].some((value) => String(value || "").toLowerCase() === companySource)
  ) {
    return false;
  }

  const locFilter = controls.location.value;
  if (locFilter) {
    if (locFilter === "remote" && job.workModel !== "remote") return false;
    if (locFilter !== "remote" && !loc.includes(locFilter)) return false;
  }

  const remote = controls.remote.value;
  if (remote && job.workModel !== remote) return false;

  return true;
}

function updateSummary(count, total, filteredCount) {
  const suffix = state.generatedAt
    ? ` · data updated ${new Date(state.generatedAt).toLocaleDateString()}`
    : "";
  const filteredNote = filteredCount ? ` · ${filteredCount} filtered out` : "";
  el("resultsSummary").textContent =
    `${count} match${count === 1 ? "" : "es"} (of ${total} scanned)${filteredNote}${suffix}`;
}

function renderList(items, feedback) {
  const list = el("jobList");
  list.innerHTML = "";

  if (!items.length) {
    list.innerHTML = `
      <div class="empty">
        <h3>No matches right now</h3>
        <p>Only jobs from the selected freshness window and above your match threshold are shown.
        Try lowering the match filter, widening the date range, or check back after the next crawl.</p>
      </div>`;
    return;
  }

  for (const item of items) {
    list.appendChild(renderCard(item, feedback[item.job.id] || null));
  }
}

function renderFiltered(items) {
  const existing = el("filteredList");
  if (existing) existing.remove();
  if (!items.length) return;

  const section = document.createElement("section");
  section.id = "filteredList";
  section.className = "filtered-list";

  const heading = document.createElement("h2");
  heading.className = "filtered-heading";
  heading.textContent = `Filtered out (${items.length})`;
  section.appendChild(heading);

  for (const item of items) {
    const { job, dropReason, vote } = item;
    const row = document.createElement("div");
    row.className = "filtered-row";
    row.innerHTML = `
      <div class="filtered-main">
        <a class="filtered-title" href="${escapeAttr(job.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.title)}</a>
        <span class="filtered-meta">${escapeHtml([job.company, job.locationText, job.source].filter(Boolean).join(" · "))}</span>
      </div>
      <div class="filtered-actions">
        <span class="filtered-reason">${escapeHtml(dropReason)}</span>
        ${
          vote === "down"
            ? '<button class="thumb active-down" data-undo-down type="button" title="Undo thumbs down">&#128078;</button>'
            : ""
        }
      </div>`;
    row.querySelector("[data-undo-down]")?.addEventListener("click", () => {
      storage.setFeedback(job, "down");
      render();
    });
    section.appendChild(row);
  }

  el("jobList").after(section);
}

function initials(company) {
  return (company || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function renderCard(item, vote) {
  const { job, score, explanations, days } = item;
  const card = document.createElement("article");
  card.className = "job-card";

  const scoreClass = score >= 75 ? "score" : "score mid";
  const posted =
    days === 0 ? "Today" : days === 1 ? "1 day ago" : days != null ? `${days} days ago` : "recently";

  const metaParts = [job.company, prettyContract(job.contractType), prettyModel(job.workModel), job.locationText]
    .filter(Boolean)
    .join(" · ");

  const tagsHtml = (job.tags || [])
    .slice(0, 5)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");

  const whyHtml = explanations.map((e) => `<li>${escapeHtml(e)}</li>`).join("");

  card.innerHTML = `
    <div class="logo">${initials(job.company)}</div>
    <div class="job-main">
      <h3>${escapeHtml(job.title)}</h3>
      <p class="job-meta">${escapeHtml(metaParts)}</p>
      <div class="tags">${tagsHtml}</div>
      <ul class="why">${whyHtml}</ul>
      <a class="job-link" href="${escapeAttr(job.url)}" target="_blank" rel="noopener noreferrer">View original post &rarr;</a>
    </div>
    <div class="job-side">
      <span class="${scoreClass}">${score}% match</span>
      <span class="posted">${posted} · ${escapeHtml(job.source)}</span>
      <div class="feedback">
        <button class="thumb ${vote === "up" ? "active-up" : ""}" data-vote="up" title="Show more like this">&#128077;</button>
        <button class="thumb ${vote === "down" ? "active-down" : ""}" data-vote="down" title="Show fewer like this">&#128078;</button>
      </div>
    </div>`;

  card.querySelectorAll(".thumb").forEach((btn) => {
    btn.addEventListener("click", () => {
      storage.setFeedback(job, btn.dataset.vote);
      render(); // rescore with updated signals
    });
  });

  return card;
}

function prettyContract(c) {
  return { permanent: "Permanent", fixed_term: "Fixed term", freelance: "Freelance", internship: "Internship" }[c] || "";
}
function prettyModel(m) {
  return { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite", flexible: "Flexible" }[m] || "";
}

function renderError() {
  el("resultsSummary").textContent = "Could not load job data.";
  el("jobList").innerHTML = `
    <div class="empty">
      <h3>Job data unavailable</h3>
      <p>The app could not load <code>data/jobs.json</code>. If you are opening the file directly,
      run a local server instead (see the README), because browsers block <code>fetch</code> on <code>file://</code>.</p>
    </div>`;
}

// ---- Profile dialog ----
function openProfile() {
  const p = state.profile;
  el("profileLabel").value = p.label || "";
  el("profileRoles").value = (p.roleTitlesPositive || []).join(", ");
  el("profileDomains").value = (p.domains || []).join(", ");
  el("profileCities").value = (p.targetCities || []).join(", ");
  el("profileDialog").showModal();
}

function handleProfileClose() {
  if (el("profileDialog").returnValue !== "save") return;
  const p = state.profile;
  p.label = el("profileLabel").value.trim() || p.label;
  p.roleTitlesPositive = splitList(el("profileRoles").value);
  p.domains = splitList(el("profileDomains").value);
  p.targetCities = splitList(el("profileCities").value);
  storage.saveProfile(p);
  render();
}

function splitList(v) {
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ---- Helpers ----
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

init();
