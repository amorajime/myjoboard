// ranking.js
// Transparent, rules-based ranking. Runs entirely in the browser so the
// user's profile and feedback never leave the device.

function haystack(job) {
  return [job.title, job.company, job.description, (job.tags || []).join(" "), job.locationText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function countHits(text, terms) {
  let hits = 0;
  const matched = [];
  for (const term of terms) {
    if (term && text.includes(term.toLowerCase())) {
      hits += 1;
      matched.push(term);
    }
  }
  return { hits, matched };
}

// Hard filters: return a reason string if the job should be excluded, else null.
export function hardFilterReason(job) {
  const title = (job.title || "").toLowerCase();
  const text = haystack(job);

  if (job.isExpired) return "Expired or covered";

  if (
    job.seniority === "internship" ||
    /\b(intern|internship|trainee|prácticas|practicas|becario|graduate program)\b/.test(text)
  ) {
    return "Internship / trainee role";
  }

  // Pure sales / commercial (and not a product role).
  const salesish = /\b(sales|account manager|account executive|business development|comercial|delegado|vendedor)\b/.test(title);
  const productish = /\b(product manager|product owner|product lead|head of product|producto)\b/.test(title);
  if (salesish && !productish) return "Pure sales / commercial role";

  // Pure engineering / design execution.
  const engDesign = /\b(developer|desarrollador|engineer|graphic designer|diseñador|tractorista|prestashop)\b/.test(title);
  if (engDesign && !productish) return "Engineering / design execution role";

  return null;
}

function scoreRole(text, profile) {
  const pos = countHits(text, profile.roleTitlesPositive);
  const neg = countHits(text, profile.roleTitlesNegative);
  let ratio = 0;
  if (pos.hits >= 1) ratio = 1;
  if (/\bproduct owner\b/.test(text) && !/\bproduct manager|product lead|head of product\b/.test(text)) {
    ratio = 0.6; // partial credit for PO-only titles
  }
  ratio -= neg.hits * 0.25;
  ratio = Math.max(0, Math.min(1, ratio));
  return { points: ratio * profile.weights.role, matched: pos.matched };
}

function scoreSeniority(text, job, profile) {
  const pos = countHits(text, profile.seniorityPositive);
  const neg = countHits(text, profile.seniorityNegative);
  let ratio = 0.5; // neutral baseline when unclear
  if (job.seniority === "senior" || job.seniority === "lead" || job.seniority === "executive") ratio = 1;
  if (pos.hits >= 1) ratio = Math.max(ratio, 0.9);
  if (neg.hits >= 1) ratio = 0.1;
  return { points: ratio * profile.weights.seniority, matched: pos.matched };
}

function scoreDomain(text, profile) {
  const { hits, matched } = countHits(text, profile.domains);
  const ratio = Math.min(1, hits / 3);
  return { points: ratio * profile.weights.domain, matched };
}

function scoreSkills(text, profile) {
  const { hits, matched } = countHits(text, profile.skills);
  const ratio = Math.min(1, hits / 4);
  return { points: ratio * profile.weights.skills, matched };
}

function scoreLocation(job, profile) {
  const text = `${job.locationText} ${job.country} ${job.city} ${job.workModel}`.toLowerCase();
  const city = (job.city || "").toLowerCase();
  let ratio = 0.3;
  if (job.workModel === "remote") ratio = 1;
  else if (job.workModel === "hybrid" && profile.targetCities.some((c) => city.includes(c))) ratio = 1;
  else if (profile.targetCities.some((c) => city.includes(c))) ratio = 0.8;
  else if (/spain|españa|espana|europe/.test(text)) ratio = 0.6;
  if (job.workModel === "onsite" && !profile.targetCities.some((c) => city.includes(c))) ratio = 0.1;
  return { points: ratio * profile.weights.location };
}

function scoreCompany(text, profile) {
  const signals = ["startup", "scaleup", "consumer", "platform", "digital", "innovation", "marketplace", "saas", "product-led"];
  const { hits } = countHits(text, signals);
  const ratio = Math.min(1, 0.4 + hits * 0.2);
  return { points: ratio * profile.weights.company };
}

function scoreFreshness(job, profile) {
  const days = freshnessDays(job);
  let ratio = 0.5;
  if (days !== null && days <= 7) ratio = 1;
  if (job.descriptionQuality === "full") ratio = Math.max(ratio, 0.9);
  if (job.descriptionQuality === "missing") ratio = Math.min(ratio, 0.3);
  return { points: ratio * profile.weights.freshness };
}

export function freshnessDays(job) {
  const dateStr = job.postedDate || job.firstSeen;
  if (!dateStr) return null;
  const posted = new Date(dateStr);
  if (isNaN(posted.getTime())) return null;
  const diff = Date.now() - posted.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// Feedback adjustment based on locally stored signal weights.
function feedbackAdjustment(job, feedbackSignals) {
  if (!feedbackSignals) return { points: 0, liked: [], disliked: [] };
  const keys = [...(job.tags || []), (job.company || "").toLowerCase()];
  let points = 0;
  const liked = [];
  const disliked = [];
  for (const key of keys) {
    const w = feedbackSignals[key.toLowerCase?.() || key];
    if (typeof w === "number" && w !== 0) {
      points += w;
      if (w > 0) liked.push(key);
      else disliked.push(key);
    }
  }
  // Clamp the total feedback swing to +/- 10 points.
  points = Math.max(-10, Math.min(10, points));
  return { points, liked, disliked };
}

// Main scoring function. Returns { score, excluded, reason, explanations }.
export function scoreJob(job, profile, feedbackSignals) {
  const reason = hardFilterReason(job);
  if (reason) {
    return { score: 0, excluded: true, reason, explanations: [] };
  }

  const text = haystack(job);
  const role = scoreRole(text, profile);
  const seniority = scoreSeniority(text, job, profile);
  const domain = scoreDomain(text, profile);
  const skills = scoreSkills(text, profile);
  const location = scoreLocation(job, profile);
  const company = scoreCompany(text, profile);
  const freshness = scoreFreshness(job, profile);
  const feedback = feedbackAdjustment(job, feedbackSignals);

  let raw =
    role.points +
    seniority.points +
    domain.points +
    skills.points +
    location.points +
    company.points +
    freshness.points +
    feedback.points;

  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const explanations = buildExplanations({
    job,
    role,
    seniority,
    domain,
    skills,
    location,
    company,
    feedback,
    profile,
  });

  return { score, excluded: false, reason: null, explanations };
}

function buildExplanations({ job, role, seniority, domain, skills, location, feedback, profile }) {
  const out = [];
  const roleMax = profile.weights.role;
  const senMax = profile.weights.seniority;

  if (role.points >= roleMax * 0.8) {
    out.push("Strong role fit: title clearly matches a product management track.");
  } else if (role.points >= roleMax * 0.4) {
    out.push("Partial role fit: product-adjacent, but ownership is not fully clear.");
  } else {
    out.push("Weak role fit: title does not clearly map to a PM role.");
  }

  if (seniority.points >= senMax * 0.8) {
    out.push("Good seniority match: appears to be a senior-level role.");
  } else if (seniority.points <= senMax * 0.3) {
    out.push("Lower seniority confidence: may be below senior scope.");
  }

  if (domain.matched && domain.matched.length) {
    out.push(`Domain fit: overlaps with ${domain.matched.slice(0, 3).join(", ")}.`);
  }

  if (skills.matched && skills.matched.length) {
    out.push(`Skills match: mentions ${skills.matched.slice(0, 3).join(", ")}.`);
  }

  const loc = location.points;
  if (loc >= profile.weights.location * 0.8) {
    out.push(`Location fit: ${job.workModel} and compatible with Spain/Madrid/Barcelona.`);
  } else if (loc <= profile.weights.location * 0.3) {
    out.push("Location risk: appears onsite outside your target cities.");
  }

  if (feedback.points > 0 && feedback.liked.length) {
    out.push(`Boosted because you liked similar roles (${feedback.liked.slice(0, 2).join(", ")}).`);
  } else if (feedback.points < 0 && feedback.disliked.length) {
    out.push(`Lowered because you passed on similar roles (${feedback.disliked.slice(0, 2).join(", ")}).`);
  }

  return out.slice(0, 5);
}
