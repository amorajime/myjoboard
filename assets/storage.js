// storage.js
// Local-first storage. Everything here stays in the browser (localStorage).
// Nothing in this module is ever sent to a server or committed to the repo.

const KEYS = {
  profile: "jobmatch.profile",
  feedback: "jobmatch.feedback", // { [jobId]: "up" | "down" }
  signals: "jobmatch.signals", // { [keyword]: weight }
  prefs: "jobmatch.prefs", // UI preferences (sort, filters, freshness window)
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn("storage read failed", key, e);
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("storage write failed", key, e);
  }
}

export const storage = {
  getProfile(fallback) {
    return read(KEYS.profile, fallback);
  },
  saveProfile(profile) {
    write(KEYS.profile, profile);
  },

  getFeedback() {
    return read(KEYS.feedback, {});
  },
  getSignals() {
    return read(KEYS.signals, {});
  },

  // Records thumbs feedback and updates keyword signal weights used by ranking.
  setFeedback(job, vote) {
    const feedback = read(KEYS.feedback, {});
    const signals = read(KEYS.signals, {});
    const previous = feedback[job.id] || null;

    // Undo the previous vote's signal contribution before applying the new one.
    const applySignals = (voteValue, direction) => {
      const keys = [...(job.tags || []), (job.company || "").toLowerCase()];
      for (const key of keys) {
        const k = String(key).toLowerCase();
        const delta = (voteValue === "up" ? 2 : -2) * direction;
        signals[k] = (signals[k] || 0) + delta;
        if (signals[k] === 0) delete signals[k];
      }
    };

    if (previous) applySignals(previous, -1); // remove old contribution

    if (previous === vote) {
      // Toggling the same vote off.
      delete feedback[job.id];
    } else {
      feedback[job.id] = vote;
      applySignals(vote, +1);
    }

    write(KEYS.feedback, feedback);
    write(KEYS.signals, signals);
    return feedback[job.id] || null;
  },

  getPrefs(fallback) {
    return read(KEYS.prefs, fallback);
  },
  savePrefs(prefs) {
    write(KEYS.prefs, prefs);
  },

  // Full local reset (privacy control exposed in the UI).
  clearAll() {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  },
};
