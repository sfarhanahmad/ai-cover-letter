/* ═══════════════════════════════════════════════════════
   CoverCraft AI — Shared Utilities
   ═══════════════════════════════════════════════════════ */

// ── Theme ─────────────────────────────────────────────
(function initTheme() {
  const stored = localStorage.getItem("cc-theme");
  if (stored) {
    document.documentElement.setAttribute("data-theme", stored);
  } else {
    // Respect system preference on first visit
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = prefersDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cc-theme", theme);
  }
})();

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("cc-theme", next);
  // Update all toggle buttons
  document.querySelectorAll(".theme-toggle").forEach(btn => {
    btn.textContent = next === "dark" ? "☀️" : "🌙";
  });
}

function getThemeIcon() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";
}

// ── Toast ─────────────────────────────────────────────
let toastContainer;
function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-container";
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

function showToast(message, type = "info", duration = 3000) {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity .3s ease";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── API call with error handling ──────────────────────
async function apiCall(body) {
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(data.error || "Something went wrong."), {
        status: res.status,
        limitReached: data.limitReached,
        retryAfter: data.retryAfter,
      });
    }
    return data;
  } catch (err) {
    if (err.name === "TypeError") {
      throw new Error("Network error — check your connection and try again.");
    }
    throw err;
  }
}

// ── Usage ─────────────────────────────────────────────
let cachedUsage = null;
let usageFetchTime = 0;

async function fetchUsage(force = false) {
  const now = Date.now();
  if (!force && cachedUsage && now - usageFetchTime < 30000) return cachedUsage;
  try {
    const data = await apiCall({ action: "usage" });
    cachedUsage = data;
    usageFetchTime = now;
    return data;
  } catch {
    return null;
  }
}

function invalidateUsageCache() {
  cachedUsage = null;
}

function renderUsageBars(usage, containerId) {
  const container = document.getElementById(containerId);
  if (!container || !usage) return;

  const bars = [
    { label: "Cover Letters",   used: usage.lettersUsed,      limit: usage.lettersLimit      },
    { label: "LinkedIn",        used: usage.linkedinUsed,     limit: usage.linkedinLimit     },
    { label: "Interview Prep",  used: usage.interviewUsed,    limit: usage.interviewLimit    },
    { label: "Letter Scoring",  used: usage.scoreUsed,        limit: usage.scoreLimit        },
    { label: "Email Subjects",  used: usage.emailSubjectUsed, limit: usage.emailSubjectLimit },
    { label: "Thank-You Emails",used: usage.thankYouUsed,     limit: usage.thankYouLimit     },
    { label: "CV Scoring",      used: usage.cvScoreUsed,      limit: usage.cvScoreLimit      },
    { label: "Humanizer Words", used: usage.wordsUsed,        limit: usage.wordsLimit        },
  ];

  container.innerHTML = bars.map(b => {
    const pct = Math.min(100, Math.round((b.used / b.limit) * 100));
    const cls = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "";
    return `
      <div class="usage-bar-wrap">
        <div class="usage-bar-label">
          <span>${b.label}</span>
          <span>${b.used} / ${b.limit}</span>
        </div>
        <div class="usage-bar-track">
          <div class="usage-bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
      </div>`;
  }).join("");
}

// ── Inline limit badge ────────────────────────────────
function makeLimitBadge(used, limit, label) {
  const pct = (used / limit) * 100;
  const cls = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "";
  return `<span class="limit-badge ${cls}" title="${label}: ${used}/${limit}/day">
    ${used}/${limit} today
  </span>`;
}

// ── LocalStorage save/load ────────────────────────────
const SAVE_PREFIX = "cc_save_";

function saveToStorage(key, data) {
  try {
    localStorage.setItem(SAVE_PREFIX + key, JSON.stringify({ data, saved: Date.now() }));
    return true;
  } catch { return false; }
}

function loadFromStorage(key) {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + key);
    if (!raw) return null;
    const { data, saved } = JSON.parse(raw);
    return { data, saved: new Date(saved) };
  } catch { return null; }
}

function clearStorage(key) {
  localStorage.removeItem(SAVE_PREFIX + key);
}

function formatSavedDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Image upload helper ───────────────────────────────
function initImageUpload(wrapId, previewId, onLoad) {
  const wrap = document.getElementById(wrapId);
  const preview = document.getElementById(previewId);
  if (!wrap) return;

  const input = wrap.querySelector("input[type=file]");
  const label = wrap.querySelector(".img-upload-label");
  let removeBtn = wrap.querySelector(".img-remove-btn");

  function setImage(dataUrl) {
    preview.src = dataUrl;
    preview.style.display = "block";
    wrap.classList.add("has-img");
    if (label) label.style.display = "none";
    if (!removeBtn) {
      removeBtn = document.createElement("button");
      removeBtn.className = "img-remove-btn";
      removeBtn.textContent = "✕ Remove photo";
      removeBtn.type = "button";
      removeBtn.onclick = clearImage;
      wrap.appendChild(removeBtn);
    }
    if (onLoad) onLoad(dataUrl);
  }

  function clearImage() {
    preview.src = "";
    preview.style.display = "none";
    wrap.classList.remove("has-img");
    if (label) label.style.display = "";
    if (removeBtn) { removeBtn.remove(); removeBtn = null; }
    input.value = "";
    if (onLoad) onLoad(null);
  }

  input.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { showToast("Please select an image file.", "error"); return; }
    if (file.size > 5 * 1024 * 1024) { showToast("Image must be under 5 MB.", "error"); return; }
    const reader = new FileReader();
    reader.onload = ev => setImage(ev.target.result);
    reader.readAsDataURL(file);
  });

  // Drag & drop
  wrap.addEventListener("dragover", e => { e.preventDefault(); wrap.style.borderColor = "var(--blue)"; });
  wrap.addEventListener("dragleave", () => wrap.style.borderColor = "");
  wrap.addEventListener("drop", e => {
    e.preventDefault(); wrap.style.borderColor = "";
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = ev => setImage(ev.target.result);
    reader.readAsDataURL(file);
  });
}

// ── Nav builder ───────────────────────────────────────
function buildNav(activePage) {
  const pages = [
    { href: "/",              label: "Cover Letter" },
    { href: "/linkedin.html", label: "LinkedIn"     },
    { href: "/interview.html",label: "Interview"    },
    { href: "/score.html",    label: "Score"        },
    { href: "/email.html",    label: "Email Tools"  },
    { href: "/cv.html",       label: "CV Builder"   },
    { href: "/cv-score.html", label: "CV Score"     },
  ];

  const links = pages.map(p => `
    <a href="${p.href}" class="${p.href === activePage ? 'active' : ''}">${p.label}</a>
  `).join("");

  return `
  <nav class="nav" id="mainNav">
    <div class="nav-inner">
      <a href="/" class="nav-brand" style="text-decoration:none">
        ✦ CoverCraft AI
      </a>
      <div class="nav-links">${links}</div>
      <div class="nav-actions">
        <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">${getThemeIcon()}</button>
        <button class="hamburger" onclick="toggleMobileMenu()" aria-label="Menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>
    <div class="mobile-menu" id="mobileMenu">${links}</div>
  </nav>`;
}

function toggleMobileMenu() {
  document.getElementById("mobileMenu").classList.toggle("open");
}

// ── Copy to clipboard ─────────────────────────────────
function copyText(text, btnEl) {
  navigator.clipboard.writeText(text).then(() => {
    if (btnEl) {
      const original = btnEl.textContent;
      btnEl.textContent = "✓ Copied!";
      setTimeout(() => btnEl.textContent = original, 2000);
    }
    showToast("Copied to clipboard!", "success");
  }).catch(() => showToast("Copy failed. Please select and copy manually.", "error"));
}

// ── Download as .txt ──────────────────────────────────
function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

// ── Collapsible section ───────────────────────────────
function initCollapsibles() {
  document.querySelectorAll(".section-header").forEach(header => {
    header.addEventListener("click", () => {
      const body = header.nextElementSibling;
      const chevron = header.querySelector(".chevron");
      if (!body) return;
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      if (chevron) chevron.classList.toggle("open", !isOpen);
    });
  });
}

// ── Word count helper ─────────────────────────────────
function wordCount(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// ── Error display helper ──────────────────────────────
function showError(containerId, message) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-error">⚠ ${message}</div>`;
  el.style.display = "block";
}

function clearError(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.innerHTML = ""; el.style.display = "none"; }
}

// ── Retry wrapper ─────────────────────────────────────
async function withRetry(fn, maxAttempts = 2) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts - 1 || err.status === 429) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}
