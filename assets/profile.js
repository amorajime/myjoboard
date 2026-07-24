// profile.js
// Defines the default "Ideal Role Profile" used to score jobs locally.
// This profile lives in the browser only. Editing it here just changes the
// starting defaults; user edits are saved to local storage (see storage.js).

export const DEFAULT_PROFILE = {
  label: "Senior Product Manager (default)",

  // Positive title signals: strong role fit.
  roleTitlesPositive: [
    "product manager",
    "senior product manager",
    "product lead",
    "lead product manager",
    "principal product manager",
    "ai product manager",
    "digital product manager",
    "growth product manager",
    "head of product",
    "product owner", // partial credit only, see ranking.js
  ],

  // Digital / product-adjacent roles. On wine-sector boards a role rarely says
  // "Product Manager", but digital / e-commerce / CRM / data / transformation
  // roles are strong matches for a PM moving into wine digitalization.
  digitalRolePositive: [
    "digital",
    "digitalización",
    "digitalizacion",
    "digitalisation",
    "transformación digital",
    "transformacion digital",
    "digital transformation",
    "e-commerce",
    "ecommerce",
    "comercio electrónico",
    "comercio electronico",
    "online",
    "venta directa",
    "dtc",
    "d2c",
    "crm",
    "erp",
    "business central",
    "bi",
    "business intelligence",
    "data",
    "datos",
    "analytics",
    "analítica",
    "analitica",
    "marketing digital",
    "growth",
    "producto digital",
    "innovación",
    "innovacion",
    "platform",
    "plataforma",
    "automatización",
    "automatizacion",
  ],

  // Negative title signals: reduce role fit.
  roleTitlesNegative: [
    "sales",
    "account manager",
    "account executive",
    "business development",
    "graphic designer",
    "designer",
    "ux researcher",
    "frontend engineer",
    "backend engineer",
    "full-stack",
    "developer",
    "sommelier",
    "waiter",
    "camarero",
    "comercial",
    "vendedor",
    "delegado",
    "tractorista",
  ],

  // Seniority signals.
  seniorityPositive: ["senior", "lead", "principal", "head", "strategy", "roadmap", "ownership", "director"],
  seniorityNegative: [
    "intern",
    "internship",
    "trainee",
    "junior",
    "assistant",
    "graduate",
    "prácticas",
    "practicas",
    "becario",
    "aprendiz",
  ],

  // Domain / industry signals.
  domains: [
    "consumer",
    "ai",
    "artificial intelligence",
    "personalization",
    "personalisation",
    "recommendation",
    "video",
    "streaming",
    "media",
    "saas",
    "marketplace",
    "travel",
    "lifestyle",
    "wine",
    "vino",
    "beverage",
    "spirits",
    "bodega",
    "ecommerce",
    "e-commerce",
    "digital commerce",
    "data",
    "fintech",
    "platform",
    "crm",
    "erp",
    "bi",
    "digitalización",
    "digitalizacion",
    "transformación",
    "transformacion",
    "marketing",
    "innovación",
    "innovacion",
  ],

  // Skills / experience signals from the CV.
  skills: [
    "roadmap",
    "discovery",
    "experimentation",
    "a/b",
    "ab test",
    "metrics",
    "kpi",
    "okr",
    "ml",
    "machine learning",
    "personalization",
    "stakeholder",
    "analytics",
    "platform",
    "user research",
    "backlog",
    "prioritization",
    "prioritisation",
    "go-to-market",
    "cross-functional",
    "strategy",
  ],

  // Location signals.
  locationsPositive: ["spain", "españa", "espana", "madrid", "barcelona", "remote", "remoto", "europe", "eu remote"],
  targetCities: ["madrid", "barcelona"],

  // Weights per rubric (must sum to 100).
  weights: {
    role: 25,
    seniority: 15,
    domain: 15,
    skills: 20,
    location: 10,
    company: 10,
    freshness: 5,
  },

  // Display threshold.
  minScore: 60,
};

// Returns a deep copy so callers never mutate the shared default.
export function cloneDefaultProfile() {
  return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
}
