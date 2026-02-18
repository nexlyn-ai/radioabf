// public/scripts/dedications-global.js
(() => {
  // ---------- GLOBAL STATE (persists across Astro swaps) ----------
  if (!window.__dedicationsState) {
    window.__dedicationsState = {
      html: "",
      latest: "",
      raf: 0,
      lastTs: 0,
      x: 0,                 // progress in px along the travel path
      speed: 28,            // px/sec
      initialized: false,
      refreshTimer: null,
      checkTimer: null,
      travel: 0,            // cached travel distance (loopWidth + containerWidth)
      containerW: 0,
      loopW: 0,
      delegated: false,
      formDelegated: false
    };
  }
  const S = window.__dedicationsState;

  const API_BASE = "https://cms.radioabf.com";
  const LIST_URL =
    `${API_BASE}/items/dedications?fields=name,message,date_created&filter[status][_eq]=published&sort=-date_created&limit=20`;
  const LATEST_URL =
    `${API_BASE}/items/dedications?fields=date_created&filter[status][_eq]=published&sort=-date_created&limit=1`;

  // ✅ endpoint Directus create
  const CREATE_URL = `${API_BASE}/items/dedications`;

  const REFRESH_MS = 15 * 60 * 1000; // 15 min
  const CHECK_MS   = 2 * 60 * 1000;  // 2 min

  const $ = (sel) => document.querySelector(sel);

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getInnerEl() {
    // optionnel si tu ajoutes id="dedicationsInner"
    return document.getElementById("dedicationsInner") || $(".dedications-scroll-inner");
  }

  function getScrollWrap() {
    const inner = getInnerEl();
    return inner ? inner.closest(".dedications-scroll") : null;
  }

  function applyTransform() {
    const inner = getInnerEl();
    if (!inner) return;
    const tx = (S.containerW || 0) - (S.x || 0); // départ à droite -> vers la gauche
    inner.style.transform = `translate3d(${tx}px,0,0)`;
  }

function inject(html) {
  const el = getInnerEl();
  if (!el) return;

  el.innerHTML = html || "";           // On injecte toujours pour rafraîchir le contenu

  // Force le navigateur à recalculer les dimensions immédiatement
  void el.offsetHeight;                // Le "void" évite des warnings inutiles

  applyTransform();
}

  function setBadge(on) {
    const b = $("#dedicationsBadge");
    if (!b) return;
    b.classList.toggle("hidden", !on);
    if (on) setTimeout(() => b.classList.add("hidden"), 20000);
  }

  function computeLatest(items) {
    return items?.[0]?.date_created || "";
  }

  async function loadFull() {
    const el = getInnerEl();
    if (!el) return;

    try {
      const res = await fetch(LIST_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = data?.data || [];

      let html = "";
      if (!items.length) {
        html = '<span class="italic opacity-70">Aucune dédicace pour le moment…</span>';
      } else {
        const parts = items.map((i) => {
          const name = escapeHtml((i?.name || "Auditeur Anonyme").toString().trim());
          const msg  = escapeHtml((i?.message || "").toString().trim());
          return `<span><strong class="text-cyan-300">${name}</strong> : ${msg}</span>`;
        });
        const joined = parts.join(" • ");
        let repeated = joined;

if (items.length > 3) {
  repeated = Array(10).fill(joined).join(" • ");
  // Si tu veux encore plus de marge avec des messages très longs, décommente :
  // repeated = `${joined} • ${joined} • ${joined} • ${joined}`; // 4 passages
}

html = repeated;
      }

      S.html = html;
      S.latest = computeLatest(items);

      // hard inject because content may change
      const inner = getInnerEl();
      if (inner) inner.innerHTML = html || "";

      recalcMarqueeMetrics(true);
      ensureMarqueeRunning();
    } catch (e) {
      console.error("[DED] loadFull error:", e);
    }
  }

  async function checkNew() {
    if (!S.latest) return;
    try {
      const res = await fetch(LATEST_URL, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const latest = data?.data?.[0]?.date_created || "";
      if (latest && latest !== S.latest) {
        await loadFull();
        setBadge(true);
      }
    } catch {}
  }

  // ---------- MARQUEE METRICS ----------
  function recalcMarqueeMetrics(keepPosition) {
    const inner = getInnerEl();
    const wrap = getScrollWrap();
    if (!inner || !wrap) return;

    const containerW = wrap.clientWidth || 0;

    // half width = one loop when duplicated
    let loopW = inner.scrollWidth / 2;
    if (!isFinite(loopW) || loopW <= 0) loopW = inner.scrollWidth || 0;

    const travel = loopW + containerW;

    S.containerW = containerW;
    S.loopW = loopW;
    S.travel = travel;

    if (keepPosition && travel > 0) {
      S.x = ((S.x % travel) + travel) % travel;
    } else {
      S.x = 0; // start from right
    }

    applyTransform();
  }

  // ---------- MARQUEE LOOP ----------
  function stopMarquee() {
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.lastTs = 0;
  }

  function ensureMarqueeRunning() {
    const inner = getInnerEl();
    const wrap = getScrollWrap();
    if (!inner || !wrap) return;

    const text = inner.textContent?.trim() || "";
    if (!text) {
      stopMarquee();
      inner.style.transform = "translate3d(0,0,0)";
      return;
    }

    if (!S.travel || S.travel <= 0) recalcMarqueeMetrics(true);

    const tick = (ts) => {
      const el = getInnerEl();
      const w = getScrollWrap();
      if (!el || !el.isConnected || !w) {
        stopMarquee();
        return;
      }

      // resize / layout change
      const cw = w.clientWidth || 0;
      if (cw && cw !== S.containerW) {
        recalcMarqueeMetrics(true);
      }

      if (!S.lastTs) S.lastTs = ts;
      const dt = (ts - S.lastTs) / 1000;
      S.lastTs = ts;

      const travel = S.travel || 0;
      if (travel > 0) {
        S.x += (S.speed || 28) * dt;
        if (S.x >= travel) S.x = S.x % travel;
        applyTransform();
      }

      S.raf = requestAnimationFrame(tick);
    };

    if (!S.raf) {
      applyTransform();
      S.lastTs = 0;
      S.raf = requestAnimationFrame(tick);
    }
  }

  // pause on hover (bind per element instance)
  function bindHoverPauseOnce() {
    const inner = getInnerEl();
    if (!inner) return;

    if (inner.dataset.hoverBound === "1") return;
    inner.dataset.hoverBound = "1";

    inner.addEventListener("mouseenter", () => {
      if (S.raf) cancelAnimationFrame(S.raf);
      S.raf = 0;
      S.lastTs = 0;
    });
    inner.addEventListener("mouseleave", () => {
      ensureMarqueeRunning();
    });
  }

  // ---------- MODAL (EVENT DELEGATION - swap proof) ----------
  function openModal() {
    const modal = $("#dedicationModal");
    if (!modal) return;

    modal.classList.remove("hidden");
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.style.overflow = "hidden";
  }

  function closeModal() {
    const modal = $("#dedicationModal");
    if (!modal) return;

    modal.classList.add("hidden");
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";

    $("#dedicationForm")?.reset();
    $("#dedicationFeedback")?.classList.add("hidden");
  }

  function bindModalDelegationOnce() {
    if (S.delegated) return;
    S.delegated = true;

    // clicks
    document.addEventListener("click", (e) => {
      const t = e.target;

      // open
      if (t && t.closest && t.closest("#openDedicationModal")) {
        e.preventDefault();
        openModal();
        return;
      }

      // close (X)
      if (t && t.closest && t.closest("#closeDedicationModal")) {
        e.preventDefault();
        closeModal();
        return;
      }

      // cancel
      if (t && t.closest && t.closest("#dedCancel")) {
        e.preventDefault();
        closeModal();
        return;
      }

      // backdrop
      if (t && t.closest && t.closest("#dedicationBackdrop")) {
        e.preventDefault();
        closeModal();
        return;
      }
    });

    // Escape
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const modal = $("#dedicationModal");
      if (modal && !modal.classList.contains("hidden")) closeModal();
    });
  }

  // ---------- FORM SUBMIT (EVENT DELEGATION - swap proof) ----------
function showFeedback(ok, msg) {
  const box = document.getElementById("dedicationFeedback");
  if (!box) return;

  // On affiche le bloc
  box.classList.remove("hidden");

  // Reset des classes + style de base
  box.className = "text-sm font-medium transition-all px-4 py-3 rounded-xl border";

  if (ok) {
    box.classList.add(
      "bg-emerald-900/30",
      "border-emerald-500/40",
      "text-emerald-300"
    );
    box.textContent = msg || "Envoyé ! 🎤 En attente de validation avant publication";
  } else {
    box.classList.add(
      "bg-red-900/30",
      "border-red-500/40",
      "text-red-300"
    );
    box.textContent = msg || "Erreur lors de l'envoi…";
  }

  // Disparition automatique après 5 secondes
  setTimeout(() => {
    box.classList.add("hidden");
  }, 5000);
}

  function setSubmitting(isSubmitting) {
    const btn = $("#dedSubmit");
    if (!btn) return;
    btn.disabled = !!isSubmitting;
    btn.dataset.loading = isSubmitting ? "1" : "0";
  }

  async function sendToDirectus(payload) {
    const res = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    // Directus renvoie souvent { errors: [...] } même avec 200/4xx selon config
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        json?.errors?.[0]?.message ||
        json?.error?.message ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  }

  function bindFormDelegationOnce() {
    if (S.formDelegated) return;
    S.formDelegated = true;

    document.addEventListener("submit", async (e) => {
      const form = e.target;
      if (!form || !(form instanceof HTMLFormElement)) return;
      if (form.id !== "dedicationForm") return;

      e.preventDefault();

      const nameEl = form.querySelector('[name="name"]');
      const msgEl  = form.querySelector('[name="message"]');

      const name = (nameEl?.value || "").toString().trim();
      const message = (msgEl?.value || "").toString().trim();

      if (!message) {
        showFeedback(false, "Please write a message 🙂");
        return;
      }

      setSubmitting(true);
      showFeedback(true, "Sending…");

      try {
        // ✅ IMPORTANT: on ne force pas "published" si tu ne veux pas
        // Si ton workflow Directus veut publier direct, décommente status:"published"
        const payload = {
          name: name || "Auditeur Anonyme",
          message
          // status: "published"
        };

        await sendToDirectus(payload);

        showFeedback(true, "Sent! 🎤 Thanks!");
        // refresh list + badge (optionnel)
        await loadFull();
        setBadge(true);

        // close after a short delay (nice UX)
        setTimeout(() => {
          closeModal();
        }, 700);
      } catch (err) {
        console.error("[DED] send error:", err);
        showFeedback(false, `Send failed: ${err?.message || "Unknown error"}`);
      } finally {
        setSubmitting(false);
      }
    });
  }

  // ---------- MOUNT / INIT ----------
  function mount() {
    if (S.html) inject(S.html);

    recalcMarqueeMetrics(true);
    ensureMarqueeRunning();
    bindHoverPauseOnce();

    // modal + form always work even after swap
    bindModalDelegationOnce();
    bindFormDelegationOnce();
  }

  async function initOnce() {
    if (S.initialized) return;
    S.initialized = true;

    await loadFull().catch(console.error);

    if (!S.refreshTimer) {
      S.refreshTimer = setInterval(() => loadFull().catch(() => {}), REFRESH_MS);
    }
    if (!S.checkTimer) {
      S.checkTimer = setInterval(() => checkNew().catch(() => {}), CHECK_MS);
    }
  }

  // Boot
  initOnce();
  mount();

  // Astro navigation
  document.addEventListener("astro:after-swap", mount);
  document.addEventListener("astro:page-load", mount);

  // Resize safety
  window.addEventListener("resize", () => {
    recalcMarqueeMetrics(true);
    applyTransform();
  });
})();
