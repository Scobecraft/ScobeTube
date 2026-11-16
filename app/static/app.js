/* ScobeTube – Oberfläche */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const FORMATS = {
    video: { formats: ["mp4", "mkv", "webm"], qualities: ["best", "2160", "1440", "1080", "720", "480", "360"] },
    audio: { formats: ["mp3", "m4a", "opus", "flac", "wav"], qualities: ["best", "320", "256", "192", "128"] },
  };
  const LOSSLESS = ["flac", "wav"];
  const STATUS_TEXT = {
    preparing: "Analysiere", queued: "Wartet", downloading: "Lädt", processing: "Verarbeite",
    done: "Fertig", error: "Fehler", cancelled: "Abgebrochen",
  };
  const ACTIVE = ["preparing", "queued", "downloading", "processing"];

  const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem("st:" + k)); localStorage.setItem("st:" + k, JSON.stringify(v)); } catch { return null; } };
  const state = {
    kind: store("kind") || "video",
    format: store("format") || {},
    quality: store("quality") || {},
    filter: store("filter") || "all",
    items: new Map(),
  };

  // ---------------------------------------------------------------- helpers
  const fmtBytes = (b) => {
    if (b == null || isNaN(b)) return "";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  };
  const fmtTime = (s) => {
    if (s == null || isNaN(s)) return "";
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  const qLabel = (kind, q) => q === "best" ? "Beste" : kind === "video" ? (q === "2160" ? "4K" : q === "1440" ? "2K" : q + "p") : q + " kbit/s";

  async function api(path, opts = {}) {
    const res = await fetch("api/" + path, {
      headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
      ...opts,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* leer */ }
    if (!res.ok) throw new Error((data && data.detail) || `Fehler ${res.status}`);
    return data;
  }

  // ----------------------------------------------------------------- toasts
  const ICONS = { success: "✓", error: "!", info: "i" };
  function toast(msg, type = "info", ms = 3800) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="ti">${ICONS[type] || "i"}</span><span></span>`;
    el.lastChild.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove(), { once: true }); }, ms);
  }

  // --------------------------------------------------------------- confetti
  const confetti = (() => {
    const cv = $("#confetti"), ctx = cv.getContext("2d");
    let parts = [], raf = null;
    const colors = ["#8b5cf6", "#ec4899", "#f97316", "#22d3a0", "#fbbf24", "#ffffff"];
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    function resize() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }
    addEventListener("resize", resize); resize();
    function tick() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      const d = devicePixelRatio;
      parts = parts.filter((p) => p.life > 0);
      for (const p of parts) {
        p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 1;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / 30);
        ctx.translate(p.x * d, p.y * d); ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.s * d / 2, 0, 7); ctx.fill(); }
        else ctx.fillRect(-p.s * d / 2, -p.s * d / 4, p.s * d, p.s * d / 2);
        ctx.restore();
      }
      raf = parts.length ? requestAnimationFrame(tick) : null;
      if (!raf) ctx.clearRect(0, 0, cv.width, cv.height);
    }
    return (x, y, n = 60) => {
      if (reduce) return;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 7;
        parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5, rot: Math.random() * 6, vr: (Math.random() - .5) * .4,
          s: 5 + Math.random() * 6, c: colors[(Math.random() * colors.length) | 0], life: 70 + Math.random() * 40, round: Math.random() < .3 });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };
  })();

  // ------------------------------------------------------- sliding indicators
  function moveIndicator(container, indicator) {
    const active = $(".active", container);
    if (!active) return;
    indicator.style.width = active.offsetWidth + "px";
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  }
  const seg = $("#kindSeg"), segInd = $(".seg-indicator", seg);
  const tabs = $("#tabs"), tabInd = $(".tab-indicator", tabs);
  addEventListener("resize", () => { moveIndicator(seg, segInd); moveIndicator(tabs, tabInd); });

  // -------------------------------------------------------------- composer
  function renderChips(animate) {
    const kind = state.kind, def = FORMATS[kind];
    const fmt = def.formats.includes(state.format[kind]) ? state.format[kind] : def.formats[0];
    const q = def.qualities.includes(state.quality[kind]) ? state.quality[kind] : "best";
    state.format[kind] = fmt; state.quality[kind] = q;

    const fc = $("#formatChips"), qc = $("#qualityChips");
    fc.innerHTML = def.formats.map((f) => `<button type="button" class="chip${f === fmt ? " active" : ""}" data-v="${f}">${f.toUpperCase()}</button>`).join("");
    const lossless = kind === "audio" && LOSSLESS.includes(fmt);
    qc.innerHTML = lossless
      ? `<button type="button" class="chip active" disabled>Verlustfrei</button>`
      : def.qualities.map((v) => `<button type="button" class="chip${v === q ? " active" : ""}" data-v="${v}">${qLabel(kind, v)}</button>`).join("");
    if (animate) { [fc, qc].forEach((c) => { c.classList.remove("swap"); void c.offsetWidth; c.classList.add("swap"); }); }
    $$(".video-only").forEach((el) => el.classList.toggle("hidden", kind !== "video"));
  }

  function setKind(kind, animate = true) {
    state.kind = kind; store("kind", kind);
    $$("button", seg).forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
    moveIndicator(seg, segInd);
    renderChips(animate);
  }
  seg.addEventListener("click", (e) => { const b = e.target.closest("button[data-kind]"); if (b && b.dataset.kind !== state.kind) setKind(b.dataset.kind); });

  $("#formatChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip[data-v]"); if (!b) return;
    state.format[state.kind] = b.dataset.v; store("format", state.format);
    renderChips(false); $(`#formatChips [data-v="${b.dataset.v}"]`).classList.add("pop");
  });
  $("#qualityChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip[data-v]"); if (!b) return;
    state.quality[state.kind] = b.dataset.v; store("quality", state.quality);
    $$("#qualityChips .chip").forEach((c) => c.classList.toggle("active", c === b));
    b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  });

  ["optPlaylist", "optThumb", "optSubs"].forEach((id) => {
    const el = $("#" + id), saved = store(id);
    if (saved !== null) el.checked = saved;
    el.addEventListener("change", () => store(id, el.checked));
  });

  const urlEl = $("#url");
  const autosize = () => { urlEl.style.height = "auto"; urlEl.style.height = urlEl.scrollHeight + "px"; };
  urlEl.addEventListener("input", autosize);
  urlEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#addForm").requestSubmit(); }
  });
  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { urlEl.value = urlEl.value ? urlEl.value.trim() + "\n" + t.trim() : t.trim(); autosize(); urlEl.focus(); }
    } catch { toast("Kein Zugriff auf die Zwischenablage – bitte mit Strg+V einfügen", "info"); urlEl.focus(); }
  });

  async function submit(urls) {
    const go = $("#goBtn");
    go.classList.add("loading");
    try {
      const res = await api("add", {
        method: "POST",
        body: {
          urls, kind: state.kind, format: state.format[state.kind], quality: state.quality[state.kind],
          playlist: $("#optPlaylist").checked, thumbnail: $("#optThumb").checked, subtitles: $("#optSubs").checked,
        },
      });
      const n = res.added.length;
      toast(n === 1 ? "Zur Warteschlange hinzugefügt" : `${n} Links hinzugefügt`, "success");
      urlEl.value = ""; autosize();
      const r = go.getBoundingClientRect();
      confetti(r.left + r.width / 2, r.top + r.height / 2, 28);
      if (state.filter === "done" || state.filter === "failed") setFilter("all");
    } catch (err) {
      toast(err.message, "error", 5000);
      $("#addForm").animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "translateX(-4px)" }, { transform: "translateX(0)" }], { duration: 380, easing: "ease-out" });
    } finally {
      go.classList.remove("loading");
    }
  }
  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = urlEl.value.trim();
    if (!v) { urlEl.focus(); return; }
    submit(v);
  });

  // ------------------------------------------------------------ drag & drop
  let dragDepth = 0;
  const overlay = $("#dropOverlay");
  addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; overlay.classList.add("show"); });
  addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove("show"); } });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; overlay.classList.remove("show");
    const t = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (t && /https?:\/\//i.test(t)) submit(t);
    else toast("Das war kein Link", "error");
  });

  // --------------------------------------------------------------- the list
  const list = $("#list"), tpl = $("#itemTpl");

  function matchesFilter(it) {
    switch (state.filter) {
      case "active": return ACTIVE.includes(it.status);
      case "done": return it.status === "done";
      case "failed": return it.status === "error" || it.status === "cancelled";
      default: return true;
    }
  }

  function sortKey(it) {
    // Aktive zuerst (älteste oben), danach Fertige (neueste oben)
    const order = { downloading: 0, processing: 0, preparing: 1, queued: 2 };
    if (ACTIVE.includes(it.status)) return [0, order[it.status], it.created];
    return [1, 0, -(it.finished || it.created)];
  }
  const cmp = (a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

  function createNode(it) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = it.id;
    const img = $("img", node);
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.removeAttribute("src"));
    $(".cancel", node).addEventListener("click", () => api(`items/${it.id}/cancel`, { method: "POST" }).catch((e) => toast(e.message, "error")));
    $(".retry", node).addEventListener("click", () => api(`items/${it.id}/retry`, { method: "POST" }).then(() => toast("Neuer Versuch gestartet", "info")).catch((e) => toast(e.message, "error")));
    $(".del", node).addEventListener("click", (e) => {
      const cur = state.items.get(it.id);
      if (cur && cur.status === "done" && cur.filename) openDelPopover(e.currentTarget, it.id);
      else api(`items/${it.id}`, { method: "DELETE" }).catch((err) => toast(err.message, "error"));
    });
    return node;
  }

  function updateNode(node, it, prev) {
    node.dataset.status = it.status;
    node.dataset.kind = it.options.kind;
    const img = $("img", node);
    if (it.thumbnail && img.getAttribute("src") !== it.thumbnail) img.src = it.thumbnail;
    $(".duration", node).textContent = it.duration ? fmtTime(it.duration) : "";
    $(".status-text", node).textContent = STATUS_TEXT[it.status] || it.status;
    const o = it.options;
    const q = o.kind === "audio" && LOSSLESS.includes(o.format) ? "" : o.quality !== "best" ? " · " + qLabel(o.kind, o.quality) : "";
    $(".fmt", node).textContent = o.format.toUpperCase() + q;
    $(".playlist-chip", node).textContent = it.playlist ? "☰ " + it.playlist : "";
    $(".playlist-chip", node).title = it.playlist || "";
    const t = $(".title", node);
    if (t.textContent !== it.title) { t.textContent = it.title; t.title = it.title; }
    $(".uploader", node).textContent = it.uploader || "";
    $(".bar", node).style.width = (it.status === "downloading" ? it.progress : 0) + "%";

    let stats = "";
    if (it.status === "downloading") {
      stats += `<span><b>${(it.progress || 0).toFixed(1)}%</b></span>`;
      if (it.total) stats += `<span>${fmtBytes(it.downloaded)} / ${fmtBytes(it.total)}</span>`;
      if (it.speed) stats += `<span>⚡ ${fmtBytes(it.speed)}/s</span>`;
      if (it.eta != null) stats += `<span>noch ${fmtTime(it.eta)}</span>`;
    } else if (it.status === "processing") {
      stats = "<span>Konvertiere & bette Metadaten ein…</span>";
    } else if (it.status === "queued") {
      stats = "<span>In der Warteschlange</span>";
    } else if (it.status === "preparing") {
      stats = "<span>Hole Infos…</span>";
    } else if (it.status === "done") {
      if (it.filesize) stats += `<span><b>${fmtBytes(it.filesize)}</b></span>`;
      if (it.filename) stats += `<span title="${escapeAttr(it.filename)}">📁 ${escapeHtml(shorten(it.filename, 60))}</span>`;
    }
    const s = $(".stats", node);
    if (s.innerHTML !== stats) s.innerHTML = stats;
    $(".error-msg", node).textContent = it.error || "";

    const dl = $(".dl", node);
    if (it.status === "done") dl.href = `api/files/${it.id}`; else dl.removeAttribute("href");

    if (prev && prev.status !== "done" && it.status === "done") {
      node.classList.remove("just-done"); void node.offsetWidth; node.classList.add("just-done");
      setTimeout(() => node.classList.remove("just-done"), 2400);
      const r = $(".thumb", node).getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) confetti(r.left + r.width / 2, r.top + r.height / 2, 45);
    }
    node.classList.toggle("filtered", !matchesFilter(it));
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escapeAttr = escapeHtml;
  const shorten = (s, n) => s.length > n ? "…" + s.slice(-n) : s;

  // FLIP-Animation beim Umsortieren
  function reorder() {
    const sorted = [...state.items.values()].sort(cmp);
    const nodes = sorted.map((it) => list.querySelector(`[data-id="${it.id}"]`)).filter(Boolean);
    const current = $$(".item:not(.leaving)", list);
    if (nodes.length === current.length && nodes.every((n, i) => n === current[i])) return;
    const first = new Map(nodes.map((n) => [n, n.getBoundingClientRect().top]));
    nodes.forEach((n) => list.appendChild(n));
    $$(".item.leaving", list).forEach((n) => list.appendChild(n));
    nodes.forEach((n) => {
      const dy = first.get(n) - n.getBoundingClientRect().top;
      if (dy && !n.classList.contains("filtered")) n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 500, easing: "cubic-bezier(.22,1,.36,1)" });
    });
  }

  let reorderQueued = false;
  const scheduleReorder = () => { if (reorderQueued) return; reorderQueued = true; requestAnimationFrame(() => { reorderQueued = false; reorder(); updateCounts(); }); };

  function upsert(it) {
    const prev = state.items.get(it.id);
    state.items.set(it.id, it);
    let node = list.querySelector(`[data-id="${it.id}"]`);
    if (!node) { node = createNode(it); list.prepend(node); }
    updateNode(node, it, prev);
    if (!prev || prev.status !== it.status) scheduleReorder();
  }

  function removeItem(id) {
    state.items.delete(id);
    const node = list.querySelector(`[data-id="${id}"]`);
    if (node) {
      const h = node.offsetHeight;
      node.classList.add("leaving");
      node.addEventListener("animationend", function onEnd(ev) {
        if (ev.target !== node) return;
        node.removeEventListener("animationend", onEnd);
        node.animate([{ height: h + "px", marginBottom: "0px" }, { height: "0px", marginBottom: "-12px", padding: "0px", borderWidth: "0px" }], { duration: 250, easing: "ease-in" })
          .onfinish = () => node.remove();
        node.style.height = "0px";
      });
    }
    scheduleReorder();
  }

  const lastCounts = {};
  function updateCounts() {
    const all = [...state.items.values()];
    const c = {
      all: all.length,
      active: all.filter((i) => ACTIVE.includes(i.status)).length,
      done: all.filter((i) => i.status === "done").length,
      failed: all.filter((i) => i.status === "error" || i.status === "cancelled").length,
    };
    for (const k in c) {
      const el = $(`[data-count="${k}"]`);
      if (lastCounts[k] !== c[k]) {
        el.textContent = c[k];
        if (lastCounts[k] !== undefined) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
        lastCounts[k] = c[k];
      }
    }
    const visible = all.filter(matchesFilter).length;
    const empty = $("#empty");
    empty.classList.toggle("show", visible === 0);
    $("h3", empty).textContent = all.length === 0 ? "Noch nichts hier" : "Hier ist gerade nichts";
    $("p", empty).textContent = all.length === 0 ? "Füge oben einen Link ein oder zieh ihn einfach auf die Seite." : "In dieser Ansicht gibt es keine Einträge.";
    document.title = c.active ? `(${c.active}) ScobeTube` : "ScobeTube";
  }

  function setFilter(f) {
    state.filter = f; store("filter", f);
    $$("button", tabs).forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
    moveIndicator(tabs, tabInd);
    for (const it of state.items.values()) {
      const node = list.querySelector(`[data-id="${it.id}"]`);
      if (!node) continue;
      const hide = !matchesFilter(it);
      if (node.classList.contains("filtered") && !hide) { node.style.animation = "none"; void node.offsetWidth; node.style.animation = ""; }
      node.classList.toggle("filtered", hide);
    }
    updateCounts();
  }
  tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-filter]"); if (b) setFilter(b.dataset.filter); });

  $("#clearDone").addEventListener("click", async () => {
    const which = state.filter === "failed" ? "failed" : "finished";
    try {
      const r = await api("clear", { method: "POST", body: { which, delete_files: false } });
      toast(r.removed ? `${r.removed} Einträge entfernt – Dateien bleiben erhalten` : "Nichts zum Aufräumen", r.removed ? "success" : "info");
    } catch (e) { toast(e.message, "error"); }
  });

  // ----------------------------------------------------------- del popover
  const pop = $("#delPop");
  let popId = null;
  function openDelPopover(anchor, id) {
    popId = id;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + 8; if (top + ph > innerHeight - 10) top = r.top - ph - 8;
    pop.style.top = top + "px";
    pop.style.left = Math.max(10, Math.min(innerWidth - pw - 10, r.right - pw)) + "px";
    pop.style.animation = "none"; void pop.offsetWidth; pop.style.animation = "";
  }
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    const withFile = b.dataset.del === "file";
    api(`items/${popId}?delete_file=${withFile}`, { method: "DELETE" })
      .then(() => withFile && toast("Datei gelöscht", "success"))
      .catch((err) => toast(err.message, "error"));
    pop.hidden = true;
  });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".del")) pop.hidden = true; });
  addEventListener("scroll", () => { pop.hidden = true; }, { passive: true });

  // ---------------------------------------------------------------- events
  const conn = $("#conn");
  function setConn(s) {
    conn.classList.toggle("ok", s === "ok"); conn.classList.toggle("bad", s === "bad");
    $(".conn-text", conn).textContent = s === "ok" ? "Live" : s === "bad" ? "Getrennt" : "Verbinde…";
  }
  function connect() {
    const es = new EventSource("api/events");
    es.addEventListener("init", (e) => {
      setConn("ok");
      const { items } = JSON.parse(e.data);
      const ids = new Set(items.map((i) => i.id));
      for (const id of [...state.items.keys()]) if (!ids.has(id)) removeItem(id);
      items.sort(cmp).reverse().forEach(upsert);
      scheduleReorder();
    });
    es.addEventListener("added", (e) => upsert(JSON.parse(e.data)));
    es.addEventListener("update", (e) => {
      const it = JSON.parse(e.data), prev = state.items.get(it.id);
      upsert(it);
      if (prev && prev.status !== it.status) {
        if (it.status === "done") toast(`Fertig: ${it.title}`, "success");
        else if (it.status === "error") toast(`Fehlgeschlagen: ${it.title}`, "error", 5000);
      }
    });
    es.addEventListener("removed", (e) => removeItem(JSON.parse(e.data).id));
    es.onerror = () => { setConn("bad"); };
    es.onopen = () => setConn("ok");
  }

  // -------------------------------------------------------------- settings
  const modal = $("#settings");
  const openModal = () => { modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); loadInfo(); };
  const closeModal = () => { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); };
  $("#settingsBtn").addEventListener("click", openModal);
  modal.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); pop.hidden = true; } });

  async function loadInfo() {
    try {
      const i = await api("info");
      $("#ytdlpVersion").textContent = i.ytdlp;
      $("#ytdlpVersion2").textContent = i.ytdlp + (i.ytdlp_channel === "nightly" ? " (nightly)" : "");
      $("#appVersion").textContent = "v" + i.version;
      const b = $("#cookieBadge");
      b.textContent = i.cookies ? "aktiv" : "keine"; b.classList.toggle("on", i.cookies);
      $("#cookieDelete").hidden = !i.cookies;
    } catch { /* ignorieren */ }
  }

  $("#updateBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.classList.add("busy"); $("span", btn).textContent = "Lädt…";
    try {
      const r = await api("update-ytdlp", { method: "POST" });
      if (r.restarting) {
        toast(`yt-dlp ${r.version} installiert – Server startet neu`, "success", 5000);
        setTimeout(() => location.reload(), 4000);
      } else toast(`yt-dlp ist aktuell (${r.version})`, "info");
    } catch (err) { toast(err.message, "error", 6000); }
    finally { btn.classList.remove("busy"); $("span", btn).textContent = "Aktualisieren"; }
  });

  $("#cookieFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try { await api("cookies", { method: "POST", body: fd }); toast("Cookies gespeichert", "success"); loadInfo(); }
    catch (err) { toast(err.message, "error"); }
    e.target.value = "";
  });
  $("#cookieDelete").addEventListener("click", async () => {
    try { await api("cookies", { method: "DELETE" }); toast("Cookies entfernt", "info"); loadInfo(); }
    catch (err) { toast(err.message, "error"); }
  });

  // Lesezeichen
  const base = new URL("api/add", location.href).href;
  const bm = (kind, fmt) => `javascript:(()=>{window.open('${base}?kind=${kind}&format=${fmt}&url='+encodeURIComponent(location.href),'_blank')})()`;
  $("#bmVideo").href = bm("video", "mp4");
  $("#bmAudio").href = bm("audio", "mp3");
  $$("#bmVideo, #bmAudio").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); toast("In die Lesezeichenleiste ziehen 😉", "info"); }));

  // ------------------------------------------------------------------ start
  // Link aus ?url=… (z. B. Share-Target) übernehmen
  const qp = new URLSearchParams(location.search);
  if (qp.get("url")) { urlEl.value = qp.get("url"); history.replaceState(null, "", location.pathname); }

  setKind(state.kind, false);
  setFilter(state.filter);
  requestAnimationFrame(() => { moveIndicator(seg, segInd); moveIndicator(tabs, tabInd); });
  document.fonts && document.fonts.ready.then(() => { moveIndicator(seg, segInd); moveIndicator(tabs, tabInd); });
  connect();
  loadInfo();
  autosize();
})();
