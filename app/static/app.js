/* ScobeTube – Oberfläche */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SOURCES = {
    all: {
      video: { formats: ["mp4", "mkv", "webm"], qualities: ["best", "2160", "1440", "1080", "720", "480", "360"] },
      audio: { formats: ["mp3", "m4a", "opus", "flac", "wav", "original"], qualities: ["best", "320", "256", "192", "128"] },
      placeholder: "Link einfügen – oder YouTube durchsuchen",
      search: "youtube",
    },
    soundcloud: {
      audio: { formats: ["original", "mp3", "m4a", "opus", "flac", "wav"], qualities: ["best", "320", "256", "192", "128"] },
      placeholder: "SoundCloud-Link (Track, Set, Profil) – oder Suchbegriff",
      search: "soundcloud",
    },
    spotify: {
      audio: { formats: ["mp3", "m4a", "opus", "flac", "original"], qualities: ["best", "320", "256", "192", "128"] },
      placeholder: "Spotify-Link: Song, Album, Playlist oder Künstler",
      search: null,
    },
  };
  const NO_QUALITY = ["flac", "wav", "original"];
  const STATUS = { preparing: "Analyse", queued: "Wartet", downloading: "Lädt", processing: "Konvertiert", done: "Fertig", error: "Fehler", cancelled: "Abgebrochen" };
  const ACTIVE = ["preparing", "queued", "downloading", "processing"];
  const CELLS = 24;

  const store = (k, v) => {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem("st2:" + k));
      localStorage.setItem("st2:" + k, JSON.stringify(v));
    } catch { return null; }
  };
  const state = {
    me: null, permLabels: {},
    source: store("source") || "all",
    kind: store("kind") || "video",
    format: store("format") || {},
    quality: store("quality") || {},
    filter: store("filter") || "all",
    items: new Map(),
    info: null, clockOffset: 0,
  };
  const can = (p) => !!state.me && state.me.effective.includes(p);

  // ------------------------------------------------------------ helpers
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
  const now = () => Date.now() / 1000 + state.clockOffset;
  const expiresIn = (it) => {
    const h = state.info && state.info.retention_hours;
    if (!h || !it.finished) return null;
    return it.finished + h * 3600 - now();
  };
  const fmtLeft = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h} Std. ${m} Min.` : m ? `${m} Min.` : "< 1 Min.";
  };
  const fmtUptime = (s) => {
    s = Math.max(0, Math.floor(s));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d} T ${h} Std. ${m} Min.`;
    if (h) return `${h} Std. ${m} Min.`;
    return `${m} Min. ${String(sec).padStart(2, "0")} s`;
  };
  const fmtDate = (t) => t ? new Date(t * 1000).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "nie";
  const qLabel = (kind, q) => q === "best" ? "Beste" : kind === "video" ? (q === "2160" ? "4K" : q === "1440" ? "2K" : q + "p") : q + "k";
  const fLabel = (f) => f === "original" ? "Original" : f.toUpperCase();
  const isUrl = (t) => /https?:\/\/\S+|spotify:(track|album|playlist|artist):/i.test(t);
  const detectSource = (t) => /open\.spotify\.com\/|spotify:(track|album|playlist|artist):/i.test(t) ? "spotify" : /soundcloud\.com\//i.test(t) ? "soundcloud" : null;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };

  async function api(path, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const headers = { "X-ScobeTube": "1" };
    if (opts.body && !isForm) headers["Content-Type"] = "application/json";
    const res = await fetch("api/" + path, {
      ...opts, headers, credentials: "same-origin",
      body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body,
    });
    if (res.status === 401 && !path.startsWith("auth/password")) { location.href = "login"; throw new Error("Nicht angemeldet"); }
    let data = null;
    try { data = await res.json(); } catch { /* leer */ }
    if (!res.ok) throw new Error((data && data.detail) || `Fehler ${res.status}`);
    return data;
  }

  // ------------------------------------------------------------- toasts
  function toast(msg, type = "info", ms = 3800) {
    const t = el("div", `toast ${type}`);
    t.append(el("span", "ti", type === "success" ? "✓" : type === "error" ? "!" : "i"), el("span", "", msg));
    $("#toasts").appendChild(t);
    setTimeout(() => { t.classList.add("out"); t.addEventListener("animationend", () => t.remove(), { once: true }); }, ms);
  }

  // ------------------------------------------------- konfetti (eckig)
  const fx = (() => {
    const cv = $("#fx"), ctx = cv.getContext("2d");
    let parts = [], raf = null;
    const resize = () => { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; };
    addEventListener("resize", resize); resize();
    const tick = () => {
      const d = devicePixelRatio;
      ctx.clearRect(0, 0, cv.width, cv.height);
      parts = parts.filter((p) => p.life > 0);
      for (const p of parts) {
        p.vy += 0.35; p.vx *= 0.98; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life--;
        ctx.save(); ctx.globalAlpha = Math.min(1, p.life / 25);
        ctx.translate(p.x * d, p.y * d); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.s * d / 2, -p.s * d / 2, p.s * d, p.s * d * (p.flat ? .35 : 1));
        ctx.restore();
      }
      raf = parts.length ? requestAnimationFrame(tick) : null;
    };
    return (x, y, n = 40) => {
      if (reduceMotion) return;
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#c6ff3d";
      const colors = [accent, accent, "#f3f0e7", "#8f6bff", "#ff4d8d"];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 8;
        parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, r: Math.random() * 6, vr: (Math.random() - .5) * .5,
          s: 5 + Math.random() * 7, c: colors[(Math.random() * colors.length) | 0], life: 60 + Math.random() * 40, flat: Math.random() < .5 });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };
  })();

  // ------------------------------------------------------ hero & deko
  $$("[data-split]").forEach((row) => {
    const text = row.textContent; row.textContent = "";
    [...text].forEach((c, i) => { const s = el("span", "ch", c); s.style.setProperty("--i", i + (row.classList.contains("r2") ? 5 : 0)); row.appendChild(s); });
  });
  const wave = $("#scWave");
  for (let i = 0; i < 64; i++) {
    const s = el("span");
    s.style.setProperty("--i", i);
    s.style.setProperty("--h", (25 + Math.abs(Math.sin(i * .45)) * 55 + Math.random() * 20) + "%");
    wave.appendChild(s);
  }
  const deck = $("#deck");
  deck.addEventListener("pointermove", (e) => {
    const r = deck.getBoundingClientRect();
    deck.style.setProperty("--mx", (e.clientX - r.left) + "px");
    deck.style.setProperty("--my", (e.clientY - r.top) + "px");
  });

  // ----------------------------------------------------------- deck
  const urlEl = $("#url");
  const srcSwitch = $("#srcSwitch");
  const kindSeg = $("#kindSeg");

  function moveKindSlider() {
    const a = $("button.active", kindSeg), s = $(".slider", kindSeg);
    if (!a) return;
    s.style.width = a.offsetWidth + "px"; s.style.transform = `translateX(${a.offsetLeft}px)`;
  }
  addEventListener("resize", moveKindSlider);

  const curKind = () => state.source === "all" ? state.kind : "audio";
  const fmtKey = () => state.source + ":" + curKind();

  function renderChips(animate) {
    const kind = curKind(), def = SOURCES[state.source][kind];
    const key = fmtKey();
    const fmt = def.formats.includes(state.format[key]) ? state.format[key] : def.formats[0];
    const q = def.qualities.includes(state.quality[kind]) ? state.quality[kind] : "best";
    state.format[key] = fmt; state.quality[kind] = q;
    const fc = $("#formatChips"), qc = $("#qualityChips");
    fc.replaceChildren(...def.formats.map((f, i) => {
      const b = el("button", "chip" + (f === fmt ? " active" : ""), fLabel(f)); b.type = "button"; b.dataset.v = f; b.style.setProperty("--i", i); return b;
    }));
    qc.replaceChildren(...def.qualities.map((v, i) => {
      const b = el("button", "chip" + (v === q ? " active" : ""), qLabel(kind, v)); b.type = "button"; b.dataset.v = v; b.style.setProperty("--i", i + def.formats.length); return b;
    }));
    $("#qualityGroup").hidden = kind === "audio" && NO_QUALITY.includes(fmt);
    if (animate) { restart(fc, "swap"); restart(qc, "swap"); }
    document.body.dataset.kind = kind;
  }

  function setSource(src, animate = true) {
    if (!SOURCES[src]) src = "all";
    state.source = src; store("source", src);
    document.body.dataset.source = src;
    $$("button", srcSwitch).forEach((b, i) => { b.classList.toggle("active", b.dataset.source === src); if (b.dataset.source === src) srcSwitch.dataset.pos = i; });
    urlEl.placeholder = SOURCES[src].placeholder;
    $("#playlistLabel").textContent = src === "soundcloud" ? "Ganze Sets & Profile" : src === "spotify" ? "Ganze Alben & Playlists" : "Ganze Playlist";
    renderChips(animate);
    updateMode();
    requestAnimationFrame(moveKindSlider);
    if (animate) { const r = srcSwitch.getBoundingClientRect(); fx(r.left + r.width * ({ all: 1, soundcloud: 3, spotify: 5 }[src] / 6), r.bottom, 18); }
  }
  srcSwitch.addEventListener("click", (e) => { const b = e.target.closest("button[data-source]"); if (b && b.dataset.source !== state.source) setSource(b.dataset.source); });

  function setKind(kind, animate = true) {
    state.kind = kind; store("kind", kind);
    $$("button", kindSeg).forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
    moveKindSlider(); renderChips(animate);
  }
  kindSeg.addEventListener("click", (e) => { const b = e.target.closest("button[data-kind]"); if (b && b.dataset.kind !== state.kind) setKind(b.dataset.kind); });

  $("#formatChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.format[fmtKey()] = b.dataset.v; store("format", state.format);
    renderChips(false); restart($(`#formatChips [data-v="${b.dataset.v}"]`), "pop");
  });
  $("#qualityChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.quality[curKind()] = b.dataset.v; store("quality", state.quality);
    $$("#qualityChips .chip").forEach((c) => c.classList.toggle("active", c === b)); restart(b, "pop");
  });
  ["optPlaylist", "optThumb", "optSubs"].forEach((id) => {
    const key = id === "optPlaylist" ? "optPlaylist.v2" : id;
    const c = $("#" + id), saved = store(key);
    if (saved !== null) c.checked = saved;
    c.addEventListener("change", () => store(key, c.checked));
  });

  // Link oder Suche?
  let lastMode = "link";
  function updateMode() {
    const v = urlEl.value.trim();
    const searchable = !!SOURCES[state.source].search;
    const mode = !v || isUrl(v) || !searchable ? "link" : "search";
    const hint = $("#modeHint");
    hint.textContent = mode === "search" ? (state.source === "soundcloud" ? "SC-Suche" : "YT-Suche") : "Link";
    hint.classList.toggle("search", mode === "search");
    if (mode !== lastMode) {
      lastMode = mode;
      const go = $("#goBtn");
      restart(go, "flip");
      setTimeout(() => {
        $("#goText").textContent = mode === "search" ? "Suchen" : "Laden";
        $("#goIcon").innerHTML = mode === "search" ? '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>' : '<path d="M12 4v13m0 0-5-5m5 5 5-5M5 21h14"/>';
      }, 180);
    }
    // SoundCloud- oder Spotify-Link erkannt → automatisch umschalten
    const detected = detectSource(v);
    if (detected && detected !== state.source && !/youtu/i.test(v)) {
      setSource(detected);
      toast(detected === "spotify" ? "Spotify-Link erkannt – Spotify-Modus aktiv" : "SoundCloud-Link erkannt – Audio-Modus aktiv", "info", 2500);
    }
  }
  const autosize = () => { urlEl.style.height = "auto"; urlEl.style.height = urlEl.scrollHeight + "px"; };
  urlEl.addEventListener("input", () => { autosize(); updateMode(); });
  urlEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#addForm").requestSubmit(); } });
  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) { urlEl.value = urlEl.value.trim() ? urlEl.value.trim() + "\n" + t : t; autosize(); updateMode(); urlEl.focus(); }
    } catch { toast("Kein Zugriff auf die Zwischenablage – bitte mit Strg+V einfügen"); urlEl.focus(); }
  });

  function currentOptions() {
    const kind = curKind();
    return {
      kind, format: state.format[fmtKey()], quality: state.quality[kind],
      playlist: $("#optPlaylist").checked, thumbnail: $("#optThumb").checked,
      subtitles: kind === "video" && $("#optSubs").checked,
      ...($("#optCut").checked ? { start: $("#cutStart").value.trim(), end: $("#cutEnd").value.trim() } : {}),
    };
  }
  $("#optCut").addEventListener("change", (e) => { $("#cutRow").hidden = !e.target.checked; if (e.target.checked) $("#cutStart").focus(); });

  async function submitUrls(urls, originEl) {
    const res = await api("add", { method: "POST", body: { urls, ...currentOptions() } });
    const n = res.added.length;
    toast(n === 1 ? "Ab in die Queue!" : `${n} Links in der Queue`, "success");
    const r = (originEl || $("#goBtn")).getBoundingClientRect();
    fx(r.left + r.width / 2, r.top + r.height / 2, 34);
    if (state.filter === "done" || state.filter === "failed") setFilter("all");
    return res;
  }

  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = urlEl.value.trim();
    if (!v) { urlEl.focus(); return; }
    const go = $("#goBtn"); go.classList.add("loading");
    try {
      if (isUrl(v)) { await submitUrls(v.replace(/spotify:(track|album|playlist|artist):([A-Za-z0-9]+)/g, "https://open.spotify.com/$1/$2")); urlEl.value = ""; autosize(); updateMode(); }
      else if (!SOURCES[state.source].search) throw new Error("Im Spotify-Modus bitte einen Spotify-Link einfügen (Teilen → Link kopieren)");
      else await runSearch(v);
    } catch (err) {
      toast(err.message, "error", 5500);
      deck.animate([{ transform: "translateX(0)" }, { transform: "translateX(-10px) rotate(-.5deg)" }, { transform: "translateX(8px)" }, { transform: "translateX(0)" }], { duration: 380 });
    } finally { go.classList.remove("loading"); }
  });

  // ------------------------------------------------------------ suche
  const results = $("#results"), grid = $("#resultsGrid");
  async function runSearch(q) {
    const source = SOURCES[state.source].search;
    results.hidden = false;
    $("#resultsTitle").textContent = `Suche: „${q}“`;
    grid.replaceChildren(...Array.from({ length: 8 }, () => el("div", "skeleton")));
    results.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    let data;
    try { data = await api(`search?source=${source}&q=${encodeURIComponent(q)}`); }
    catch (err) { results.hidden = true; throw err; }
    if (!data.results.length) { grid.replaceChildren(el("p", "label", "Nichts gefunden.")); return; }
    grid.replaceChildren(...data.results.map((r, i) => {
      const card = el("div", "res"); card.style.setProperty("--i", i);
      const art = el("div", "art");
      if (r.thumbnail) { const img = el("img"); img.src = r.thumbnail; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; art.appendChild(img); }
      if (r.duration) art.appendChild(el("span", "dur", fmtTime(r.duration)));
      const info = el("div", "info"); info.append(el("div", "t", r.title), el("div", "u", r.uploader || ""));
      const add = el("button", "btn small add", "+ Laden"); add.type = "button";
      add.addEventListener("click", async () => {
        add.classList.add("busy");
        try { await submitUrls(r.url, add); card.classList.add("added"); add.textContent = "✓ In der Queue"; }
        catch (err) { toast(err.message, "error"); }
        finally { add.classList.remove("busy"); }
      });
      card.append(art, info, add);
      return card;
    }));
  }
  $("#resultsClose").addEventListener("click", () => { results.hidden = true; });

  // ------------------------------------------------------ drag & drop
  let dragDepth = 0;
  const drop = $("#drop");
  addEventListener("dragenter", (e) => { if (!can("download")) return; e.preventDefault(); dragDepth++; drop.classList.add("show"); });
  addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("show"); } });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; drop.classList.remove("show");
    if (!can("download")) return;
    const t = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (t && isUrl(t)) { const d = detectSource(t); if (d) setSource(d, false); submitUrls(t).catch((err) => toast(err.message, "error")); }
    else toast("Das war kein Link", "error");
  });

  // -------------------------------------------------------------- liste
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
    const order = { downloading: 0, processing: 0, preparing: 1, queued: 2 };
    if (ACTIVE.includes(it.status)) return [0, order[it.status], it.created];
    return [1, 0, -(it.finished || it.created)];
  }
  const cmp = (a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

  function createNode(it) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = it.id;
    const cells = $(".cells", node);
    for (let i = 0; i < CELLS; i++) { const c = el("i"); c.style.setProperty("--i", i); cells.appendChild(c); }
    const img = $("img.thumb", node), labelImg = $(".vinyl img", node);
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.removeAttribute("src"));
    labelImg.addEventListener("error", () => labelImg.removeAttribute("src"));
    $(".cancel", node).addEventListener("click", () => api(`items/${it.id}/cancel`, { method: "POST" }).catch((e) => toast(e.message, "error")));
    $(".retry", node).addEventListener("click", () => api(`items/${it.id}/retry`, { method: "POST" }).then(() => toast("Neuer Versuch läuft")).catch((e) => toast(e.message, "error")));
    $(".play", node).addEventListener("click", () => player.open(it.id));
    $(".edit", node).addEventListener("click", () => openTagEditor(it.id));
    node.addEventListener("click", (e) => {
      if (!document.body.classList.contains("selecting") || e.target.closest(".actions")) return;
      const cur = state.items.get(it.id);
      if (!cur || cur.status !== "done") return;
      e.preventDefault();
      toggleSelect(it.id);
    });
    $(".del", node).addEventListener("click", (e) => {
      const cur = state.items.get(it.id);
      if (cur && cur.status === "done" && cur.filename) openDelPopover(e.currentTarget, it.id);
      else api(`items/${it.id}`, { method: "DELETE" }).catch((err) => toast(err.message, "error"));
    });
    return node;
  }

  function updateNode(node, it, prev) {
    const o = it.options;
    node.dataset.status = it.status;
    node.dataset.kind = o.kind;
    node.dataset.canDl = can("download") ? "1" : "0";
    node.dataset.canDelete = can("delete") ? "1" : "0";
    node.dataset.canFiles = can("files") ? "1" : "0";
    node.dataset.canEdit = can("download") ? "1" : "0";
    const img = $("img.thumb", node), labelImg = $(".vinyl img", node);
    if (it.thumbnail && img.getAttribute("src") !== it.thumbnail) { img.src = it.thumbnail; labelImg.src = it.thumbnail; }
    let dur = it.duration;
    if (dur && (o.start != null || o.end != null)) dur = Math.max(0, Math.min(o.end ?? dur, dur) - (o.start || 0));
    $(".dur", node).textContent = dur ? fmtTime(dur) : "";
    const srcName = it.source === "generic" ? "" : it.source === "archiveorg" ? "archive.org" : (it.source || "");
    const src = $(".src", node); src.textContent = srcName; src.className = "src " + (it.source || "");
    $(".tag.status", node).textContent = STATUS[it.status] || it.status;
    const q = o.kind === "audio" && NO_QUALITY.includes(o.format) ? "" : o.quality !== "best" ? " · " + qLabel(o.kind, o.quality) : "";
    $(".tag.fmt", node).textContent = fLabel(o.format) + q;
    $(".tag.playlist", node).textContent = it.playlist ? "☰ " + it.playlist : "";
    $(".tag.playlist", node).title = it.playlist || "";
    $(".tag.owner", node).textContent = can("view_all") && it.owner ? it.owner : "";
    const cut = o.start != null || o.end != null;
    $(".tag.cut", node).textContent = cut ? `✂ ${fmtTime(o.start || 0)}–${o.end != null ? fmtTime(o.end) : "Ende"}` : "";
    const t = $(".title", node);
    if (t.textContent !== it.title) { t.textContent = it.title; t.title = it.title; }
    $(".sub", node).textContent = it.uploader || "";

    const p = it.status === "downloading" ? (it.progress || 0) : 0;
    $(".ring .rv", node).style.strokeDashoffset = String(201 * (1 - p / 100));
    $(".pct", node).textContent = it.note && !p ? "" : Math.floor(p) + "%";
    const on = Math.round(p / 100 * CELLS);
    $$(".cells i", node).forEach((c, i) => { c.classList.toggle("on", i < on - 1 || (on === CELLS && i < CELLS)); c.classList.toggle("head", i === on - 1 && on < CELLS); });

    const stats = $(".stats", node); const parts = [];
    const add = (strong, text) => { const s = el("span"); if (strong) s.appendChild(el("b", "", strong)); if (text) s.append((strong ? " " : "") + text); parts.push(s); };
    if (it.status === "downloading" && it.note && !p) {
      add("", it.note);
    } else if (it.status === "downloading") {
      add(`${p.toFixed(1)}%`);
      if (it.total) add("", `${fmtBytes(it.downloaded)} / ${fmtBytes(it.total)}`);
      if (it.speed) add("", `${fmtBytes(it.speed)}/s`);
      if (it.eta != null) add("", `ETA ${fmtTime(it.eta)}`);
      if (it.note) add("", it.note);
    } else if (it.status === "processing") add("", "Konvertiere & schreibe Metadaten…");
    else if (it.status === "queued") add("", "Wartet auf freien Slot…");
    else if (it.status === "preparing") add("", "Hole Infos…");
    else if (it.status === "done") {
      if (it.filesize) add(fmtBytes(it.filesize));
      const left = expiresIn(it);
      if (left != null) { add("", `🗑 ${left > 0 ? "löscht sich in " + fmtLeft(left) : "wird gleich gelöscht"}`); parts[parts.length - 1].className = "expires" + (left < 3600 ? " soon" : ""); }
      if (it.filename) { add("", "📁 " + (it.filename.length > 60 ? "…" + it.filename.slice(-60) : it.filename)); parts[parts.length - 1].title = it.filename; }
    }
    stats.replaceChildren(...parts);
    $(".err", node).textContent = it.error || "";
    const open = $(".open", node);
    const pageUrl = /^https?:\/\//i.test(it.url || "") ? it.url : null;
    node.dataset.hasLink = pageUrl ? "1" : "0";
    if (pageUrl) {
      open.href = pageUrl;
      const host = it.source === "spotify" ? "Spotify" : it.source === "soundcloud" ? "SoundCloud" : it.source === "youtube" ? "YouTube" : (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return "Quelle"; } })();
      open.title = `Auf ${host} öffnen`;
    } else open.removeAttribute("href");
    const dl = $(".dl", node);
    if (it.status === "done") dl.href = `api/files/${it.id}`; else dl.removeAttribute("href");

    if (prev && prev.status !== "done" && it.status === "done") {
      restart(node, "just-done");
      setTimeout(() => node.classList.remove("just-done"), 2600);
      const r = $(".media", node).getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) setTimeout(() => fx(r.left + r.width / 2, r.top + r.height / 2, 46), 250);
    }
    node.classList.toggle("filtered", !matchesFilter(it));
  }

  function reorder() {
    const sorted = [...state.items.values()].sort(cmp);
    const nodes = sorted.map((it) => list.querySelector(`[data-id="${it.id}"]`)).filter(Boolean);
    const current = $$(".item:not(.leaving)", list);
    if (nodes.length === current.length && nodes.every((n, i) => n === current[i])) return;
    const first = new Map(nodes.map((n) => [n, n.getBoundingClientRect().top]));
    nodes.forEach((n) => list.appendChild(n));
    $$(".item.leaving", list).forEach((n) => list.appendChild(n));
    if (reduceMotion) return;
    nodes.forEach((n) => {
      const dy = first.get(n) - n.getBoundingClientRect().top;
      if (dy && !n.classList.contains("filtered")) n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 550, easing: "cubic-bezier(.22,1,.36,1)" });
    });
  }
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; reorder(); updateCounts(); }); };

  function upsert(it) {
    const prev = state.items.get(it.id);
    state.items.set(it.id, it);
    let node = list.querySelector(`[data-id="${it.id}"]`);
    if (!node) { node = createNode(it); list.prepend(node); }
    updateNode(node, it, prev);
    if (!prev || prev.status !== it.status) schedule();
    else if (it.status === "downloading") tab.update([...state.items.values()]);
  }
  function removeItem(id) {
    state.items.delete(id);
    if (selected.has(id)) { selected.delete(id); updateSelbar(); }
    const node = list.querySelector(`[data-id="${id}"]`);
    if (node) {
      node.classList.add("leaving");
      const done = () => node.remove();
      node.addEventListener("animationend", (ev) => { if (ev.target === node) done(); });
      setTimeout(done, 700);
    }
    schedule();
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
      const n = $(`[data-count="${k}"]`);
      if (lastCounts[k] !== c[k]) { n.textContent = c[k]; if (lastCounts[k] !== undefined) restart(n, "bump"); lastCounts[k] = c[k]; }
    }
    const running = all.filter((i) => i.status === "downloading" || i.status === "processing").length;
    document.body.classList.toggle("busy", running > 0);
    $("#activeSup").textContent = c.active ? `${c.active} aktiv` : "";
    const visible = all.filter(matchesFilter).length;
    const empty = $("#empty");
    empty.classList.toggle("show", visible === 0);
    $("#emptyBig").textContent = all.length === 0 ? "Leer." : "Nichts hier.";
    $("#emptyText").textContent = all.length === 0
      ? (can("download") ? "Link oben reinwerfen – oder einfach auf die Seite ziehen." : "Noch keine Downloads sichtbar.")
      : "In dieser Ansicht gibt es keine Einträge.";
    tab.update(all);
  }

  // --------------------------------------------- tab-titel & favicon
  const tab = (() => {
    const NAME = "ScobeTube";
    let progress = null;          // null = nichts aktiv
    let label = "";
    let frame = 0;
    const favicon = $("#favicon");
    const baseIcon = favicon.href;
    const cv = document.createElement("canvas"); cv.width = cv.height = 64;
    const ctx = cv.getContext("2d");
    let lastIconKey = "";

    function drawIcon(pct, mode) {
      const key = mode + ":" + Math.round(pct / 5);
      if (key === lastIconKey) return;
      lastIconKey = key;
      if (mode === "idle") { favicon.href = baseIcon; return; }
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#b9ff33";
      ctx.clearRect(0, 0, 64, 64);
      ctx.fillStyle = "#f3f0e7"; ctx.fillRect(8, 8, 54, 54);            // harter Schatten
      ctx.fillStyle = "#0b0b0c"; ctx.fillRect(2, 2, 54, 54);            // Grund
      ctx.fillStyle = accent;                                            // Füllstand von unten
      const h = Math.round(54 * Math.max(.06, pct / 100));
      ctx.fillRect(2, 56 - h, 54, h);
      ctx.strokeStyle = "#0b0b0c"; ctx.lineWidth = 3; ctx.strokeRect(2, 2, 54, 54);
      ctx.fillStyle = "#f3f0e7"; ctx.strokeStyle = "#0b0b0c"; ctx.lineWidth = 5;
      ctx.font = "900 26px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const t = mode === "proc" ? "⚙" : String(Math.floor(pct));
      ctx.strokeText(t, 29, 31); ctx.fillText(t, 29, 31);
      favicon.href = cv.toDataURL("image/png");
    }

    // Leerlauf: „ScobeTube“ wird Buchstabe für Buchstabe ein- und wieder ausgeblendet
    const idleFrames = (() => {
      const f = [];
      for (let i = 1; i <= NAME.length; i++) f.push(NAME.slice(0, i) + (i < NAME.length ? "▌" : ""));
      for (let i = 0; i < 8; i++) f.push(NAME);                       // stehen lassen
      for (let i = NAME.length - 1; i >= 1; i--) f.push(NAME.slice(0, i) + "▌");
      for (let i = 0; i < 3; i++) f.push(i % 2 ? "▌" : "\u2003");      // kurz blinken
      return f;
    })();

    setInterval(() => {
      frame++;
      if (progress === null) {
        document.title = idleFrames[frame % idleFrames.length];
      } else {
        // aktiv: Prozent fest, „ScobeTube“ blendet dahinter ein und aus
        const spin = "◐◓◑◒"[frame % 4];
        const showName = Math.floor(frame / 6) % 2 === 0;
        document.title = `${label} ${spin} ${showName ? NAME : "·".repeat(3)}`;
      }
    }, 180);

    return {
      update(items) {
        const running = items.filter((i) => i.status === "downloading" || i.status === "processing");
        const waiting = items.filter((i) => i.status === "queued" || i.status === "preparing").length;
        if (!running.length && !waiting) { progress = null; drawIcon(0, "idle"); return; }
        if (!running.length) { progress = 0; label = `⏳ ${waiting} wartet`; drawIcon(0, "dl"); return; }
        const pct = running.reduce((sum, i) => sum + (i.status === "processing" ? 100 : (i.progress || 0)), 0) / running.length;
        const proc = running.every((i) => i.status === "processing");
        progress = pct;
        const more = running.length + waiting > 1 ? ` (${running.length + waiting})` : "";
        label = proc ? `⚙ Konvertiert${more}` : `${Math.floor(pct)}%${more}`;
        drawIcon(pct, proc ? "proc" : "dl");
      },
    };
  })();

  function setFilter(f) {
    state.filter = f; store("filter", f);
    $$("#filters button[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
    for (const it of state.items.values()) {
      const node = list.querySelector(`[data-id="${it.id}"]`);
      if (!node) continue;
      const hide = !matchesFilter(it);
      if (node.classList.contains("filtered") && !hide) { node.style.animation = "none"; void node.offsetWidth; node.style.animation = ""; }
      node.classList.toggle("filtered", hide);
    }
    updateCounts();
  }
  $("#filters").addEventListener("click", (e) => { const b = e.target.closest("button[data-filter]"); if (b) setFilter(b.dataset.filter); });
  $("#clearDone").addEventListener("click", async () => {
    const which = state.filter === "failed" ? "failed" : "finished";
    try {
      const r = await api("clear", { method: "POST", body: { which, delete_files: false } });
      toast(r.removed ? `${r.removed} Einträge entfernt – Dateien bleiben` : "Nichts zum Aufräumen", r.removed ? "success" : "info");
    } catch (e) { toast(e.message, "error"); }
  });

  // Lösch-Popover
  const pop = $("#delPop"); let popId = null;
  function openDelPopover(anchor, id) {
    popId = id; pop.hidden = false;
    const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + 10; if (top + ph > innerHeight - 10) top = r.top - ph - 10;
    pop.style.top = top + "px"; pop.style.left = Math.max(10, Math.min(innerWidth - pw - 10, r.right - pw)) + "px";
    restart(pop, "x");
  }
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    const withFile = b.dataset.del === "file";
    api(`items/${popId}?delete_file=${withFile}`, { method: "DELETE" }).then(() => withFile && toast("Datei gelöscht", "success")).catch((err) => toast(err.message, "error"));
    pop.hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".del")) pop.hidden = true;
    if (!$("#userMenu").hidden && !e.target.closest(".user-wrap")) $("#userMenu").hidden = true;
  });
  addEventListener("scroll", () => { pop.hidden = true; }, { passive: true });

  // ------------------------------------------------------- live-events
  const conn = $("#conn");
  function connect() {
    const es = new EventSource("api/events");
    es.addEventListener("init", (e) => {
      conn.className = "conn ok";
      const { items } = JSON.parse(e.data);
      const ids = new Set(items.map((i) => i.id));
      for (const id of [...state.items.keys()]) if (!ids.has(id)) removeItem(id);
      items.sort(cmp).reverse().forEach(upsert);
      schedule();
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
    es.addEventListener("logout", () => { es.close(); location.href = "login"; });
    es.onerror = async () => {
      conn.className = "conn bad";
      try { const s = await fetch("api/auth/status").then((r) => r.json()); if (!s.user) location.href = "login"; } catch { /* offline */ }
    };
    es.onopen = () => { conn.className = "conn ok"; };
  }

  // ------------------------------------------------------------ modals
  function openModal(id) { const m = $("#" + id); m.classList.add("open"); m.setAttribute("aria-hidden", "false"); $("#userMenu").hidden = true; }
  function closeModal(m) { m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); if (m.id === "playerModal") player.stop(); }
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(m); }));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $$(".modal.open").forEach(closeModal); pop.hidden = true; $("#userMenu").hidden = true;
      if (document.body.classList.contains("selecting") && !$(".modal.open")) setSelecting(false);
    }
  });

  // Einstellungen
  $("#settingsBtn").addEventListener("click", () => { openModal("settings"); loadInfo(); loadStorage(); });
  $("#footStorage").addEventListener("click", () => { openModal("settings"); loadInfo(); loadStorage(); });

  async function loadInfo() {
    try {
      const i = await api("info");
      state.info = i;
      state.clockOffset = i.server_time - Date.now() / 1000;
      if (i.retention_hours) { $("#retentionInfo").hidden = false; $("#retentionHours").textContent = String(i.retention_hours).replace(".", ","); }
      tickUptime(); refreshDone();
      $("#ytdlpVersion").textContent = i.ytdlp;
      $("#ytdlpVersion2").textContent = i.ytdlp + (i.ytdlp_channel === "nightly" ? " (nightly)" : "");
      $("#appVersion").textContent = "v" + i.version;
      const p = $("#cookiePill"); p.textContent = i.cookies ? "aktiv" : "keine"; p.classList.toggle("on", i.cookies);
      $("#cookieDelete").hidden = !i.cookies;
    } catch { /* egal */ }
  }
  function tickUptime() {
    const i = state.info; if (!i) return;
    const app = now() - i.started_at;
    const container = i.container_uptime != null ? i.container_uptime + (now() - i.server_time) : app;
    $("#uptime").textContent = fmtUptime(container);
    $("#uptimeInfo").title = `Container läuft seit ${fmtUptime(container)}`;
  }
  setInterval(tickUptime, 1000);
  // Restzeiten der fertigen Downloads jede Minute auffrischen
  function refreshDone() { for (const it of state.items.values()) if (it.status === "done") { const n = list.querySelector(`[data-id="${it.id}"]`); if (n) updateNode(n, it, it); } }
  setInterval(refreshDone, 60000);

  async function loadStorage() {
    try {
      const st = await api("storage");
      const pct = (v) => st.disk_total ? Math.max(0, Math.min(100, v / st.disk_total * 100)) : 0;
      const used = pct(st.disk_used), dl = st.downloads > 0 ? Math.max(pct(st.downloads), 1) : 0;
      requestAnimationFrame(() => { $("#mDl").style.width = dl + "%"; $("#mOther").style.width = Math.max(0, used - dl) + "%"; });
      const warn = used > 90;
      $("#meter").classList.toggle("warn", warn);
      $("#storageText").textContent = `Downloads: ${fmtBytes(st.downloads)} in ${st.files} ${st.files === 1 ? "Datei" : "Dateien"} · Frei: ${fmtBytes(st.disk_free)} von ${fmtBytes(st.disk_total)}${warn ? " · ⚠ fast voll" : ""}`;
      $("#footStorageText").textContent = `${fmtBytes(st.disk_free)} frei`;
      $("#footStorage").classList.toggle("warn", warn);
      $("#purgeBtn").disabled = st.files === 0;
    } catch { /* egal */ }
  }
  let purgeTimer = null;
  $("#purgeBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget, label = $("span", btn);
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm"); label.textContent = "Wirklich ALLES löschen?";
      purgeTimer = setTimeout(() => { btn.classList.remove("confirm"); label.textContent = "Alle Downloads löschen"; }, 4000);
      return;
    }
    clearTimeout(purgeTimer); btn.classList.remove("confirm"); btn.classList.add("busy"); label.textContent = "Lösche…";
    try {
      const r = await api("storage/purge", { method: "POST" });
      toast(`${r.files} ${r.files === 1 ? "Datei" : "Dateien"} gelöscht – ${fmtBytes(r.freed)} frei`, "success", 5000);
      const rr = btn.getBoundingClientRect(); fx(rr.left + rr.width / 2, rr.top, 40);
    } catch (err) { toast(err.message, "error"); }
    finally { btn.classList.remove("busy"); label.textContent = "Alle Downloads löschen"; loadStorage(); }
  });
  $("#updateBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.classList.add("busy"); $("span", btn).textContent = "Lädt…";
    try {
      const r = await api("update-ytdlp", { method: "POST" });
      if (r.restarting) { toast(`yt-dlp ${r.version} installiert – Neustart…`, "success", 5000); setTimeout(() => location.reload(), 4000); }
      else toast(`yt-dlp ist aktuell (${r.version})`);
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
    try { await api("cookies", { method: "DELETE" }); toast("Cookies entfernt"); loadInfo(); } catch (err) { toast(err.message, "error"); }
  });
  const base = new URL("./", location.href).href;
  const bm = (kind) => `javascript:(()=>{window.open('${base}?kind=${kind}&url='+encodeURIComponent(location.href),'_blank')})()`;
  $("#bmVideo").href = bm("video"); $("#bmAudio").href = bm("audio");
  $$("#bmVideo, #bmAudio").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); toast("In die Lesezeichenleiste ziehen 😉"); }));

  // Benutzermenü
  const statBox = (value, label) => { const d = el("div", "stat"); d.append(el("b", "", value), el("span", "", label)); return d; };
  $("#userBtn").addEventListener("click", async () => {
    const m = $("#userMenu"); m.hidden = !m.hidden;
    if (m.hidden) return;
    try {
      const me = (await api("auth/me")).user, u = me.usage;
      $("#myStats").replaceChildren(statBox(String(u.downloads), "Downloads"), statBox(fmtBytes(u.bytes_total) || "0 B", "Geladen"),
        statBox(String(u.files_now), "Dateien jetzt"), statBox(fmtBytes(u.bytes_now) || "0 B", "Belegt"));
    } catch { /* egal */ }
  });
  $("#menuLogout").addEventListener("click", async () => { try { await api("auth/logout", { method: "POST" }); } finally { location.href = "login"; } });
  $("#menuPassword").addEventListener("click", () => { $("#pwForm").reset(); $("#pwMsg").textContent = ""; $("#pwStrength").dataset.s = "0"; openModal("pwModal"); setTimeout(() => $("#pwCurrent").focus(), 100); });
  $("#menuUsers").addEventListener("click", () => { openModal("usersModal"); loadUsers(); });

  // Passwort ändern
  const strength = (pw) => {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return pw ? Math.max(1, s) : 0;
  };
  $("#pwNew").addEventListener("input", (e) => { $("#pwStrength").dataset.s = strength(e.target.value); });
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#pwMsg"); msg.textContent = "";
    if ($("#pwNew").value !== $("#pwNew2").value) { msg.textContent = "Die neuen Passwörter stimmen nicht überein"; return; }
    const btn = $("button[type=submit]", e.target); btn.classList.add("busy");
    try {
      await api("auth/password", { method: "POST", body: { current: $("#pwCurrent").value, new: $("#pwNew").value } });
      closeModal($("#pwModal")); toast("Passwort geändert – andere Geräte wurden abgemeldet", "success", 5000);
    } catch (err) { msg.textContent = err.message; }
    finally { btn.classList.remove("busy"); }
  });

  // --------------------------------------------- benutzerverwaltung
  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function permGrid(container, selected) {
    container.replaceChildren();
    for (const [key, label] of Object.entries(state.permLabels)) {
      const l = el("label", "perm" + (key === "admin" ? " admin-perm" : ""));
      const cb = el("input"); cb.type = "checkbox"; cb.value = key; cb.checked = selected.includes(key);
      const box = el("span", "box-t"); box.innerHTML = CHECK;
      l.append(cb, box, el("span", "", label));
      container.appendChild(l);
    }
    const sync = () => {
      const isAdmin = $('input[value="admin"]', container).checked;
      $$("input", container).forEach((c) => { if (c.value !== "admin") { c.disabled = isAdmin; if (isAdmin) c.checked = true; } });
    };
    container.addEventListener("change", sync); sync();
  }
  const readPerms = (container) => {
    const admin = $('input[value="admin"]', container).checked;
    return admin ? ["admin"] : $$("input:checked", container).map((c) => c.value);
  };

  async function loadUsers() {
    const box = $("#usersList");
    try {
      const data = await api("users");
      state.permLabels = data.permissions;
      const maxNow = Math.max(1, ...data.users.map((u) => u.usage.bytes_now));
      box.replaceChildren(...data.users.map((u, i) => userCard(u, i, maxNow)));
      const sum = (k) => data.users.reduce((a, u) => a + (u.usage[k] || 0), 0) + (data.deleted_users[k] || 0);
      const tiles = [[String(sum("downloads")), "Downloads gesamt"], [fmtBytes(sum("bytes_total")) || "0 B", "Insgesamt geladen"],
        [String(sum("files_now")), "Dateien auf dem Server"], [fmtBytes(sum("bytes_now")) || "0 B", "Belegt jetzt"]];
      $("#usersTotals").replaceChildren(...tiles.map(([v, l], i) => { const t = statBox(v, l); t.style.setProperty("--i", i); if (i === 3) t.classList.add("hot"); return t; }));
      permGrid($("#nuPerms"), ["download", "files", "delete"]);
    } catch (err) { toast(err.message, "error"); }
  }

  function userCard(u, i, maxNow = 1) {
    const me = u.username.toLowerCase() === state.me.username.toLowerCase();
    const card = el("div", "u-card" + (u.disabled ? " disabled" : "")); card.style.setProperty("--i", i);
    const top = el("div", "u-top");
    const name = el("div", "u-name"); const b = el("b", "", u.username);
    if (u.admin) b.appendChild(el("span", "pill on", "Admin"));
    if (me) b.appendChild(el("span", "pill", "Du"));
    if (u.disabled) b.appendChild(el("span", "pill", "Gesperrt"));
    name.append(b, el("small", "", `Letzte Anmeldung: ${fmtDate(u.last_login)}`));
    const acts = el("div", "u-acts");
    const edit = el("button", "btn ghost small", "Bearbeiten"); edit.type = "button";
    edit.addEventListener("click", () => card.classList.toggle("open"));
    acts.appendChild(edit);
    top.append(el("span", "avatar", u.username.slice(0, 2).toUpperCase()), name, acts);
    const us = u.usage || {};
    const stats = el("div", "u-stats");
    stats.append(statBox(String(us.downloads || 0), "Downloads"), statBox(fmtBytes(us.bytes_total) || "0 B", "Insgesamt geladen"),
      statBox(String(us.files_now || 0), "Dateien jetzt"), statBox(fmtBytes(us.bytes_now) || "0 B", "Belegt jetzt"));
    const bar = el("div", "u-bar"); const fill = el("i"); bar.appendChild(fill); stats.appendChild(bar);
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = ((us.bytes_now || 0) / maxNow * 100) + "%"; }));

    const panel = el("div", "u-perms");
    panel.appendChild(el("span", "label", "Rechte"));
    const grid = el("div", "perm-grid"); permGrid(grid, u.permissions); panel.appendChild(grid);
    if (me) $$("input", grid).forEach((c) => { if (c.value === "admin") c.disabled = true; });
    const row = el("div", "row-acts");
    const save = el("button", "btn accent small", "Rechte speichern"); save.type = "button";
    save.addEventListener("click", async () => {
      try { await api(`users/${encodeURIComponent(u.username)}`, { method: "PATCH", body: { permissions: readPerms(grid) } }); toast(`Rechte von ${u.username} gespeichert`, "success"); loadUsers(); }
      catch (err) { toast(err.message, "error"); }
    });
    const pwIn = el("input", "input"); pwIn.type = "password"; pwIn.placeholder = "Neues Passwort setzen"; pwIn.autocomplete = "new-password"; pwIn.style.maxWidth = "230px"; pwIn.style.padding = "8px 10px"; pwIn.style.fontSize = "14px";
    const pwBtn = el("button", "btn ghost small", "Passwort setzen"); pwBtn.type = "button";
    pwBtn.addEventListener("click", async () => {
      if (pwIn.value.length < 8) { toast("Mindestens 8 Zeichen", "error"); return; }
      pwBtn.classList.add("busy");
      try { await api(`users/${encodeURIComponent(u.username)}`, { method: "PATCH", body: { password: pwIn.value } }); pwIn.value = ""; toast(`Passwort von ${u.username} geändert – alle Sitzungen beendet`, "success"); }
      catch (err) { toast(err.message, "error"); }
      finally { pwBtn.classList.remove("busy"); }
    });
    row.append(save, pwIn, pwBtn);
    if (!me) {
      const lock = el("button", "btn ghost small", u.disabled ? "Entsperren" : "Sperren"); lock.type = "button";
      lock.addEventListener("click", async () => {
        try { await api(`users/${encodeURIComponent(u.username)}`, { method: "PATCH", body: { disabled: !u.disabled } }); toast(u.disabled ? "Konto entsperrt" : "Konto gesperrt & abgemeldet", "success"); loadUsers(); }
        catch (err) { toast(err.message, "error"); }
      });
      const del = el("button", "btn danger small", "Löschen"); del.type = "button";
      del.addEventListener("click", async () => {
        if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Wirklich löschen?"; setTimeout(() => { del.classList.remove("confirm"); del.textContent = "Löschen"; }, 4000); return; }
        try { await api(`users/${encodeURIComponent(u.username)}`, { method: "DELETE" }); toast(`${u.username} gelöscht`, "success"); loadUsers(); }
        catch (err) { toast(err.message, "error"); }
      });
      row.append(lock, del);
    }
    panel.appendChild(row);
    card.append(top, stats, panel);
    return card;
  }

  $("#newUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#nuMsg"); msg.textContent = "";
    const btn = $("button[type=submit]", e.target); btn.classList.add("busy");
    try {
      await api("users", { method: "POST", body: { username: $("#nuName").value.trim(), password: $("#nuPass").value, permissions: readPerms($("#nuPerms")) } });
      toast(`Konto „${$("#nuName").value.trim()}“ angelegt`, "success");
      const r = btn.getBoundingClientRect(); fx(r.left + r.width / 2, r.top, 30);
      e.target.reset(); loadUsers();
    } catch (err) { msg.textContent = err.message; }
    finally { btn.classList.remove("busy"); }
  });

  // -------------------------------------------------------- systemmonitor
  const sysPanel = $("#sysPanel");
  let sysTimer = null;
  const pctFmt = (v) => v == null ? "–" : Math.round(v);
  function setGauge(key, value) {
    const g = $(`.gauge[data-key="${key}"]`, sysPanel);
    const v = value == null ? 0 : value;
    $(".g-val", g).style.strokeDashoffset = String(314.16 * (1 - v / 100));
    const num = $(".g-num", g);
    num.replaceChildren(document.createTextNode(pctFmt(value)), el("small", "", value == null ? "" : "%"));
    g.classList.toggle("warn", v >= 75 && v < 90);
    g.classList.toggle("crit", v >= 90);
  }
  function sparkPath(points, key, area) {
    if (points.length < 2) return "";
    const n = 90, step = 300 / (n - 1), off = (n - points.length) * step;
    let d = points.map((p, i) => `${i ? "L" : "M"}${(off + i * step).toFixed(1)},${(100 - Math.min(100, p[key])).toFixed(1)}`).join(" ");
    if (area) d += ` L${(off + (points.length - 1) * step).toFixed(1)},100 L${off.toFixed(1)},100 Z`;
    return d;
  }
  async function pollSystem() {
    if (document.hidden || sysPanel.classList.contains("collapsed")) return;
    try {
      const s = await api("system");
      setGauge("cpu", s.cpu); setGauge("mem", s.mem); setGauge("disk", s.disk);
      $("#cpuSub").textContent = s.cores ? `${s.cores} Kerne` : "";
      $("#memSub").textContent = s.mem_total ? `${fmtBytes(s.mem_used)} / ${fmtBytes(s.mem_total)}` : "";
      $("#diskSub").textContent = s.disk_total ? `${fmtBytes(s.disk_used)} / ${fmtBytes(s.disk_total)}` : "";
      $(".s-cpu", sysPanel).setAttribute("d", sparkPath(s.history, "cpu"));
      $(".s-mem", sysPanel).setAttribute("d", sparkPath(s.history, "mem"));
      $(".s-mem-area", sysPanel).setAttribute("d", sparkPath(s.history, "mem", true));
      const meta = [];
      const m = (label, value) => { const sp = el("span", "", label + " "); sp.appendChild(el("b", "", value)); meta.push(sp); };
      if (s.load) m("Load", s.load.join(" · "));
      if (s.app_rss) m("ScobeTube-RAM", fmtBytes(s.app_rss));
      if (s.swap_total) m("Swap", `${fmtBytes(s.swap_used)} / ${fmtBytes(s.swap_total)}`);
      m("Aktive Downloads", String(s.active));
      $("#sysMeta").replaceChildren(...meta);
    } catch (err) {
      if (/Recht/.test(err.message)) { sysPanel.hidden = true; clearInterval(sysTimer); }
    }
  }
  $("#sysToggle").addEventListener("click", (e) => {
    const collapsed = sysPanel.classList.toggle("collapsed");
    e.currentTarget.textContent = collapsed ? "Ausklappen" : "Einklappen";
    e.currentTarget.setAttribute("aria-expanded", String(!collapsed));
    store("sysCollapsed", collapsed);
    if (!collapsed) pollSystem();
  });
  function startSystem() {
    sysPanel.hidden = false;
    if (store("sysCollapsed")) { sysPanel.classList.add("collapsed"); $("#sysToggle").textContent = "Ausklappen"; }
    pollSystem();
    sysTimer = setInterval(pollSystem, 2000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollSystem(); });
  }

  // ---------------------------------------------------- auswahl & zip
  const selected = new Set();
  function setSelecting(on) {
    document.body.classList.toggle("selecting", on);
    $("#selectBtn").classList.toggle("active", on);
    $("#selbar").hidden = !on;
    if (!on) { selected.clear(); $$(".item.selected", list).forEach((n) => n.classList.remove("selected")); }
    updateSelbar();
  }
  function toggleSelect(id, force) {
    const on = force ?? !selected.has(id);
    if (on) selected.add(id); else selected.delete(id);
    const n = list.querySelector(`[data-id="${id}"]`); if (n) n.classList.toggle("selected", on);
    updateSelbar();
  }
  function updateSelbar() {
    for (const id of [...selected]) { const it = state.items.get(id); if (!it || it.status !== "done") selected.delete(id); }
    const size = [...selected].reduce((a, id) => a + (state.items.get(id)?.filesize || 0), 0);
    $("#selCount").textContent = selected.size;
    $("#selSize").textContent = size ? fmtBytes(size) : "";
    $("#selZip").disabled = !selected.size;
  }
  $("#selectBtn").addEventListener("click", () => setSelecting(!document.body.classList.contains("selecting")));
  $("#selDone").addEventListener("click", () => setSelecting(false));
  $("#selAll").addEventListener("click", () => {
    const done = [...state.items.values()].filter((i) => i.status === "done" && matchesFilter(i));
    const all = done.every((i) => selected.has(i.id));
    done.forEach((i) => toggleSelect(i.id, !all));
  });
  $("#selZip").addEventListener("click", (e) => {
    if (!selected.size) return;
    const a = el("a"); a.href = "api/zip?ids=" + [...selected].join(","); a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
    toast(`ZIP mit ${selected.size} ${selected.size === 1 ? "Datei" : "Dateien"} wird erstellt…`, "success");
    const r = e.currentTarget.getBoundingClientRect(); fx(r.left + r.width / 2, r.top, 30);
  });

  // ------------------------------------------------------------ player
  const player = (() => {
    const modal = $("#playerModal"), audio = $("#plAudio"), video = $("#plVideo");
    const seek = $("#plSeek"), vol = $("#plVol"), canvas = $("#plViz"), cctx = canvas.getContext("2d");
    let queue = [], idx = 0, media = audio, actx = null, analyser = null, raf = null, seeking = false;
    const sources = new WeakMap();
    const setRange = (r) => r.style.setProperty("--p", (r.value / r.max * 100) + "%");

    function playable() {
      return [...state.items.values()].filter((i) => i.status === "done" && i.filename && matchesFilter(i)).sort(cmp);
    }
    function ensureAudioGraph() {
      if (reduceMotion) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (!analyser) { analyser = actx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .8; analyser.connect(actx.destination); }
        if (!sources.has(audio)) { const src = actx.createMediaElementSource(audio); src.connect(analyser); sources.set(audio, src); }
        if (actx.state === "suspended") actx.resume();
      } catch { analyser = null; }
    }
    function draw() {
      const w = canvas.width = canvas.clientWidth * devicePixelRatio, h = canvas.height = canvas.clientHeight * devicePixelRatio;
      cctx.clearRect(0, 0, w, h);
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
      const n = 48, gap = 3 * devicePixelRatio, bw = (w - gap * (n - 1)) / n;
      let data = null;
      if (analyser) { data = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(data); }
      for (let i = 0; i < n; i++) {
        let v = data ? data[Math.floor(i / n * data.length * .8)] / 255 : (audio.paused ? .04 : .2 + .15 * Math.sin(Date.now() / 200 + i));
        const bh = Math.max(3 * devicePixelRatio, v * h * .95);
        cctx.fillStyle = i % 6 === 0 ? "#f3f0e7" : accent;
        cctx.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
      raf = requestAnimationFrame(draw);
    }
    function load(i) {
      idx = (i + queue.length) % queue.length;
      const it = queue[idx];
      const isVideo = it.options.kind === "video";
      modal.classList.toggle("video", isVideo);
      audio.pause(); video.pause();
      media = isVideo ? video : audio;
      video.hidden = !isVideo; $("#plFull").hidden = !isVideo;
      media.src = `api/play/${it.id}`;
      media.volume = vol.value / 100;
      $("#plTitle").textContent = it.title; $("#plTitle").title = it.title;
      $("#plArtist").textContent = it.uploader || it.playlist || "";
      $("#plCounter").textContent = queue.length > 1 ? `${idx + 1} / ${queue.length}` : "Player";
      const cover = $("#plCover");
      if (it.thumbnail) cover.src = it.thumbnail; else cover.removeAttribute("src");
      seek.value = 0; setRange(seek); $("#plCur").textContent = "0:00"; $("#plDur").textContent = fmtTime(it.duration) || "0:00";
      if (!isVideo) ensureAudioGraph();
      media.play().catch((err) => { if (err.name === "NotSupportedError") toast("Dieses Format kann dein Browser nicht abspielen", "error"); });
    }
    function bind(m) {
      m.addEventListener("play", () => { modal.classList.add("playing"); $("#plPlayIcon").innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'; });
      m.addEventListener("pause", () => { modal.classList.remove("playing"); $("#plPlayIcon").innerHTML = '<path d="M7 4.5v15l12-7.5z"/>'; });
      m.addEventListener("timeupdate", () => {
        if (m !== media || seeking || !m.duration) return;
        seek.value = Math.round(m.currentTime / m.duration * 1000); setRange(seek);
        $("#plCur").textContent = fmtTime(m.currentTime); $("#plDur").textContent = fmtTime(m.duration);
      });
      m.addEventListener("ended", () => { if (m === media && queue.length > 1 && idx < queue.length - 1) load(idx + 1); });
      m.addEventListener("error", () => { if (m === media && m.getAttribute("src")) toast("Abspielen nicht möglich (Format oder Datei fehlt)", "error"); });
    }
    bind(audio); bind(video);
    seek.addEventListener("input", () => { seeking = true; setRange(seek); if (media.duration) $("#plCur").textContent = fmtTime(seek.value / 1000 * media.duration); });
    seek.addEventListener("change", () => { if (media.duration) media.currentTime = seek.value / 1000 * media.duration; seeking = false; });
    vol.addEventListener("input", () => { media.volume = vol.value / 100; setRange(vol); store("volume", vol.value); });
    $("#plPlay").addEventListener("click", () => { if (media.paused) { if (media === audio) ensureAudioGraph(); media.play(); } else media.pause(); });
    $("#plPrev").addEventListener("click", () => { if (media.currentTime > 3) media.currentTime = 0; else load(idx - 1); });
    $("#plNext").addEventListener("click", () => load(idx + 1));
    $("#plFull").addEventListener("click", () => video.requestFullscreen && video.requestFullscreen());
    video.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
    addEventListener("keydown", (e) => {
      if (!modal.classList.contains("open") || e.target.closest("input:not([type=range]), textarea")) return;
      if (e.key === " ") { e.preventDefault(); $("#plPlay").click(); }
      else if (e.key === "ArrowRight") media.currentTime = Math.min(media.duration || 0, media.currentTime + 10);
      else if (e.key === "ArrowLeft") media.currentTime = Math.max(0, media.currentTime - 10);
      else if (e.key === "n") load(idx + 1);
    });
    const savedVol = store("volume"); if (savedVol != null) vol.value = savedVol; setRange(vol);

    return {
      open(id) {
        queue = playable();
        const i = queue.findIndex((q) => q.id === id);
        if (i < 0) return;
        openModal("playerModal");
        load(i);
        if (!raf) draw();
      },
      stop() {
        audio.pause(); video.pause();
        audio.removeAttribute("src"); video.removeAttribute("src"); audio.load(); video.load();
        cancelAnimationFrame(raf); raf = null;
        if (document.fullscreenElement) document.exitFullscreen();
      },
    };
  })();

  // ------------------------------------------------------- tag-editor
  let tagItem = null, coverBlob = null, previewUrl = null;
  const coverDrop = $("#coverDrop"), coverPrev = $("#coverPreview");
  function setCoverPreview(src, changed) {
    if (previewUrl && src !== previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (src) coverPrev.src = src; else coverPrev.removeAttribute("src");
    coverDrop.classList.toggle("empty", !src);
    coverDrop.classList.toggle("changed", !!changed);
  }
  function pickCover(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast("Bitte ein Bild auswählen", "error"); return; }
    if (file.size > 15 * 1024 * 1024) { toast("Bild ist zu groß (max. 15 MB)", "error"); return; }
    coverBlob = file;
    previewUrl = URL.createObjectURL(file);
    setCoverPreview(previewUrl, true);
    restart(coverDrop, "x");
  }
  $("#coverFile").addEventListener("change", (e) => { pickCover(e.target.files[0]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((t) => coverDrop.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); coverDrop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => coverDrop.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); coverDrop.classList.remove("drag"); if (t === "drop") pickCover(e.dataTransfer.files[0]); }));

  async function openTagEditor(id) {
    const it = state.items.get(id); if (!it) return;
    tagItem = id; coverBlob = null;
    $("#tagMsg").textContent = "";
    $("#tagForm").reset(); $("#tagRename").checked = true;
    $("#tagTitle").value = it.spotify?.title || ""; $("#tagArtist").value = it.uploader || ""; $("#tagAlbum").value = it.spotify?.album || "";
    setCoverPreview(it.thumbnail, false);
    openModal("tagModal");
    try {
      const m = await api(`items/${id}/meta`);
      if (tagItem !== id) return;
      if (m.title) $("#tagTitle").value = m.title;
      else if (!$("#tagTitle").value) $("#tagTitle").value = (it.title || "").replace(/^.* - /, "");
      if (m.artist || !$("#tagArtist").value) $("#tagArtist").value = m.artist;
      if (m.album) $("#tagAlbum").value = m.album;
      if (m.has_cover) setCoverPreview(`api/items/${id}/cover?t=${Date.now()}`, false);
    } catch (err) { $("#tagMsg").textContent = err.message; }
    setTimeout(() => $("#tagTitle").focus(), 120);
  }
  $("#tagForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target); btn.classList.add("busy");
    const fd = new FormData();
    fd.append("title", $("#tagTitle").value.trim());
    fd.append("artist", $("#tagArtist").value.trim());
    fd.append("album", $("#tagAlbum").value.trim());
    fd.append("rename", $("#tagRename").checked ? "1" : "0");
    if (coverBlob) fd.append("cover", coverBlob, coverBlob.name || "cover");
    try {
      const updated = await api(`items/${tagItem}/meta`, { method: "POST", body: fd });
      upsert(updated);
      closeModal($("#tagModal"));
      toast("Tags gespeichert", "success");
      const n = list.querySelector(`[data-id="${tagItem}"] .media`);
      if (n) { const r = n.getBoundingClientRect(); fx(r.left + r.width / 2, r.top + r.height / 2, 30); }
    } catch (err) { $("#tagMsg").textContent = err.message; }
    finally { btn.classList.remove("busy"); }
  });

  // --------------------------------------------------------------- start
  async function boot() {
    let me;
    try { me = await api("auth/me"); } catch { return; }
    state.me = me.user; state.permLabels = me.permissions;
    $("#userName").textContent = me.user.username;
    $("#userMenuName").textContent = me.user.username;
    $("#userAvatar").textContent = me.user.username.slice(0, 2).toUpperCase();
    $("#userRole").textContent = me.user.admin ? "Administrator" : "Benutzer";
    $("#menuUsers").hidden = !can("admin");
    $("#deck").hidden = !can("download");
    $("#clearDone").hidden = !can("delete");
    $("#selectBtn").hidden = !can("files");
    $("#secStorage").hidden = !can("storage");
    $("#secUpdate").hidden = !can("settings");
    $("#secCookies").hidden = !can("settings");
    $("#secBookmarks").hidden = !can("download");
    $("#settingsBtn").hidden = !(can("storage") || can("settings") || can("download"));
    $("#footStorage").hidden = !can("storage");

    const qp = new URLSearchParams(location.search);
    if (qp.get("url")) {
      urlEl.value = qp.get("url");
      if (qp.get("kind") === "audio" || qp.get("kind") === "video") { state.kind = qp.get("kind"); }
      const d = detectSource(urlEl.value); if (d) state.source = d;
      history.replaceState(null, "", location.pathname);
      setTimeout(() => toast("Link übernommen – mit „Laden“ starten"), 600);
    }
    setSource(state.source, false);
    setKind(state.kind, false);
    setFilter(state.filter);
    autosize(); updateMode();
    document.fonts && document.fonts.ready.then(moveKindSlider);
    connect(); loadInfo();
    if (can("settings")) startSystem();
    if (can("storage")) { loadStorage(); setInterval(loadStorage, 60000); }
  }
  boot();
})();
