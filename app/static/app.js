/* ScobeTube – Oberfläche */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotionPref = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const potato = () => !!(window.ScobePotato && window.ScobePotato.on());
  // „motion.reduced“ gilt auch im Potato-Modus (wird bei jedem Zugriff neu geprüft)
  const motion = { get reduced() { return reduceMotionPref || potato(); } };

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
      note: "Spotify-Musik ist kopiergeschützt. ScobeTube liest deshalb nur Titel, Interpret, Album und Cover von Spotify, lädt denselben Song von YouTube Music und schreibt die Spotify-Infos in die Datei. Unterstützt: Songs, Alben, Playlists und Künstler (Top-Songs).",
    },
    tidal: {
      audio: { formats: ["mp3", "m4a", "opus", "flac", "original"], qualities: ["best", "320", "256", "192", "128"] },
      placeholder: "Tidal-Link: Song, Album oder Playlist",
      search: null,
      note: "Tidal-Musik ist kopiergeschützt. ScobeTube liest deshalb nur Titel, Interpreten, Album, Cover und Länge von Tidal, lädt denselben Song von YouTube Music und schreibt die Tidal-Infos in die Datei. Unterstützt: Songs, Alben und Playlists (bis 50 Songs).",
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
  const isOwn = (it) => !!state.me && ((it.owner || "").toLowerCase() === state.me.username.toLowerCase() || can("view_all"));
  const isHttps = () => location.protocol === "https:";

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
  const detectSource = (t) => /open\.spotify\.com\/|spotify:(track|album|playlist|artist):/i.test(t) ? "spotify"
    : /tidal\.com\/(browse\/)?(track|album|playlist|mix)/i.test(t) ? "tidal"
    : /soundcloud\.com\//i.test(t) ? "soundcloud" : null;
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
    setTimeout(() => {
      if (potato()) { t.remove(); return; }
      t.classList.add("out"); t.addEventListener("animationend", () => t.remove(), { once: true });
      setTimeout(() => t.remove(), 600);   // Sicherheitsnetz
    }, ms);
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
      if (motion.reduced) return;
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
    $("#playlistLabel").textContent = src === "soundcloud" ? "Ganze Sets & Profile" : (src === "spotify" || src === "tidal") ? "Ganze Alben & Playlists" : "Ganze Playlist";
    if (SOURCES[src].note) $("#spNote").textContent = SOURCES[src].note;
    renderChips(animate);
    updateMode();
    requestAnimationFrame(moveKindSlider);
    if (animate) { const r = srcSwitch.getBoundingClientRect(); fx(r.left + r.width * ({ all: 1, soundcloud: 3, spotify: 5, tidal: 7 }[src] / 8), r.bottom, 18); }
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
  ["optPlaylist", "optThumb", "optSubs", "optSponsor", "optChapters", "optLyrics"].forEach((id) => {
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
      toast({ spotify: "Spotify-Link erkannt – Spotify-Modus aktiv", tidal: "Tidal-Link erkannt – Tidal-Modus aktiv" }[detected] || "SoundCloud-Link erkannt – Audio-Modus aktiv", "info", 2500);
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
      sponsorblock: state.source === "all" && $("#optSponsor").checked,
      chapters: $("#optChapters").checked,
      lyrics: state.kind === "audio" && $("#optLyrics").checked,
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
      if (!isUrl(v) && window.ScobeEggs && window.ScobeEggs.word(v)) { urlEl.value = ""; autosize(); updateMode(); return; }
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
    results.scrollIntoView({ behavior: motion.reduced ? "auto" : "smooth", block: "start" });
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
    $(".share", node).addEventListener("click", () => openShareUsers(it.id));
    $(".pin", node).addEventListener("click", async (e) => {
      const cur = state.items.get(it.id); if (!cur) return;
      try {
        const upd = await api(`items/${it.id}/keep`, { method: "POST", body: { keep: !cur.keep } });
        upsert(upd);
        toast(upd.keep ? "📌 Wird behalten – keine Auto-Löschung" : "Wird wieder automatisch gelöscht", upd.keep ? "success" : "info");
        if (upd.keep) { const r = e.currentTarget.getBoundingClientRect(); fx(r.left + r.width / 2, r.top + r.height / 2, 20); }
      } catch (err) { toast(err.message, "error"); }
    });
    node.addEventListener("click", (e) => {
      if (!document.body.classList.contains("selecting") || e.target.closest(".actions")) return;
      const cur = state.items.get(it.id);
      if (!cur || cur.status !== "done") return;
      e.preventDefault();
      toggleSelect(it.id);
    });
    $(".del", node).addEventListener("click", (e) => {
      const cur = state.items.get(it.id);
      if (cur && !isOwn(cur)) {
        api(`items/${it.id}`, { method: "DELETE" }).then(() => toast("Aus deiner Liste entfernt")).catch((err) => toast(err.message, "error"));
        return;
      }
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
    node.dataset.canKeep = can("keep") ? "1" : "0";
    node.dataset.canShare = can("share") ? "1" : "0";
    const own = isOwn(it);
    node.dataset.own = own ? "1" : "0";
    const sw = it.shared_with || [];
    $(".tag.shared", node).textContent = !own ? `👥 von ${it.owner || "?"}` : sw.length ? `👥 ${sw.length === 1 ? sw[0] : sw.length + " Personen"}` : "";
    $(".del", node).title = own ? "Entfernen" : "Aus meiner Liste entfernen";
    node.classList.toggle("kept", !!it.keep);
    const pin = $(".pin", node); pin.classList.toggle("on", !!it.keep);
    pin.title = it.keep ? "Nicht mehr behalten (wieder automatisch löschen)" : "Behalten – wird nicht automatisch gelöscht";
    $(".tag.kept", node).textContent = it.keep ? "📌 Behalten" : "";
    $(".tag.lib", node).textContent = it.library ? "📚 Mediathek" : "";
    $(".tag.lib", node).title = it.library ? "In der Mediathek: " + it.library : "";
    $(".tag.sb", node).textContent = o.sponsorblock ? "SponsorBlock" : "";
    $(".tag.chap", node).textContent = it.chapter ? `Kapitel ${it.chapter.number}/${it.chapter.count}` : (o.chapters && it.status !== "done" ? "Kapitel ✂" : "");
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
      const left = it.keep ? null : expiresIn(it);
      if (it.keep && state.info && state.info.retention_hours) { add("", "📌 wird behalten"); parts[parts.length - 1].className = "expires kept"; }
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
      const host = it.source === "spotify" ? "Spotify" : it.source === "tidal" ? "Tidal" : it.source === "soundcloud" ? "SoundCloud" : it.source === "youtube" ? "YouTube" : (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return "Quelle"; } })();
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
    if (motion.reduced) return;
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
      if (potato()) {   // 🥔: statischer Titel, nur bei Änderung neu setzen
        const t = progress === null ? NAME : `${label} · ${NAME}`;
        if (document.title !== t) document.title = t;
        return;
      }
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
    let ready = false;
    es.addEventListener("init", () => { setTimeout(() => { ready = true; }, 500); });
    es.addEventListener("update", (e) => {
      const it = JSON.parse(e.data), prev = state.items.get(it.id);
      if (!prev && ready && !isOwn(it) && it.status === "done") {
        toast(`👥 ${it.owner} hat „${it.title}“ mit dir geteilt`, "success", 5000);
      }
      upsert(it);
      if (prev && prev.status !== it.status) {
        if (it.status === "done") toast(`Fertig: ${it.title}`, "success");
        else if (it.status === "error") toast(`Fehlgeschlagen: ${it.title}`, "error", 5000);
      }
    });
    es.addEventListener("removed", (e) => removeItem(JSON.parse(e.data).id));
    es.addEventListener("logout", () => { es.close(); location.href = "login"; });
    es.addEventListener("notify", (e) => {
      const n = JSON.parse(e.data);
      toast(`${n.title}${n.body ? " – " + n.body : ""}`, n.kind === "security" ? "error" : "info", 9000);
      if (n.kind === "quota") { refreshReqPill(); if ($("#usersModal").classList.contains("open")) loadUsers(); }
    });
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
  $("#settingsBtn").addEventListener("click", () => { openModal("settings"); loadInfo(); loadStorage(); loadHealer(); if (can("admin")) loadLibrary(); });

  // ------------------------------------------------------- mediathek
  const lib = { mode: "pinned", layout: "artist_album", server: "none" };
  const LIB_HINTS = {
    navidrome: "Navidrome-Benutzer mit Admin-Rechten. Für den Scan nutzt ScobeTube die Subsonic-API (das Passwort wird nur gesalzen gehasht übertragen).",
    jellyfin: "API-Schlüssel anlegen unter Dashboard → API-Schlüssel. Den Mediathek-Ordner in Jellyfin als Musik-Mediathek hinzufügen.",
    plex: "Plex-Token (X-Plex-Token), zu finden über „XML anzeigen“ bei einem Eintrag in Plex. Den Ordner als Musik-Mediathek hinzufügen.",
  };
  function libChips(id, v) { $$(`#${id} .chip`).forEach((c) => c.classList.toggle("active", c.dataset.v === v)); }
  function renderLibServer() {
    libChips("libServer", lib.server);
    $("#libConn").hidden = lib.server === "none";
    $("#libUserF").hidden = lib.server !== "navidrome";
    $("#libSecretL").textContent = { navidrome: "Passwort", jellyfin: "API-Schlüssel", plex: "Plex-Token" }[lib.server] || "";
    $("#libUrl").placeholder = { navidrome: "http://navidrome:4533", jellyfin: "http://jellyfin:8096", plex: "http://plex:32400" }[lib.server] || "";
    $("#libHint").textContent = LIB_HINTS[lib.server] || "";
    $("#libTest").hidden = $("#libScan").hidden = lib.server === "none";
  }
  function renderLibrary(d) {
    Object.assign(lib, { mode: d.mode, layout: d.layout, server: d.server });
    $("#secLibrary").hidden = false;
    $("#libEnabled").checked = d.enabled;
    $(".lib-grid").classList.toggle("off", !d.enabled);
    $("#libPill").textContent = d.enabled ? "an" : "aus"; $("#libPill").classList.toggle("on", d.enabled);
    libChips("libMode", d.mode); libChips("libLayout", d.layout); renderLibServer();
    $("#libUrl").value = d.url || ""; $("#libUser").value = d.username || "";
    $("#libSecret").value = ""; $("#libSecret").placeholder = d.has_secret ? "•••• gespeichert" : "";
    $("#libDirWarn").hidden = d.dir_ok;
    $("#libDirWarn").textContent = d.dir_error ? "⚠ " + d.dir_error + ". In docker-compose.yml z. B. ./library:/library einhängen." : "";
    const scan = d.last_error ? ` · ⚠ letzter Scan: ${d.last_error}` : d.last_scan ? ` · letzter Scan ${fmtDate(d.last_scan)}` : "";
    $("#libInfo").textContent = `Ordner im Container: ${d.dir} · ${d.count} Song${d.count === 1 ? "" : "s"} übernommen${scan}`;
    $("#libExport").disabled = !d.enabled;
  }
  async function loadLibrary() { try { renderLibrary(await api("library")); } catch { /* keine Rechte */ } }
  [["libMode", "mode"], ["libLayout", "layout"], ["libServer", "server"]].forEach(([id, key]) => {
    $("#" + id).addEventListener("click", (e) => {
      const c = e.target.closest(".chip"); if (!c) return;
      lib[key] = c.dataset.v; libChips(id, lib[key]); if (key === "server") renderLibServer();
    });
  });
  $("#libEnabled").addEventListener("change", () => $(".lib-grid").classList.toggle("off", !$("#libEnabled").checked));
  async function saveLibrary(quiet) {
    const body = { enabled: $("#libEnabled").checked, ...lib, url: $("#libUrl").value.trim(), username: $("#libUser").value.trim() };
    if ($("#libSecret").value) body.secret = $("#libSecret").value;
    const d = await api("library", { method: "PUT", body });
    renderLibrary(d);
    if (!quiet) toast(d.enabled ? "Mediathek gespeichert" : "Mediathek ausgeschaltet", "success");
    return d;
  }
  const libAction = (id, fn) => $("#" + id).addEventListener("click", async (e) => {
    const b = e.currentTarget; b.classList.add("busy");
    try { await fn(); } catch (err) { toast(err.message, "error"); }
    b.classList.remove("busy");
  });
  libAction("libSave", () => saveLibrary(false));
  libAction("libTest", async () => { await saveLibrary(true); toast((await api("library/test", { method: "POST" })).message, "success"); });
  libAction("libScan", async () => { await saveLibrary(true); toast((await api("library/scan", { method: "POST" })).message, "success"); loadLibrary(); });
  libAction("libExport", async () => {
    await saveLibrary(true);
    const r = await api("library/export", { method: "POST" });
    toast(r.total ? `${r.exported} von ${r.total} Songs in die Mediathek übernommen` : "Keine passenden Songs gefunden", r.total ? "success" : undefined);
    loadLibrary();
  });
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
  // Selbstheilung: Status, Kanal, Meldungen
  function renderHealer(h) {
    $("#healPill").textContent = h.auto ? "aktiv" : "aus"; $("#healPill").classList.toggle("on", h.auto);
    $$("#channelChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.ch === h.channel));
    $("#lastCheck").textContent = h.last_check ? `Zuletzt geprüft: ${fmtDate(h.last_check)}` : "";
    $("#healHistory").replaceChildren(...(h.history || []).slice(0, 6).map((x) => el("li", "", `${fmtDate(x.time)} – ${x.text}`)));
    const icon = { info: "🩹", warn: "⚠️", error: "🚨" };
    $("#notices").replaceChildren(...(h.notices || []).map((n) => {
      const d = el("div", `notice ${n.level}`);
      const p = el("p"); p.append(el("b", "", "Selbstheilung"), n.text + " ", el("small", "", fmtDate(n.time)));
      const x = el("button", "icon-btn", "×"); x.title = "Ausblenden";
      x.addEventListener("click", async () => { try { renderHealer(await api("healer/dismiss", { method: "POST", body: { id: n.id } })); } catch { /* egal */ } });
      d.append(el("span", "ni", icon[n.level] || "🩹"), p, x);
      return d;
    }));
  }
  async function loadHealer() { if (!can("settings")) return; try { renderHealer(await api("healer")); } catch { /* egal */ } }
  $("#channelChips").addEventListener("click", async (e) => {
    const c = e.target.closest(".chip"); if (!c || c.classList.contains("active")) return;
    c.classList.add("pop");
    try {
      const r = await api("healer/channel", { method: "POST", body: { channel: c.dataset.ch } });
      renderHealer(r);
      if (r.restarting) { toast(`yt-dlp ${r.version} (${c.dataset.ch}) installiert – Neustart…`, "success", 5000); setTimeout(() => location.reload(), 4000); }
      else toast(`Kanal: ${c.dataset.ch}`, "success");
    } catch (err) { toast(err.message, "error", 6000); }
  });

  $("#updateBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.classList.add("busy"); $("span", btn).textContent = "Lädt…";
    try {
      const r = await api("update-ytdlp", { method: "POST" });
      if (r.restarting) { toast(`yt-dlp ${r.version} installiert – Neustart…`, "success", 5000); setTimeout(() => location.reload(), 4000); }
      else toast(`yt-dlp ist aktuell (${r.version})`);
    } catch (err) { toast(err.message, "error", 6000); }
    finally { btn.classList.remove("busy"); $("span", btn).textContent = "Jetzt prüfen"; loadHealer(); }
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
      renderQuota(me.quota);
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
      loadQuotaRequests();
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
    if (u.twofa) b.appendChild(el("span", "pill on", "2FA"));
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
    const gen = el("button", "btn ghost small", "🎲 Zufällig"); gen.type = "button"; gen.title = "Sicheres Zufallspasswort erzeugen";
    gen.addEventListener("click", () => {
      const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const rnd = crypto.getRandomValues(new Uint32Array(14));
      pwIn.value = Array.from(rnd, (n) => abc[n % abc.length]).join("");
      pwIn.type = "text"; pwIn.select();
    });
    row.append(save);
    const emergency = el("div", "emergency");
    emergency.append(el("span", "label", "🚨 Notfall & Sicherheit"));
    const pwRow = el("div", "row-acts"); pwRow.append(pwIn, gen, pwBtn);
    emergency.append(el("p", "em-hint", "Passwort vergessen? Neues setzen und der Person sicher mitteilen. Alle Sitzungen werden beendet."), pwRow);
    const sec = el("div", "em-2fa");
    const callSec = async (body, msg) => {
      try {
        await api(`users/${encodeURIComponent(u.username)}/security`, { method: "POST", body });
        toast(msg, "success"); loadUsers();
      } catch (err) { toast(err.message, "error"); }
    };
    const confirmBtn = (label, onGo) => {
      const b = el("button", "btn ghost small", label); b.type = "button";
      b.addEventListener("click", () => {
        if (!b.classList.contains("confirm")) { b.classList.add("confirm"); const old = b.textContent; b.textContent = "Sicher?"; setTimeout(() => { b.classList.remove("confirm"); b.textContent = old; }, 3500); return; }
        onGo();
      });
      return b;
    };
    if (u.twofa) {
      const st = el("p", "em-hint", `Zwei-Faktor-Login: ${u.totp ? "Authenticator-App" : ""}${u.totp && u.passkeys ? " + " : ""}${u.passkeys ? u.passkeys + " Passkey" + (u.passkeys > 1 ? "s" : "") : ""} · ${u.recovery_left} Wiederherstellungscodes übrig`);
      sec.append(st);
      const acts = el("div", "row-acts");
      if (u.totp) acts.append(confirmBtn("App-2FA entfernen", () => callSec({ action: "totp" }, `Authenticator-App von ${u.username} entfernt`)));
      if (u.passkeys > 1) acts.append(confirmBtn("Alle Passkeys löschen", () => callSec({ action: "passkeys" }, `Alle Passkeys von ${u.username} gelöscht`)));
      if (u.recovery_left) acts.append(confirmBtn("Wiederherstellungscodes löschen", () => callSec({ action: "recovery" }, "Wiederherstellungscodes gelöscht")));
      acts.append(confirmBtn("⚠ Komplett zurücksetzen", async () => {
        try { await api(`users/${encodeURIComponent(u.username)}/reset-2fa`, { method: "POST" }); toast(`Zwei-Faktor-Login von ${u.username} komplett entfernt`, "success"); loadUsers(); }
        catch (err) { toast(err.message, "error"); }
      }));
      sec.append(acts);
      if ((u.passkey_list || []).length) {
        const list = el("div", "pk-list");
        u.passkey_list.forEach((pk) => {
          const r = el("div", "pk");
          const info = el("div"); info.style.flex = "1"; info.style.minWidth = "0";
          info.append(el("b", "", "🔑 " + pk.name), el("small", "", ` · angelegt ${fmtDate(pk.created)} · zuletzt ${fmtDate(pk.last_used)}`));
          r.append(info, confirmBtn("Löschen", () => callSec({ action: "passkey", id: pk.id }, `Passkey „${pk.name}“ gelöscht`)));
          list.append(r);
        });
        sec.append(list);
      }
    } else {
      sec.append(el("p", "em-hint", "Kein Zwei-Faktor-Login eingerichtet."));
    }
    emergency.append(sec);
    const devBox = el("div", "em-2fa");
    const devHead = el("p", "em-hint", "Angemeldete Geräte: …");
    const devActs = el("div", "row-acts");
    const devList = el("div", "dev-list");
    const outAll = confirmBtn("Überall abmelden", async () => {
      try { await api(`users/${encodeURIComponent(u.username)}/logout`, { method: "POST" }); toast(`${u.username} wurde auf allen Geräten abgemeldet`, "success"); loadUserDevices(); }
      catch (err) { toast(err.message, "error"); }
    });
    if (!me) devActs.append(outAll);
    devBox.append(devHead, devList, devActs);
    emergency.append(devBox);
    const loadUserDevices = async () => {
      try {
        const { sessions } = await api(`users/${encodeURIComponent(u.username)}/sessions`);
        devHead.textContent = sessions.length ? `Angemeldete Geräte: ${sessions.length}` : "Zurzeit auf keinem Gerät angemeldet.";
        devList.replaceChildren(...sessions.map((d) => deviceRow(d, null)));
        outAll.hidden = !sessions.length;
      } catch { devHead.textContent = "Geräte konnten nicht geladen werden."; }
    };
    edit.addEventListener("click", () => { if (card.classList.contains("open")) loadUserDevices(); });
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
    if (!u.admin) {
      const qRow = el("div", "row-acts quota-row");
      const qIn = el("input", "input"); qIn.type = "number"; qIn.min = "0"; qIn.step = "1"; qIn.inputMode = "decimal";
      qIn.placeholder = `Standard (${state.quotaDefault ?? 10} GB)`; qIn.value = u.quota_gb ?? "";
      const qBtn = el("button", "btn ghost small", "Speicher setzen"); qBtn.type = "button";
      qBtn.addEventListener("click", async () => {
        try {
          await api(`users/${encodeURIComponent(u.username)}`, { method: "PATCH", body: { quota_gb: qIn.value === "" ? null : Number(qIn.value) } });
          toast(qIn.value === "" ? `${u.username}: Standard-Kontingent` : Number(qIn.value) === 0 ? `${u.username}: unbegrenzter Speicher` : `${u.username}: ${qIn.value} GB`, "success"); loadUsers();
        } catch (err) { toast(err.message, "error"); }
      });
      qRow.append(el("span", "label", "Speicher (GB, 0 = unbegrenzt)"), qIn, qBtn);
      panel.appendChild(qRow);
    }
    panel.appendChild(emergency);
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
  let lastSysPoll = 0;
  async function pollSystem() {
    if (document.hidden || sysPanel.classList.contains("collapsed")) return;
    if (potato() && Date.now() - lastSysPoll < 6000) return;   // 🥔: nur alle 6 Sekunden
    lastSysPoll = Date.now();
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
    let order = [], pos = 0, shuffle = !!store("plShuffle"), repeat = store("plRepeat") || "off";
    const sources = new WeakMap();
    const setRange = (r) => r.style.setProperty("--p", (r.value / r.max * 100) + "%");

    function playable() {
      return [...state.items.values()].filter((i) => i.status === "done" && i.filename && matchesFilter(i)).sort(cmp);
    }
    function ensureAudioGraph() {
      if (motion.reduced) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (!analyser) { analyser = actx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .8; analyser.connect(actx.destination); }
        if (!sources.has(audio)) { const src = actx.createMediaElementSource(audio); src.connect(analyser); sources.set(audio, src); }
        if (actx.state === "suspended") actx.resume();
      } catch { analyser = null; }
    }
    const peaks = [];
    function draw() {
      const w = canvas.width = canvas.clientWidth * devicePixelRatio, h = canvas.height = canvas.clientHeight * devicePixelRatio;
      cctx.clearRect(0, 0, w, h);
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
      const n = 56, gap = 4 * devicePixelRatio, bw = (w - gap * (n - 1)) / n, cap = 3 * devicePixelRatio;
      let data = null;
      if (analyser) { data = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(data); }
      peaks.length = n;
      for (let i = 0; i < n; i++) {
        // Bässe links, Höhen rechts – leicht logarithmisch verteilt, damit es lebendiger aussieht
        const bin = data ? Math.floor(Math.pow(i / n, 1.6) * data.length * .85) : 0;
        let v = data ? data[bin] / 255 : (audio.paused ? .03 : .18 + .12 * Math.sin(Date.now() / 220 + i * .5));
        const bh = Math.max(2 * devicePixelRatio, v * h * .82);
        const x = i * (bw + gap);
        const grad = cctx.createLinearGradient(0, h - bh, 0, h);
        grad.addColorStop(0, accent); grad.addColorStop(1, "rgba(0,0,0,0)");
        cctx.fillStyle = grad;
        cctx.fillRect(x, h - bh, bw, bh);
        // Spitzen-Markierung fällt langsam nach unten
        peaks[i] = Math.max((peaks[i] || 0) - h * .012, bh);
        cctx.fillStyle = "#f3f0e7";
        cctx.fillRect(x, h - peaks[i] - cap * 2, bw, cap);
      }
      raf = requestAnimationFrame(draw);
    }
    // ---- Reihenfolge (Shuffle) & Wiederholen
    function buildOrder() {
      order = queue.map((_, i) => i);
      if (shuffle) {
        order.splice(order.indexOf(idx), 1);
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        order.unshift(idx);
      }
      pos = order.indexOf(idx);
    }
    function step(dir, auto) {
      if (!queue.length) return;
      if (auto && repeat === "one") { media.currentTime = 0; media.play(); return; }
      let n = pos + dir;
      if (n >= order.length) {
        if (auto && repeat === "off") return;
        if (shuffle) { const last = idx; buildOrder(); if (order.length > 1 && order[0] === last) order.push(order.shift()); }
        n = 0;
      } else if (n < 0) n = order.length - 1;
      load(order[n]);
    }
    function renderModes() {
      $("#plShuffle").classList.toggle("on", shuffle);
      const rb = $("#plRepeat");
      rb.classList.toggle("on", repeat !== "off"); rb.classList.toggle("one", repeat === "one");
      rb.title = { off: "Wiederholen: aus (R)", all: "Wiederholen: alle (R)", one: "Wiederholen: dieser Song (R)" }[repeat];
    }
    $("#plShuffle").addEventListener("click", () => {
      shuffle = !shuffle; store("plShuffle", shuffle); buildOrder(); renderModes();
      toast(shuffle ? "Zufällige Reihenfolge an" : "Zufällige Reihenfolge aus");
    });
    $("#plRepeat").addEventListener("click", () => {
      repeat = { off: "all", all: "one", one: "off" }[repeat]; store("plRepeat", repeat); renderModes();
      toast({ off: "Wiederholen aus", all: "Alle wiederholen", one: "Diesen Song wiederholen" }[repeat]);
    });
    renderModes();

    // ---- Sperrbildschirm / Kopfhörer-Tasten (Media Session)
    const ms = "mediaSession" in navigator ? navigator.mediaSession : null;
    const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return ""; } };
    function sessionMeta(it) {
      if (!ms || typeof MediaMetadata === "undefined") return;
      const art = it.thumbnail ? [{ src: absUrl(it.thumbnail), sizes: "512x512" }] : [{ src: absUrl("static/icon-512.png"), sizes: "512x512", type: "image/png" }];
      const sp = it.spotify || {};
      try {
        ms.metadata = new MediaMetadata({ title: sp.title || it.title || "ScobeTube", artist: (sp.artists || []).join(", ") || it.uploader || "",
          album: sp.album || it.playlist || "ScobeTube", artwork: art });
      } catch { /* älterer Browser */ }
    }
    let lastPos = 0;
    function sessionPos(force) {
      if (!ms || !ms.setPositionState || !media.duration || !isFinite(media.duration)) return;
      const t = Date.now(); if (!force && t - lastPos < 1000) return; lastPos = t;
      try { ms.setPositionState({ duration: media.duration, playbackRate: media.playbackRate || 1, position: Math.min(media.currentTime, media.duration) }); } catch { /* egal */ }
    }
    if (ms) {
      const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* nicht unterstützt */ } };
      h("play", () => { if (media === audio) ensureAudioGraph(); media.play(); });
      h("pause", () => media.pause());
      h("previoustrack", () => { if (media.currentTime > 3) media.currentTime = 0; else step(-1); });
      h("nexttrack", () => step(1));
      h("seekbackward", (d) => { media.currentTime = Math.max(0, media.currentTime - (d.seekOffset || 10)); sessionPos(true); });
      h("seekforward", (d) => { media.currentTime = Math.min(media.duration || 0, media.currentTime + (d.seekOffset || 10)); sessionPos(true); });
      h("seekto", (d) => { if (d.fastSeek && media.fastSeek) media.fastSeek(d.seekTime); else media.currentTime = d.seekTime; sessionPos(true); });
      h("stop", () => closeModal(modal));
    }

    // ---- Songtext (synchronisiert, von lrclib.net)
    const lyrBox = $("#plLyrics"), lyrScroll = $("#plLyrScroll"), lyrLines = $("#plLyrLines"), lyrFoot = $("#plLyrFoot");
    let lyrOn = !!store("plLyrics"), lyr = null, lyrFor = null, lyrIdx = -1, lyrRaf = null, userScroll = 0, lyrReq = 0;
    function parseLrc(text) {
      const out = [];
      for (const raw of (text || "").split(/\r?\n/)) {
        const m = raw.trim().match(/^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$/);
        if (!m) continue;
        for (const t of m[1].matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)) {
          const words = [...m[2].matchAll(/<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>([^<]*)/g)]
            .map((w) => ({ t: +w[1] * 60 + parseFloat(w[2].replace(":", ".")), text: w[3] })).filter((w) => w.text.trim());
          const text = words.length ? words.map((w) => w.text.trim()).join(" ") : m[2].trim();
          out.push({ t: +t[1] * 60 + +t[2] + (t[3] ? +t[3] / 10 ** t[3].length : 0), text, words: words.length ? words : null });
        }
      }
      return out.sort((a, b) => a.t - b.t);
    }
    function lyrMessage(title, sub) {
      lyr = null; lyrLines.replaceChildren(); lyrScroll.classList.remove("lyr-plain");
      const d = el("div", "lyr-msg"); d.append(el("b", "", title)); if (sub) d.append(el("span", "", sub));
      lyrLines.append(d);
    }
    function lyrFooter(it, data) {
      const parts = [];
      if (data?.found && !data.instrumental) parts.push(el("span", "", `${data.synced ? "♪ Synchronisiert" : "Nicht synchronisiert"} · Quelle: LRCLIB`));
      else parts.push(el("span", "", "Songtexte: lrclib.net"));
      parts.push(el("span", "grow"));
      if (data?.found && data.can_embed && !data.instrumental) {
        const b = el("button", "btn ghost small", "In Datei speichern"); b.type = "button";
        b.title = "Songtext in die Audiodatei schreiben – Navidrome, Jellyfin, Poweramp & Co. zeigen ihn dann mit an";
        b.addEventListener("click", async () => {
          b.classList.add("busy");
          try { const r = await api(`items/${it.id}/lyrics/embed`, { method: "POST" }); toast(r.synced ? "Synchronisierter Songtext gespeichert" : "Songtext gespeichert", "success"); b.textContent = "✓ Gespeichert"; b.disabled = true; }
          catch (err) { toast(err.message, "error"); }
          b.classList.remove("busy");
        });
        parts.push(b);
      }
      const again = el("button", "btn ghost small", "Neu suchen"); again.type = "button";
      again.addEventListener("click", () => loadLyrics(it, true));
      parts.push(again);
      lyrFoot.replaceChildren(...parts);
    }
    async function loadLyrics(it, refresh) {
      lyrFor = it.id; lyrIdx = -1;
      const req = ++lyrReq;
      lyrMessage("Suche Songtext …", it.title);
      lyrFoot.replaceChildren();
      let data;
      try { data = await api(`items/${it.id}/lyrics${refresh ? "?refresh=1" : ""}`); }
      catch (err) { if (req === lyrReq) { lyrMessage("Gerade nicht erreichbar", err.message); lyrFooter(it, null); } return; }
      if (req !== lyrReq) return;
      lyrFooter(it, data);
      if (!data.found) return lyrMessage("Kein Songtext gefunden", `Gesucht: ${[data.query?.artist, data.query?.title].filter(Boolean).join(" – ")}`);
      if (data.instrumental) return lyrMessage("♪ Instrumental ♪", "Dieser Song hat keinen Text.");
      const synced = parseLrc(data.synced);
      if (synced.length) {
        lyr = synced;
        lyrScroll.classList.remove("lyr-plain");
        lyrLines.replaceChildren(...synced.map((l) => {
          const b = el("button", "lyr-line" + (l.text ? "" : " gap") + (l.words ? " karaoke" : ""), l.words ? "" : l.text || "♪ ♪ ♪"); b.type = "button";
          if (l.words) l.words.forEach((w, k) => { if (k) b.append(" "); b.append(el("span", "w", w.text.trim())); });
          b.addEventListener("click", () => { media.currentTime = l.t; userScroll = 0; if (media.paused) media.play(); });
          return b;
        }));
        lyrScroll.scrollTop = 0;
        syncLyrics(true);
      } else {
        lyrScroll.classList.add("lyr-plain");
        lyrLines.replaceChildren(...data.plain.split(/\r?\n/).map((t) => el("div", "lyr-line", t || "\u00a0")));
        lyrScroll.scrollTop = 0;
      }
    }
    function syncLyrics(force) {
      if (!lyr || !lyrOn) return;
      const t = media.currentTime + 0.25;   // minimal früher, damit die Zeile mit dem Gesang „steht“
      let lo = 0, hi = lyr.length - 1, i = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyr[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      const kids = lyrLines.children;
      if (i >= 0 && lyr[i].words && kids[i]) {   // wortgenau mitleuchten
        const ws = kids[i].children;
        lyr[i].words.forEach((w, k) => ws[k] && ws[k].classList.toggle("sung", w.t <= t));
      }
      if (i === lyrIdx && !force) return;
      for (let k = 0; k < kids.length; k++) { kids[k].classList.toggle("past", k < i); kids[k].classList.toggle("now", k === i); }
      if (lyrIdx >= 0 && lyrIdx !== i && kids[lyrIdx]) for (const w of kids[lyrIdx].children) w.classList.remove("sung");
      lyrIdx = i;
      const cur = kids[Math.max(0, i)];
      if (cur && Date.now() - userScroll > 3500) {
        const top = cur.offsetTop - lyrScroll.clientHeight / 2 + cur.offsetHeight / 2;
        lyrScroll.scrollTo({ top, behavior: motion.reduced || force ? "auto" : "smooth" });
      }
    }
    function lyrLoop() { syncLyrics(); lyrRaf = requestAnimationFrame(lyrLoop); }
    ["wheel", "touchmove"].forEach((ev) => lyrScroll.addEventListener(ev, () => { userScroll = Date.now(); }, { passive: true }));
    function setLyrics(on) {
      lyrOn = on; store("plLyrics", on);
      lyrBox.hidden = !on; modal.classList.toggle("lyr", on); $("#plLyrBtn").classList.toggle("on", on);
      cancelAnimationFrame(lyrRaf); lyrRaf = null;
      if (!on || !queue[idx]) return;
      if (lyrFor !== queue[idx].id) loadLyrics(queue[idx]);
      else syncLyrics(true);
      if (!potato()) lyrLoop();
    }
    $("#plLyrBtn").addEventListener("click", () => setLyrics(!lyrOn));

    function load(i) {
      idx = (i + queue.length) % queue.length;
      if (order.length !== queue.length) buildOrder(); else pos = order.indexOf(idx);
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
      const cover = $("#plCover"), sleeve = $("#plSleeve"), backdrop = $("#plBackdrop");
      backdrop.classList.remove("loaded");
      for (const img of [cover, sleeve, backdrop]) { if (it.thumbnail) img.src = it.thumbnail; else img.removeAttribute("src"); }
      backdrop.onload = () => backdrop.classList.add("loaded");
      $("#plAlbum").textContent = it.spotify?.album || it.playlist || "";
      $("#plFormat").textContent = (it.options.format || "").toUpperCase() + (it.filesize ? " · " + fmtBytes(it.filesize) : "");
      seek.value = 0; setRange(seek); $("#plCur").textContent = "0:00"; $("#plDur").textContent = fmtTime(it.duration) || "0:00";
      if (!isVideo) ensureAudioGraph();
      sessionMeta(it);
      lyrFor = null; lyr = null;
      if (lyrOn) setLyrics(true);
      media.play().catch((err) => { if (err.name === "NotSupportedError") toast("Dieses Format kann dein Browser nicht abspielen", "error"); });
    }
    function bind(m) {
      m.addEventListener("play", () => { if (ms) ms.playbackState = "playing"; modal.classList.add("playing"); $("#plPlayIcon").innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'; });
      m.addEventListener("pause", () => { if (ms && m === media) ms.playbackState = "paused"; modal.classList.remove("playing"); $("#plPlayIcon").innerHTML = '<path d="M7 4.5v15l12-7.5z"/>'; });
      m.addEventListener("timeupdate", () => {
        if (m !== media || seeking || !m.duration) return;
        seek.value = Math.round(m.currentTime / m.duration * 1000); setRange(seek);
        $("#plCur").textContent = fmtTime(m.currentTime); $("#plDur").textContent = fmtTime(m.duration);
        sessionPos();
        if (potato()) syncLyrics();
      });
      m.addEventListener("seeked", () => { if (m === media) { sessionPos(true); syncLyrics(true); } });
      m.addEventListener("loadedmetadata", () => { if (m === media) sessionPos(true); });
      m.addEventListener("ended", () => { if (m === media) step(1, true); });
      m.addEventListener("error", () => { if (m === media && m.getAttribute("src")) toast("Abspielen nicht möglich (Format oder Datei fehlt)", "error"); });
    }
    bind(audio); bind(video);
    seek.addEventListener("input", () => { seeking = true; setRange(seek); if (media.duration) $("#plCur").textContent = fmtTime(seek.value / 1000 * media.duration); });
    seek.addEventListener("change", () => { if (media.duration) media.currentTime = seek.value / 1000 * media.duration; seeking = false; });
    vol.addEventListener("input", () => { media.volume = vol.value / 100; setRange(vol); store("volume", vol.value); });
    $("#plPlay").addEventListener("click", () => { if (media.paused) { if (media === audio) ensureAudioGraph(); media.play(); } else media.pause(); });
    $("#plPrev").addEventListener("click", () => { if (media.currentTime > 3) media.currentTime = 0; else step(-1); });
    $("#plNext").addEventListener("click", () => step(1));
    $("#plFull").addEventListener("click", () => video.requestFullscreen && video.requestFullscreen());
    video.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
    addEventListener("keydown", (e) => {
      if (!modal.classList.contains("open") || e.target.closest("input:not([type=range]), textarea")) return;
      if (e.key === " ") { e.preventDefault(); $("#plPlay").click(); }
      else if (e.key === "ArrowRight") media.currentTime = Math.min(media.duration || 0, media.currentTime + 10);
      else if (e.key === "ArrowLeft") media.currentTime = Math.max(0, media.currentTime - 10);
      else if (e.key === "n") step(1);
      else if (e.key === "l" || e.key === "L") setLyrics(!lyrOn);
      else if (e.key === "s") $("#plShuffle").click();
      else if (e.key === "r") $("#plRepeat").click();
    });
    const savedVol = store("volume"); if (savedVol != null) vol.value = savedVol; setRange(vol);

    return {
      open(id) {
        queue = playable();
        const i = queue.findIndex((q) => q.id === id);
        if (i < 0) return;
        openModal("playerModal");
        idx = i; buildOrder();
        load(i);
        if (!raf && !potato()) draw();
      },
      stop() {
        audio.pause(); video.pause();
        audio.removeAttribute("src"); video.removeAttribute("src"); audio.load(); video.load();
        cancelAnimationFrame(raf); raf = null;
        cancelAnimationFrame(lyrRaf); lyrRaf = null; lyrReq++;
        if (ms) { ms.metadata = null; ms.playbackState = "none"; }
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

  // ------------------------------------------------- zwei-faktor-login
  function set2faPill(on) { const p = $("#menu2fa"); p.textContent = on ? "an" : "aus"; p.classList.toggle("on", !!on); }
  // Passwort verdeckt abfragen (Promise: Passwort oder null bei Abbruch)
  let confirmResolve = null;
  function askPassword(text) {
    if (confirmResolve) confirmResolve(null);
    $("#confirmText").textContent = text;
    $("#confirmPw").value = "";
    openModal("confirmModal");
    setTimeout(() => $("#confirmPw").focus(), 120);
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  $("#confirmForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const r = confirmResolve; confirmResolve = null;
    closeModal($("#confirmModal"));
    if (r) r($("#confirmPw").value);
    $("#confirmPw").value = "";
  });
  new MutationObserver(() => {
    if (!$("#confirmModal").classList.contains("open") && confirmResolve) { const r = confirmResolve; confirmResolve = null; r(null); }
  }).observe($("#confirmModal"), { attributes: true, attributeFilter: ["class"] });
  function renderSecurity(st) {
    $("#totpPill").textContent = st.totp ? "aktiv" : "aus"; $("#totpPill").classList.toggle("on", st.totp);
    $("#totpStart").hidden = st.totp; $("#totpOff").hidden = !st.totp;
    if (st.totp) $("#totpSetup").hidden = true;
    $("#pkPill").textContent = String(st.passkeys.length); $("#pkPill").classList.toggle("on", st.passkeys.length > 0);
    $("#pkList").replaceChildren(...st.passkeys.map((pk, i) => {
      const row = el("div", "pk"); row.style.animationDelay = `${i * 50}ms`;
      const info = el("div"); info.style.flex = "1"; info.style.minWidth = "0";
      info.append(el("b", "", "🔑 " + pk.name), el("small", "", ` · angelegt ${fmtDate(pk.created)} · zuletzt benutzt ${fmtDate(pk.last_used)}`));
      const del = el("button", "btn ghost small", "Entfernen"); del.type = "button";
      del.addEventListener("click", async () => {
        const pw = await askPassword(`Passkey „${pk.name}“ entfernen?`); if (pw === null) return;
        try { renderSecurity(await api("auth/passkey/delete", { method: "POST", body: { id: pk.id, password: pw } })); toast("Passkey entfernt", "success"); }
        catch (err) { toast(err.message, "error"); }
      });
      row.append(info, del); return row;
    }));
    const on = st.totp || st.passkeys.length > 0;
    $("#secRecovery").hidden = !on;
    $("#recPill").textContent = `${st.recovery_left} übrig`;
    $("#recPill").classList.toggle("on", st.recovery_left > 2);
    set2faPill(on);
    if (st.recovery_codes) showRecovery(st.recovery_codes);
  }
  function showRecovery(codes) {
    $("#recCodes").hidden = false;
    $("#recGrid").replaceChildren(...codes.map((c) => el("span", "", c)));
    $("#recCodes").scrollIntoView({ behavior: motion.reduced ? "auto" : "smooth", block: "center" });
    $("#recCodes").dataset.codes = codes.join("\n");
  }
  async function openSecurity() {
    openModal("secModal");
    $("#recCodes").hidden = true; $("#totpSetup").hidden = true;
    $("#pkInsecure").hidden = window.ScobePasskey.secure();
    $("#pkAdd").disabled = !window.ScobePasskey.available();
    try { renderSecurity(await api("auth/2fa")); } catch (err) { toast(err.message, "error"); }
    loadDevices();
  }

  // ---------------------------------------------------- angemeldete geräte
  const ago = (t) => {
    const s = Math.max(0, now() - t);
    if (s < 120) return "gerade aktiv";
    if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
    if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
    return `vor ${Math.round(s / 86400)} Tagen`;
  };
  const devIcon = (d) => d.browser.startsWith("ScobeTube-App") ? "📲" : d.kind === "phone" ? "📱" : d.kind === "tablet" ? "📟" : "💻";
  function deviceRow(d, onRevoke) {
    const row = el("div", "dev" + (d.current ? " current" : ""));
    const info = el("div", "dev-info");
    const name = el("b", "", `${d.browser} auf ${d.system}`);
    if (d.current) name.append(el("span", "pill on", "Dieses Gerät"));
    else if (now() - d.last_seen < 600) { const o = el("span", "online"); o.title = "gerade aktiv"; name.append(o); }
    info.append(name, el("small", "", `${ago(d.last_seen)} · IP ${d.ip || "?"} · angemeldet seit ${fmtDate(d.created)}`));
    row.append(el("span", "dev-ico", devIcon(d)), info);
    if (!d.current && onRevoke) {
      const b = el("button", "btn ghost small", "Abmelden"); b.type = "button";
      b.addEventListener("click", () => onRevoke(d, b));
      row.append(b);
    }
    return row;
  }
  function renderDevices(list) {
    $("#devPill").textContent = String(list.length);
    $("#devOthers").disabled = list.length < 2;
    $("#devList").replaceChildren(...list.map((d, i) => {
      const r = deviceRow(d, async (dev, btn) => {
        btn.classList.add("busy");
        try { renderDevices((await api("auth/sessions/revoke", { method: "POST", body: { id: dev.id } })).sessions); toast("Gerät abgemeldet", "success"); }
        catch (err) { toast(err.message, "error"); btn.classList.remove("busy"); }
      });
      r.style.animationDelay = `${i * 40}ms`;
      return r;
    }));
  }
  async function loadDevices() {
    try { renderDevices((await api("auth/sessions")).sessions); } catch (err) { $("#devList").textContent = err.message; }
  }
  $("#devOthers").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Wirklich alle anderen?"; setTimeout(() => { b.classList.remove("confirm"); b.textContent = "Alle anderen abmelden"; }, 3500); return; }
    b.classList.remove("confirm"); b.textContent = "Alle anderen abmelden";
    try { renderDevices((await api("auth/sessions/revoke", { method: "POST", body: { others: true } })).sessions); toast("Alle anderen Geräte abgemeldet", "success"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#menuSecurity").addEventListener("click", openSecurity);
  $("#totpStart").addEventListener("click", async () => {
    try {
      const d = await api("auth/2fa/totp/setup", { method: "POST" });
      $("#totpQr").src = d.qr; $("#totpSecret").textContent = d.secret;
      $("#totpSetup").hidden = false; $("#totpMsg").textContent = ""; $("#totpCode").value = "";
      setTimeout(() => $("#totpCode").focus(), 200);
    } catch (err) { toast(err.message, "error"); }
  });
  const enableTotp = async () => {
    const btn = $("#totpEnable"); btn.classList.add("busy"); $("#totpMsg").textContent = "";
    try {
      const st = await api("auth/2fa/totp/enable", { method: "POST", body: { code: $("#totpCode").value } });
      renderSecurity(st); toast("Authenticator-App aktiviert 🎉", "success");
      const r = $("#secTotp").getBoundingClientRect(); fx(r.left + r.width / 2, r.top + 30, 40);
    } catch (err) { $("#totpMsg").textContent = err.message; restart($("#totpCode"), "pop"); }
    finally { btn.classList.remove("busy"); }
  };
  $("#totpEnable").addEventListener("click", enableTotp);
  $("#totpCode").addEventListener("input", (e) => { const v = e.target.value.replace(/\D/g, ""); e.target.value = v; if (v.length === 6) enableTotp(); });
  $("#totpOff").addEventListener("click", async () => {
    const pw = await askPassword("Authenticator-App deaktivieren?"); if (pw === null) return;
    try { renderSecurity(await api("auth/2fa/totp/disable", { method: "POST", body: { password: pw } })); toast("Authenticator-App deaktiviert"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#pkAdd").addEventListener("click", async () => {
    const name = prompt("Name für diesen Passkey (z. B. „Pixel 9“ oder „Laptop“):", /Android/i.test(navigator.userAgent) ? "Android-Handy" : /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone" : "Dieser Computer");
    if (name === null) return;
    const btn = $("#pkAdd"); btn.classList.add("busy");
    try {
      const opts = await api("auth/passkey/register/options", { method: "POST" });
      const credential = await window.ScobePasskey.create(opts);
      renderSecurity(await api("auth/passkey/register", { method: "POST", body: { credential, name } }));
      toast("Passkey gespeichert 🔑", "success");
      const r = $("#secPasskey").getBoundingClientRect(); fx(r.left + r.width / 2, r.top + 30, 40);
    } catch (err) { toast(err.message, "error", 6000); }
    finally { btn.classList.remove("busy"); }
  });
  $("#recNew").addEventListener("click", async () => {
    const pw = await askPassword("Neue Wiederherstellungscodes erzeugen? Die alten werden ungültig."); if (pw === null) return;
    try { renderSecurity(await api("auth/2fa/recovery", { method: "POST", body: { password: pw } })); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#recCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#recCodes").dataset.codes || ""); toast("Codes kopiert", "success"); }
    catch { toast("Kopieren nicht möglich – bitte abschreiben", "error"); }
  });
  $("#recSave").addEventListener("click", () => {
    if (window.ScobeAndroid) {
      const txt = `ScobeTube – Wiederherstellungscodes für ${state.me.username}\n${location.origin}\n\n${$("#recCodes").dataset.codes}\n\nJeder Code funktioniert nur einmal.\n`;
      window.ScobeAndroid.saveFile(btoa(unescape(encodeURIComponent(txt))), "scobetube-wiederherstellungscodes.txt", "text/plain");
      return;
    }
    const blob = new Blob([`ScobeTube – Wiederherstellungscodes für ${state.me.username}\n${location.origin}\n\n${$("#recCodes").dataset.codes}\n\nJeder Code funktioniert nur einmal.\n`], { type: "text/plain" });
    const a = el("a"); a.href = URL.createObjectURL(blob); a.download = "scobetube-wiederherstellungscodes.txt"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ------------------------------------------- mit benutzern teilen
  let shareId = null;
  async function openShareUsers(id) {
    const it = state.items.get(id); if (!it) return;
    shareId = id;
    $("#shareItemName").textContent = it.title;
    $("#shareMsg").textContent = ""; $("#shareFilter").value = "";
    $("#shareInsecure").hidden = isHttps();
    $("#shareSave").disabled = !isHttps();
    openModal("shareUsers");
    try {
      const { users } = await api("share-targets");
      const sel = new Set((it.shared_with || []).map((n) => n.toLowerCase()));
      $("#shareList").replaceChildren(...(users.length ? users.map((name) => {
        const l = el("label", "perm"); l.dataset.name = name.toLowerCase();
        const cb = el("input"); cb.type = "checkbox"; cb.value = name; cb.checked = sel.has(name.toLowerCase()); cb.disabled = !isHttps();
        const box = el("span", "box-t"); box.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
        l.append(cb, box, el("span", "", name)); return l;
      }) : [el("p", "em-hint", "Es gibt noch keine anderen Benutzer.")]));
    } catch (err) { $("#shareMsg").textContent = err.message; }
  }
  $("#shareFilter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$("#shareList .perm").forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); });
  });
  $("#shareSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.classList.add("busy");
    const names = $$("#shareList input:checked").map((c) => c.value);
    try {
      const upd = await api(`items/${shareId}/share`, { method: "POST", body: { users: names } });
      upsert(upd); closeModal($("#shareUsers"));
      toast(names.length ? `Geteilt mit ${names.join(", ")}` : "Nicht mehr geteilt", "success");
    } catch (err) { $("#shareMsg").textContent = err.message; }
    finally { btn.classList.remove("busy"); }
  });

  // ---------------------------------------- vom handy geteilter link
  function openShareSheet(url, title) {
    const audioOnly = /open\.spotify\.com\/|soundcloud\.com\/|tidal\.com\//i.test(url);
    $("#sheetName").textContent = title || "Geteilter Link";
    $("#sheetUrl").textContent = url;
    $("#sheetVideo").hidden = audioOnly;
    openModal("shareSheet");
    const go = async (kind, btn) => {
      btn.classList.add("busy");
      try {
        const res = await api("add", { method: "POST", body: { urls: url, kind, format: kind === "video" ? "mp4" : "mp3", quality: "best", thumbnail: true } });
        closeModal($("#shareSheet"));
        toast(res.added.length > 1 ? `${res.added.length} Links in der Queue` : "Ab in die Queue!", "success");
        fx(innerWidth / 2, innerHeight / 2, 50);
        urlEl.value = ""; autosize(); updateMode();
      } catch (err) { toast(err.message, "error", 5000); }
      finally { btn.classList.remove("busy"); }
    };
    $("#sheetVideo").onclick = (e) => go("video", e.currentTarget);
    $("#sheetAudio").onclick = (e) => go("audio", e.currentTarget);
    $("#sheetCustom").onclick = () => { closeModal($("#shareSheet")); urlEl.value = url; autosize(); updateMode(); urlEl.focus(); };
  }

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => { /* egal */ });
  }

  $("#copyTemplate").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#shareTemplate").textContent); toast("Adresse kopiert", "success"); }
    catch { toast("Kopieren nicht möglich – bitte abschreiben", "error"); }
  });

  // ------------------------------------------------------- android-app
  const inApp = !!window.ScobeAndroid || /ScobeTubeApp\//.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  async function loadAppInfo() {
    let a = null;
    try { a = await fetch("api/app/version").then((r) => r.json()); } catch { /* egal */ }
    const ok = !!(a && a.available);
    const ver = ok ? "v" + a.version_name : "";
    // Download-Knöpfe nur im Browser zeigen – in der App selbst nicht
    $("#menuApp").hidden = inApp || !ok; $("#menuAppVer").textContent = ver;
    $("#footApp").hidden = inApp || !ok;
    $("#phoneAppDl").hidden = inApp || !ok;
    let dismissed = false; try { dismissed = localStorage.getItem("st2:appBanner") === (a && a.version_name); } catch { /* egal */ }
    $("#appBanner").hidden = inApp || !ok || !isAndroid || dismissed;
    $("#appBannerVer").textContent = ver;
    if (can("admin")) {
      $("#secApp").hidden = false;
      $("#appVerPill").textContent = ok ? ver : "keine";
      $("#appVerPill").classList.toggle("on", ok);
      $("#appInfo").textContent = ok
        ? `Version ${a.version_name} · ${fmtBytes(a.size)} · ${a.source || "?"} · ${fmtDate(a.updated)}`
        : "Noch keine App-Version bereitgestellt.";
    }
  }
  $("#appBannerX").addEventListener("click", () => {
    $("#appBanner").hidden = true;
    try { localStorage.setItem("st2:appBanner", ($("#appBannerVer").textContent || "").slice(1)); } catch { /* egal */ }
  });
  $("#appBannerDl").addEventListener("click", () => toast("Download startet – danach die Datei öffnen und „Installieren“ tippen", "info", 6000));
  if (inApp) {
    $("#menuAppUpdate").hidden = false; $("#menuServer").hidden = false;
    $("#menuAppUpdate").addEventListener("click", () => { $("#userMenu").hidden = true; window.ScobeAndroid && window.ScobeAndroid.checkUpdate(); });
    $("#menuServer").addEventListener("click", () => { $("#userMenu").hidden = true; window.ScobeAndroid && window.ScobeAndroid.changeServer(); });
  }
  $("#apkFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    $("#apkFileLabel").textContent = f ? `${f.name} (${fmtBytes(f.size)})` : "APK auswählen";
    $("#apkUpload").disabled = !f;
  });
  $("#apkUpload").addEventListener("click", async (e) => {
    const f = $("#apkFile").files[0]; if (!f) return;
    const btn = e.currentTarget; btn.classList.add("busy");
    const fd = new FormData(); fd.append("apk", f); fd.append("notes", $("#apkNotes").value);
    try {
      const r = await api("app/upload", { method: "POST", body: fd });
      toast(`App-Version ${r.version_name} ist online – alle Apps zeigen jetzt das Update an 🎉`, "success", 6000);
      const rr = btn.getBoundingClientRect(); fx(rr.left + rr.width / 2, rr.top, 50);
      $("#apkFile").value = ""; $("#apkFileLabel").textContent = "APK auswählen"; $("#apkNotes").value = ""; btn.disabled = true;
      loadAppInfo();
    } catch (err) { toast(err.message, "error", 7000); }
    finally { btn.classList.remove("busy"); }
  });
  $("#apkPull").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.classList.add("busy");
    try { const r = await api("app/pull", { method: "POST" }); toast(r.message, r.updated ? "success" : "info", 6000); loadAppInfo(); }
    catch (err) { toast(err.message, "error", 7000); }
    finally { btn.classList.remove("busy"); }
  });

  // ------------------------------------------------------- 🥔 potato
  function renderPotato() {
    const on = potato();
    $("#potatoPill").textContent = on ? "an" : "aus";
    $("#potatoPill").classList.toggle("on", on);
  }
  $("#menuPotato").addEventListener("click", () => {
    const on = window.ScobePotato.toggle();
    renderPotato();
    $("#potatoSuggest").replaceChildren();
    toast(on ? "🥔 Potato-Modus an – Animationen & Effekte aus" : "✨ Potato-Modus aus – volle Show", "success");
  });
  window.addEventListener("potato", renderPotato);
  renderPotato();

  // Beim ersten Besuch kurz messen, wie flüssig die Seite läuft – bei Ruckeln den Modus vorschlagen
  function maybeSuggestPotato() {
    if (potato() || window.ScobePotato.decided()) return;
    let frames = 0; const start = performance.now();
    const count = () => {
      frames++;
      if (performance.now() - start < 2500) { requestAnimationFrame(count); return; }
      const fps = frames / ((performance.now() - start) / 1000);
      const weak = fps < 28 || (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
      if (!weak || document.hidden) return;
      const box = el("div", "potato-suggest");
      const p = el("p"); p.append(el("b", "", "Ruckelt die Seite?"), `Dein Gerät schafft gerade ca. ${Math.round(fps)} Bilder/s. Der Potato-Modus schaltet Animationen & Effekte ab.`);
      const yes = el("button", "btn accent small", "🥔 Einschalten"); yes.type = "button";
      const no = el("button", "btn ghost small", "Nein danke"); no.type = "button";
      yes.addEventListener("click", () => { window.ScobePotato.set(true); box.remove(); renderPotato(); toast("🥔 Potato-Modus an", "success"); });
      no.addEventListener("click", () => { window.ScobePotato.set(false); box.remove(); renderPotato(); });
      box.append(el("span", "big", "🥔"), p, yes, no);
      $("#potatoSuggest").replaceChildren(box);
    };
    setTimeout(() => requestAnimationFrame(count), 3000);   // erst messen, wenn die Startanimationen vorbei sind
  }

  window.ScobeToast = toast;
  window.ScobeFx = fx;

  // --------------------------------------------------------------- start

  // =========================================================== speicher-kontingent
  function renderQuota(q) {
    const box = $("#quotaBox");
    if (!q || q.limit == null) { box.hidden = true; return; }
    box.hidden = false;
    const pct = Math.min(100, q.used / q.limit * 100);
    $("#quotaText").textContent = `${fmtBytes(q.used) || "0 B"} / ${fmtBytes(q.limit)}`;
    $("#quotaFill").style.width = pct + "%";
    box.classList.toggle("warn", pct >= 80); box.classList.toggle("full", !!q.full);
    $("#quotaAsk").textContent = q.pending ? `⏳ Anfrage über ${q.pending.gb} GB offen` : "Mehr Speicher anfordern";
    state.quota = q;
  }
  $("#quotaAsk").addEventListener("click", async () => {
    let q = state.quota;
    try { q = await api("quota"); } catch { /* egal */ }
    const pct = Math.min(100, Math.round(q.used / q.limit * 100));
    $("#quotaRing").style.setProperty("--p", pct);
    $("#quotaPct").textContent = pct + "%";
    $("#quotaBig").textContent = `${fmtBytes(q.used) || "0 B"} von ${fmtBytes(q.limit)} belegt`;
    $("#quotaSub").textContent = q.custom ? "Dein Kontingent wurde vom Admin festgelegt." : `Standard-Kontingent für alle: ${q.default_gb} GB`;
    const pend = $("#quotaPending");
    pend.hidden = !q.pending; $("#quotaForm").hidden = !!q.pending;
    if (q.pending) {
      pend.replaceChildren(el("span", "", `⏳ Deine Anfrage über ${q.pending.gb} GB vom ${fmtDate(q.pending.created)} wartet auf einen Admin. `));
      const c = el("button", "btn ghost small", "Zurückziehen"); c.type = "button";
      c.addEventListener("click", async () => { try { await api("quota/request/cancel", { method: "POST" }); toast("Anfrage zurückgezogen"); closeModal($("#quotaModal")); renderQuota(await api("quota")); } catch (err) { toast(err.message, "error"); } });
      pend.append(c);
    }
    const cur = q.limit / 1024 ** 3;
    $$("#quotaChips .chip").forEach((c) => { c.hidden = Number(c.dataset.gb) <= cur; });
    const first = $$("#quotaChips .chip").find((c) => !c.hidden);
    $$("#quotaChips .chip").forEach((c) => c.classList.toggle("active", c === first));
    openModal("quotaModal");
  });
  $("#quotaChips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; $$("#quotaChips .chip").forEach((x) => x.classList.toggle("active", x === c)); });
  $("#quotaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = $("#quotaChips .chip.active"); if (!c) return toast("Bitte eine Größe wählen", "error");
    const b = $("#quotaSend"); b.classList.add("busy");
    try {
      await api("quota/request", { method: "POST", body: { gb: Number(c.dataset.gb), reason: $("#quotaReason").value } });
      toast("Anfrage gesendet – die Admins bekommen eine Nachricht", "success");
      closeModal($("#quotaModal")); $("#quotaReason").value = "";
      renderQuota(await api("quota"));
    } catch (err) { toast(err.message, "error"); }
    b.classList.remove("busy");
  });

  async function refreshReqPill() {
    if (!can("admin")) return;
    try {
      const { requests } = await api("quota/requests");
      const n = requests.filter((r) => r.status === "pending").length;
      $("#reqPill").hidden = !n; $("#reqPill").textContent = String(n);
      $("#userBtn").classList.toggle("has-badge", n > 0);
    } catch { /* egal */ }
  }
  async function loadQuotaRequests() {
    const box = $("#quotaRequests");
    try {
      const { requests, default_gb } = await api("quota/requests");
      state.quotaDefault = default_gb;
      const open = requests.filter((r) => r.status === "pending");
      box.hidden = !open.length;
      $("#reqPill").hidden = !open.length; $("#reqPill").textContent = String(open.length);
      $("#userBtn").classList.toggle("has-badge", open.length > 0);
      box.replaceChildren(el("h3", "sec-sub", `💾 Speicher-Anfragen (${open.length})`), ...open.map((r, i) => {
        const row = el("div", "req"); row.style.setProperty("--i", i);
        const info = el("div", "req-info");
        info.append(el("b", "", `${r.user} möchte ${r.gb} GB`),
          el("small", "", `belegt ${fmtBytes(r.used) || "0 B"} von ${r.limit ? fmtBytes(r.limit) : "∞"} · ${fmtDate(r.created)}`));
        if (r.reason) info.append(el("p", "", `„${r.reason}“`));
        const gb = el("input", "input"); gb.type = "number"; gb.min = "1"; gb.value = r.gb; gb.title = "Genehmigte Größe in GB";
        const yes = el("button", "btn accent small", "Genehmigen"); yes.type = "button";
        const no = el("button", "btn ghost small", "Ablehnen"); no.type = "button";
        const decide = async (approve, btn) => {
          btn.classList.add("busy");
          try { await api(`quota/requests/${r.id}`, { method: "POST", body: { approve, gb: Number(gb.value) } }); toast(approve ? `${r.user} hat jetzt ${gb.value} GB` : "Anfrage abgelehnt", "success"); loadUsers(); }
          catch (err) { toast(err.message, "error"); btn.classList.remove("busy"); }
        };
        yes.addEventListener("click", () => decide(true, yes)); no.addEventListener("click", () => decide(false, no));
        const acts = el("div", "req-acts"); acts.append(gb, el("span", "label", "GB"), yes, no);
        row.append(info, acts);
        return row;
      }));
    } catch { box.hidden = true; }
  }

  // =========================================================== verlauf
  const hist = { q: "", kind: "", offset: 0, timer: null };
  const srcIcon = (src) => ({ youtube: "▶", soundcloud: "☁", spotify: "●", tidal: "◆" }[src] || "↓");
  function histRow(e, i) {
    const row = el("div", "hist"); row.style.setProperty("--i", i % 20);
    const img = el("div", "hist-img");
    if (e.thumbnail) { const im = el("img"); im.src = e.thumbnail; im.alt = ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer"; img.append(im); }
    else img.textContent = e.kind === "audio" ? "♫" : "▶";
    const info = el("div", "hist-info");
    info.append(el("b", "", e.title || e.url),
      el("small", "", `${srcIcon(e.source)} ${[e.artist || e.uploader, (e.format || "").toUpperCase(), e.filesize ? fmtBytes(e.filesize) : "", fmtDate(e.ts)].filter(Boolean).join(" · ")}`));
    const acts = el("div", "hist-acts");
    const open = el("a", "icon-btn small", "↗"); open.href = e.url; open.target = "_blank"; open.rel = "noopener noreferrer"; open.title = "Original öffnen";
    const again = el("button", "icon-btn small", "⟳"); again.type = "button"; again.title = "Erneut laden"; again.hidden = !can("download");
    again.addEventListener("click", async () => {
      again.classList.add("spin");
      try { await api(`history/${e.id}/again`, { method: "POST" }); toast("Wird erneut geladen", "success"); }
      catch (err) { toast(err.message, "error"); }
      again.classList.remove("spin");
    });
    const del = el("button", "icon-btn small", "✕"); del.type = "button"; del.title = "Aus dem Verlauf löschen";
    del.addEventListener("click", async () => {
      try { await api(`history/${e.id}`, { method: "DELETE" }); row.classList.add("gone"); setTimeout(() => row.remove(), 300); }
      catch (err) { toast(err.message, "error"); }
    });
    acts.append(open, again, del);
    row.append(img, info, acts);
    return row;
  }
  async function loadHistory(more) {
    if (!more) hist.offset = 0;
    try {
      const d = await api(`history?${new URLSearchParams({ q: hist.q, kind: hist.kind, offset: hist.offset })}`);
      const rows = d.entries.map((e, i) => histRow(e, i));
      if (more) $("#histList").append(...rows);
      else $("#histList").replaceChildren(...(rows.length ? rows : [el("p", "empty-note", hist.q ? "Nichts gefunden." : d.enabled ? "Noch nichts im Verlauf." : "Der Verlauf ist ausgeschaltet.")]));
      hist.offset += d.entries.length;
      $("#histMore").hidden = !d.more;
      $("#histEnabled").checked = d.enabled;
      $("#histCount").textContent = `${d.total} Eintr${d.total === 1 ? "ag" : "äge"}`;
    } catch (err) { toast(err.message, "error"); }
  }
  $("#menuHistory").addEventListener("click", () => { openModal("historyModal"); loadHistory(); });
  $("#histMore").addEventListener("click", () => loadHistory(true));
  $("#histSearch").addEventListener("input", () => { clearTimeout(hist.timer); hist.timer = setTimeout(() => { hist.q = $("#histSearch").value.trim(); loadHistory(); }, 250); });
  $("#histKind").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    $$("#histKind .chip").forEach((x) => x.classList.toggle("active", x === c)); hist.kind = c.dataset.v; loadHistory();
  });
  $("#histEnabled").addEventListener("change", async () => {
    try { await api("history/settings", { method: "POST", body: { enabled: $("#histEnabled").checked } }); toast($("#histEnabled").checked ? "Verlauf wird aufgezeichnet" : "Verlauf ausgeschaltet – es wird nichts mehr gespeichert"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#histClear").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.firstElementChild.textContent = "Wirklich alles löschen?"; setTimeout(() => { b.classList.remove("confirm"); b.firstElementChild.textContent = "Verlauf löschen"; }, 3500); return; }
    b.classList.remove("confirm"); b.firstElementChild.textContent = "Verlauf löschen";
    try { const r = await api("history/clear", { method: "POST" }); toast(`${r.removed} Einträge gelöscht`, "success"); loadHistory(); }
    catch (err) { toast(err.message, "error"); }
  });

  // =========================================================== aktivitätsprotokoll
  const aud = { cat: "", user: "", q: "", before: "", timer: null, init: false };
  const CAT_ICON = { login: "🔓", login_failed: "⛔", download: "⬇", file: "🗂", security: "🛡", admin: "⚙", quota: "💾" };
  function auditRow(e) {
    const row = el("div", "aud cat-" + e.cat);
    const when = new Date(e.ts * 1000);
    row.append(el("span", "aud-ico", CAT_ICON[e.cat] || "•"),
      el("span", "aud-time mono", when.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })));
    const main = el("div", "aud-main");
    const head = el("b", "", e.action);
    if (e.target) head.append(el("span", "pill", "→ " + e.target));
    main.append(head);
    const meta = [e.user ? "👤 " + e.user : "anonym", e.ip ? "IP " + e.ip : "", e.detail || ""].filter(Boolean).join(" · ");
    main.append(el("small", "", meta));
    row.append(main);
    return row;
  }
  async function loadAudit(more) {
    if (!more) aud.before = "";
    try {
      const d = await api(`audit?${new URLSearchParams({ cat: aud.cat, user: aud.user, q: aud.q, before: aud.before })}`);
      if (!aud.init) {
        aud.init = true;
        $("#auditCats").replaceChildren(...[["", "Alle"], ...Object.entries(d.categories)].map(([k, v]) => {
          const c = el("button", "chip" + (k === "" ? " active" : ""), (CAT_ICON[k] ? CAT_ICON[k] + " " : "") + v); c.type = "button"; c.dataset.v = k; return c;
        }));
        $("#auditDays").replaceChildren(...d.choices.map((n) => { const o = el("option", "", `${n} Tage`); o.value = n; return o; }));
      }
      $("#auditDays").value = d.days;
      const rows = d.entries.map(auditRow);
      if (more) $("#auditList").append(...rows);
      else $("#auditList").replaceChildren(...(rows.length ? rows : [el("p", "empty-note", "Keine Einträge.")]));
      if (d.entries.length) aud.before = d.entries[d.entries.length - 1].id;
      $("#auditMore").hidden = !d.more;
      $("#auditCount").textContent = `${d.total} Einträge gespeichert`;
    } catch (err) { toast(err.message, "error"); }
  }
  $("#menuAudit").addEventListener("click", async () => {
    openModal("auditModal");
    try {
      const { users: list } = await api("users");
      const sel = $("#auditUser"), cur = sel.value;
      sel.replaceChildren(el("option", "", "Alle Benutzer"), ...list.map((u) => { const o = el("option", "", u.username); o.value = u.username; return o; }));
      sel.firstElementChild.value = ""; sel.value = cur;
    } catch { /* egal */ }
    loadAudit();
  });
  $("#auditCats").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    $$("#auditCats .chip").forEach((x) => x.classList.toggle("active", x === c)); aud.cat = c.dataset.v; loadAudit();
  });
  $("#auditUser").addEventListener("change", () => { aud.user = $("#auditUser").value; loadAudit(); });
  $("#auditSearch").addEventListener("input", () => { clearTimeout(aud.timer); aud.timer = setTimeout(() => { aud.q = $("#auditSearch").value.trim(); loadAudit(); }, 250); });
  $("#auditMore").addEventListener("click", () => loadAudit(true));
  $("#auditDays").addEventListener("change", async () => {
    try { const r = await api("audit/settings", { method: "POST", body: { days: Number($("#auditDays").value) } }); toast(`Einträge werden ${r.days} Tage aufbewahrt`, "success"); loadAudit(); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#auditClear").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.firstElementChild.textContent = "Wirklich leeren?"; setTimeout(() => { b.classList.remove("confirm"); b.firstElementChild.textContent = "Protokoll leeren"; }, 3500); return; }
    b.classList.remove("confirm"); b.firstElementChild.textContent = "Protokoll leeren";
    try { await api("audit/clear", { method: "POST" }); toast("Protokoll geleert", "success"); loadAudit(); }
    catch (err) { toast(err.message, "error"); }
  });

  // =========================================================== song erkennen
  const rec = { stream: null, recorder: null, chunks: [], timer: null, actx: null, raf: null, busy: false };
  const REC_SECONDS = 10;
  function recStatus(t) { $("#recStatus").textContent = t; }
  function recStopStream() {
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    rec.stream = null; cancelAnimationFrame(rec.raf);
    if (rec.actx) { rec.actx.close().catch(() => {}); rec.actx = null; }
    clearTimeout(rec.timer);
    $("#recMic").classList.remove("recording"); $("#recMic").style.removeProperty("--lvl");
  }
  async function recSend(blob, name) {
    rec.busy = true;
    $("#recMic").classList.add("thinking"); recStatus("Erkenne …");
    const fd = new FormData(); fd.append("file", blob, name);
    try { showRecResult(await api("recognize", { method: "POST", body: fd })); }
    catch (err) { recStatus(err.message); toast(err.message, "error", 6000); }
    $("#recMic").classList.remove("thinking"); rec.busy = false;
  }
  async function recStart() {
    if (rec.busy) return;
    if (rec.recorder && rec.recorder.state === "recording") { rec.recorder.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { recStatus(isHttps() ? "Dein Browser kann nicht aufnehmen – wähle eine Datei." : "Mikrofon geht nur über HTTPS – wähle eine Datei."); return; }
    $("#recResult").hidden = true;
    try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch { recStatus("Kein Zugriff aufs Mikrofon – bitte erlauben oder eine Datei wählen."); return; }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
    rec.chunks = [];
    rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
    rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    rec.recorder.onstop = () => {
      const type = rec.recorder.mimeType || mime || "audio/webm";
      recStopStream();
      recSend(new Blob(rec.chunks, { type }), "aufnahme." + (type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"));
    };
    rec.recorder.start(500);
    const mic = $("#recMic"); mic.classList.add("recording"); mic.style.setProperty("--dur", REC_SECONDS + "s");
    const t0 = Date.now();
    try {   // Pegel für die Animation
      rec.actx = new (window.AudioContext || window.webkitAudioContext)();
      const an = rec.actx.createAnalyser(); an.fftSize = 256;
      rec.actx.createMediaStreamSource(rec.stream).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        mic.style.setProperty("--lvl", Math.min(1, peak / 64).toFixed(2));
        recStatus(`Hört zu … ${Math.max(0, REC_SECONDS - Math.floor((Date.now() - t0) / 1000))} s`);
        rec.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { recStatus("Hört zu …"); }
    rec.timer = setTimeout(() => { if (rec.recorder?.state === "recording") rec.recorder.stop(); }, REC_SECONDS * 1000);
  }
  function showRecResult(r) {
    const box = $("#recResult"); box.hidden = false;
    if (!r.found) {
      recStatus("Nicht erkannt – näher an die Musik und nochmal?");
      box.replaceChildren(el("p", "empty-note", "🤷 Diesen Song kenne ich leider nicht."));
      return;
    }
    recStatus("Erkannt!");
    if (!motion.reduced) { const m = $("#recMic").getBoundingClientRect(); fx(m.left + m.width / 2, m.top + m.height / 2, 40); }
    const card = el("div", "rec-hit");
    const cover = el("div", "rec-cover");
    if (r.cover) { const im = el("img"); im.src = r.cover; im.alt = ""; cover.append(im); } else cover.textContent = "♫";
    const info = el("div", "rec-info");
    info.append(el("span", "label", "Das ist"), el("h3", "", r.title || "?"), el("p", "", r.artist || ""),
      el("small", "", [r.album, r.release ? r.release.slice(0, 4) : ""].filter(Boolean).join(" · ")));
    const acts = el("div", "rec-acts");
    const dl = el("button", "btn accent", "♫ Als Audio laden"); dl.type = "button";
    dl.addEventListener("click", async () => {
      dl.classList.add("busy");
      try {
        if (r.spotify_url) {
          await api("add", { method: "POST", body: { url: r.spotify_url, kind: "audio", format: state.format["spotify:audio"] || "mp3", quality: "best" } });
          toast(`„${r.title}“ wird geladen`, "success"); closeModal($("#recModal"));
        } else {
          closeModal($("#recModal"));
          setSource("all"); setKind("audio");
          urlEl.value = `${r.artist} - ${r.title}`; autosize(); updateMode(); urlEl.focus();
          toast("Kein Spotify-Treffer – suche auf YouTube. Mit „Suchen“ starten.");
        }
      } catch (err) { toast(err.message, "error"); }
      dl.classList.remove("busy");
    });
    acts.append(dl);
    for (const [href, label] of [[r.spotify_url, "Spotify ↗"], [r.apple_url, "Apple Music ↗"], [r.song_link, "Alle Dienste ↗"]]) {
      if (!href) continue;
      const a = el("a", "btn ghost small", label); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; acts.append(a);
    }
    card.append(cover, info);
    box.replaceChildren(card, acts);
  }
  $("#recOpen").addEventListener("click", () => {
    $("#recResult").hidden = true; recStatus("Tippen und das Handy 10 Sekunden zur Musik halten"); openModal("recModal");
  });
  $("#recMic").addEventListener("click", recStart);
  $("#recFile").addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 60 * 1024 * 1024) return toast("Datei ist zu groß (max. 60 MB)", "error");
    $("#recResult").hidden = true; recSend(f, f.name);
  });
  $("#recModal").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") && rec.recorder?.state === "recording") { rec.recorder.onstop = null; rec.recorder.stop(); recStopStream(); }
  });

  // =========================================================== admin: erkennung & spotify-app
  async function loadAdminExtras() {
    try {
      const r = await api("recognize/settings");
      $("#secRecognize").hidden = false;
      $("#recEnabled").checked = r.enabled;
      $("#recPill").textContent = r.enabled ? (r.has_token ? "an · eigener Schlüssel" : "an · ohne Schlüssel") : "aus";
      $("#recPill").classList.toggle("on", r.enabled);
      $("#recToken").value = ""; $("#recToken").placeholder = r.has_token ? "•••• gespeichert" : "leer = kostenloses Tageslimit";
      $("#recClear").hidden = !r.has_token;
    } catch { /* keine Rechte */ }
    try {
      const sp = await api("spotify-account");
      $("#secSpotifyApp").hidden = false;
      $("#spRedirect").textContent = sp.redirect_uri;
      $("#spClientId").value = sp.client_id || "";
      $("#spAppPill").textContent = sp.configured ? "eingerichtet" : "aus"; $("#spAppPill").classList.toggle("on", sp.configured);
    } catch { /* egal */ }
  }
  $("#recSave").addEventListener("click", async () => {
    try { await api("recognize/settings", { method: "PUT", body: { enabled: $("#recEnabled").checked, token: $("#recToken").value || undefined } }); toast("Song-Erkennung gespeichert", "success"); loadAdminExtras(); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#recClear").addEventListener("click", async () => {
    try { await api("recognize/settings", { method: "PUT", body: { clear_token: true } }); toast("Schlüssel entfernt"); loadAdminExtras(); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#spAppSave").addEventListener("click", async () => {
    try { const r = await api("spotify-account/app", { method: "PUT", body: { client_id: $("#spClientId").value.trim() } }); toast(r.configured ? "Spotify eingerichtet – jetzt kann sich jeder über den grünen Knopf verbinden" : "Spotify-App entfernt", "success"); loadAdminExtras(); }
    catch (err) { toast(err.message, "error"); }
  });
  $("#spCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#spRedirect").textContent); toast("Redirect URI kopiert", "success"); } catch { toast("Kopieren nicht möglich – bitte markieren", "error"); }
  });

  // =========================================================== mein spotify
  const sp = { range: store("spRange") || "short_term", data: null };
  const SP_RANGES = { short_term: "4 Wochen", medium_term: "6 Monate", long_term: "Alle Zeit" };
  const SP_LOGO = '<svg viewBox="0 0 24 24" class="sp-logo"><circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7.5-.6 10.5 1M7.6 12.6c2.9-.8 6.1-.4 8.6 1M8.3 15.5c2.3-.6 4.6-.3 6.6.8"/></svg>';
  function spotifyFab() {
    if ($("#spotifyFab")) return;
    const b = el("button", "spotify-fab"); b.id = "spotifyFab"; b.type = "button";
    b.title = "Mein Spotify – Verlauf, Statistiken & Hörprofil"; b.setAttribute("aria-label", b.title);
    b.innerHTML = SP_LOGO + '<span class="sp-eq"><i></i><i></i><i></i></span>';
    b.addEventListener("click", openSpotify);
    document.body.append(b);
  }
  const spImg = (src, cls = "") => { const d = el("div", "sp-img " + cls); if (src) { const i = el("img"); i.src = src; i.alt = ""; i.loading = "lazy"; d.append(i); } else d.textContent = "♫"; return d; };
  const spDl = (url, title) => {
    const b = el("button", "icon-btn small sp-dl", "↓"); b.type = "button"; b.title = "Als Audio laden"; b.hidden = !can("download") || !url;
    b.addEventListener("click", async (e) => {
      e.stopPropagation(); b.classList.add("spin");
      try { await api("add", { method: "POST", body: { url, kind: "audio", format: state.format["spotify:audio"] || "mp3", quality: "best" } }); toast(`„${title}“ wird geladen`, "success"); b.textContent = "✓"; }
      catch (err) { toast(err.message, "error"); }
      b.classList.remove("spin");
    });
    return b;
  };
  function spConnectView(status) {
    const wrap = el("div", "sp-connect");
    wrap.innerHTML = SP_LOGO;
    wrap.append(el("h3", "", "Verbinde dein Spotify"),
      el("p", "", "Sieh dir an, was du zuletzt gehört hast, deine Top-Interpreten und -Songs und dein persönliches Hörprofil. Jeden Song kannst du mit einem Klick laden."));
    if (!status.configured) {
      wrap.append(el("p", "warn-box", can("admin") ? "Zuerst einmalig unter Einstellungen → „Spotify-Konten“ eine Spotify-App hinterlegen." : "Das hat der Admin noch nicht eingerichtet."));
      if (can("admin")) { const s = el("button", "btn ghost", "Zu den Einstellungen"); s.type = "button"; s.addEventListener("click", () => { closeModal($("#spModal")); openModal("settings"); loadInfo(); loadAdminExtras(); setTimeout(() => $("#secSpotifyApp").scrollIntoView({ behavior: "smooth" }), 300); }); wrap.append(s); }
      return wrap;
    }
    const go = el("button", "btn sp-btn", "Mit Spotify verbinden"); go.type = "button";
    go.addEventListener("click", async () => {
      go.classList.add("busy");
      try { location.href = (await api("spotify-account/connect", { method: "POST" })).url; }
      catch (err) { toast(err.message, "error"); go.classList.remove("busy"); }
    });
    wrap.append(go, el("small", "legal-small", "ScobeTube liest nur (Profil, Verlauf, Top-Listen). Trennen geht jederzeit – der Zugang wird dann sofort gelöscht."));
    return wrap;
  }
  function spBars(items, key, labelKey, unit) {
    const max = Math.max(1, ...items.map((x) => x[key]));
    const box = el("div", "sp-bars");
    items.forEach((x, i) => {
      const r = el("div", "sp-bar"); r.style.setProperty("--i", i);
      const f = el("i"); requestAnimationFrame(() => requestAnimationFrame(() => { f.style.width = (x[key] / max * 100) + "%"; }));
      const t = el("span", "track"); t.append(f);
      r.append(el("span", "name", x[labelKey]), t, el("span", "val mono", x[key] + unit));
      box.append(r);
    });
    return box;
  }
  function spClock(recent) {
    const hours = new Array(24).fill(0);
    for (const r of recent) if (r.played_at) hours[new Date(r.played_at).getHours()]++;
    const max = Math.max(1, ...hours);
    const box = el("div", "sp-clock");
    hours.forEach((n, h) => {
      const c = el("div", "col"); c.title = `${h}–${h + 1} Uhr: ${n} Songs`;
      const f = el("i"); f.style.setProperty("--h", (n / max * 100) + "%"); f.style.setProperty("--i", h);
      c.append(f, el("span", "", h % 6 === 0 ? String(h) : ""));
      box.append(c);
    });
    const peak = hours.indexOf(max);
    const label = peak < 5 ? "Nachteule 🦉" : peak < 11 ? "Frühaufsteher ☀" : peak < 17 ? "Tagsüber-Hörer 🎧" : "Abendmensch 🌙";
    return [box, max > 1 ? label : ""];
  }
  function spStat(value, label, sub) {
    const d = el("div", "sp-stat"); d.append(el("b", "", value), el("span", "", label)); if (sub) d.append(el("small", "", sub)); return d;
  }
  function renderSpotify(d, status) {
    const body = el("div", "sp-body");
    // Kopf
    const head = el("div", "sp-head");
    head.append(spImg(d.me.image, "round"));
    const who = el("div", "sp-who");
    who.append(el("span", "label", "Verbunden mit Spotify"), el("h3", "", d.me.name || "?"),
      el("small", "", [d.me.product === "premium" ? "Premium" : d.me.product ? "Free" : "", d.me.followers != null ? `${d.me.followers} Follower` : "", d.me.country].filter(Boolean).join(" · ")));
    const tabs = el("div", "chips sp-range");
    Object.entries(SP_RANGES).forEach(([k, v]) => {
      const c = el("button", "chip" + (k === sp.range ? " active" : ""), v); c.type = "button";
      c.addEventListener("click", () => { sp.range = k; store("spRange", k); loadSpotify(); });
      tabs.append(c);
    });
    const off = el("button", "btn ghost small", "Trennen"); off.type = "button";
    off.addEventListener("click", async () => {
      if (!off.classList.contains("confirm")) { off.classList.add("confirm"); off.textContent = "Wirklich trennen?"; setTimeout(() => { off.classList.remove("confirm"); off.textContent = "Trennen"; }, 3500); return; }
      try { await api("spotify-account/disconnect", { method: "POST" }); toast("Spotify getrennt – Zugang gelöscht", "success"); openSpotify(); } catch (err) { toast(err.message, "error"); }
    });
    head.append(who, off);
    body.append(head);
    // Läuft gerade
    if (d.now) {
      const now = el("div", "sp-now" + (d.now.playing ? " playing" : ""));
      now.append(spImg(d.now.image));
      const t = el("div", "sp-now-t");
      t.append(el("span", "label", d.now.playing ? "▶ Läuft gerade" : "⏸ Pausiert"), el("b", "", d.now.name), el("small", "", d.now.artists.join(", ")));
      now.append(t, spDl(d.now.url, d.now.name));
      body.append(now);
    }
    body.append(tabs);
    // Hörprofil
    const pr = d.profile;
    const prof = el("section", "sp-sec");
    prof.append(el("h4", "", "Dein Hörprofil"));
    const stats = el("div", "sp-stats");
    if (pr.mainstream != null) stats.append(spStat(pr.mainstream + "%", "Mainstream", pr.mainstream_label));
    if (pr.loyalty != null) stats.append(spStat(pr.loyalty + "%", "Treue", "deiner Top-Interpreten hörst du schon lange"));
    stats.append(spStat(String(pr.recent_minutes), "Minuten", "in den letzten 50 Songs"));
    stats.append(spStat(String(pr.recent_unique_artists), "Interpreten", "in den letzten 50 Songs"));
    if (pr.avg_length) stats.append(spStat(fmtTime(pr.avg_length), "Ø Songlänge"));
    if (pr.explicit_share != null) stats.append(spStat(pr.explicit_share + "%", "Explicit"));
    prof.append(stats);
    if (pr.on_repeat) prof.append(el("p", "sp-fun", `🔁 Auf Dauerschleife: „${pr.on_repeat.name}“ von ${pr.on_repeat.artists} – ${pr.on_repeat.plays}× in deinen letzten 50 Songs`));
    const grid = el("div", "sp-grid2");
    if (pr.genres.length) { const g = el("div"); g.append(el("span", "label", "Genres"), spBars(pr.genres, "share", "name", "%")); grid.append(g); }
    if (pr.decades.length) { const g = el("div"); g.append(el("span", "label", "Jahrzehnte deiner Top-Songs"), spBars(pr.decades, "count", "name", "")); grid.append(g); }
    const [clock, clockLabel] = spClock(d.recent);
    const cl = el("div"); cl.append(el("span", "label", "Wann du hörst" + (clockLabel ? " · " + clockLabel : "")), clock); grid.append(cl);
    prof.append(grid);
    body.append(prof);
    // Top-Interpreten
    const ta = el("section", "sp-sec");
    ta.append(el("h4", "", `Top-Interpreten · ${SP_RANGES[d.range]}`));
    const artists = el("div", "sp-artists");
    d.top_artists.forEach((a, i) => {
      const c = el("a", "sp-artist"); c.href = a.url || "#"; c.target = "_blank"; c.rel = "noopener noreferrer"; c.style.setProperty("--i", i);
      c.append(spImg(a.image, "round"), el("span", "rank mono", String(i + 1)), el("b", "", a.name), el("small", "", (a.genres || []).slice(0, 2).join(", ")));
      artists.append(c);
    });
    ta.append(artists.childElementCount ? artists : el("p", "empty-note", "Noch zu wenig gehört für diesen Zeitraum."));
    body.append(ta);
    // Top-Songs & Verlauf
    const trackList = (list, withTime) => {
      const box = el("div", "sp-tracks");
      list.forEach((t, i) => {
        const r = el("div", "sp-track"); r.style.setProperty("--i", i % 25);
        r.append(el("span", "rank mono", withTime ? "" : String(i + 1)), spImg(t.image));
        const inf = el("div", "sp-t-info"); inf.append(el("b", "", t.name), el("small", "", t.artists.join(", ") + (t.album ? " · " + t.album : "")));
        r.append(inf, el("span", "mono sp-t-meta", withTime && t.played_at ? ago(Date.parse(t.played_at) / 1000) : fmtTime(t.duration)), spDl(t.url, t.name));
        box.append(r);
      });
      return box;
    };
    const tt = el("section", "sp-sec"); tt.append(el("h4", "", `Top-Songs · ${SP_RANGES[d.range]}`), d.top_tracks.length ? trackList(d.top_tracks, false) : el("p", "empty-note", "Noch keine Daten."));
    const rp = el("section", "sp-sec"); rp.append(el("h4", "", "Zuletzt gehört"), d.recent.length ? trackList(d.recent, true) : el("p", "empty-note", "Noch nichts gehört."));
    body.append(tt, rp, el("p", "legal-small sp-foot", `Daten von Spotify · Stand ${new Date(d.fetched * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`));
    $("#spBody").replaceChildren(body);
  }
  async function loadSpotify(fresh) {
    const bodyEl = $("#spBody");
    bodyEl.classList.add("loading");
    if (!bodyEl.firstChild) bodyEl.replaceChildren(el("div", "sp-loading", "Lade deine Spotify-Daten …"));
    try { renderSpotify(await api(`spotify-account/overview?range=${sp.range}${fresh ? "&fresh=1" : ""}`)); }
    catch (err) {
      if (/Nicht mit Spotify verbunden/.test(err.message)) return openSpotify();
      bodyEl.replaceChildren(el("p", "warn-box", err.message));
    }
    bodyEl.classList.remove("loading");
  }
  async function openSpotify() {
    openModal("spModal");
    $("#spBody").replaceChildren(el("div", "sp-loading", "…"));
    let status;
    try { status = await api("spotify-account"); } catch (err) { $("#spBody").replaceChildren(el("p", "warn-box", err.message)); return; }
    if (!status.linked) { $("#spBody").replaceChildren(spConnectView(status)); return; }
    $("#spBody").replaceChildren();
    loadSpotify();
  }

  // =========================================================== start
  async function showMissedNotifications() {
    try {
      const d = await api("notifications");
      const fresh = d.notifications.filter((n) => !n.read && now() - n.ts < 3 * 86400);
      fresh.slice(-3).forEach((n, i) => setTimeout(() => toast(`${n.title}${n.body ? " – " + n.body : ""}`, n.kind === "security" ? "error" : "info", 10000), 900 + i * 700));
      if (fresh.length) await api("notifications/read", { method: "POST", body: { upto: d.latest } });
    } catch { /* egal */ }
  }

  function initExtras(me) {
    spotifyFab();
    showMissedNotifications();
    if (can("admin")) { refreshReqPill(); setInterval(refreshReqPill, 120000); }
    $("#settingsBtn").addEventListener("click", () => { if (can("admin")) loadAdminExtras(); });
    const qp = new URLSearchParams(location.search);
    const spState = qp.get("spotify");
    if (spState) {
      history.replaceState(null, "", location.pathname);
      if (spState === "connected") { toast("🎉 Spotify verbunden!", "success"); setTimeout(openSpotify, 300); }
      else if (spState === "denied") toast("Spotify-Verbindung abgebrochen");
      else toast("Spotify-Verbindung fehlgeschlagen" + (qp.get("msg") ? ": " + qp.get("msg") : ""), "error", 8000);
    }
    if (location.hash === "#quota" && can("admin")) { openModal("usersModal"); loadUsers(); history.replaceState(null, "", location.pathname); }
    if (location.hash === "#audit" && can("admin")) { $("#menuAudit").click(); history.replaceState(null, "", location.pathname); }
  }

  async function boot() {
    let me;
    try { me = await api("auth/me"); } catch { return; }
    state.me = me.user; state.permLabels = me.permissions;
    $("#userName").textContent = me.user.username;
    $("#userMenuName").textContent = me.user.username;
    $("#userAvatar").textContent = me.user.username.slice(0, 2).toUpperCase();
    $("#userRole").textContent = me.user.admin ? "Administrator" : "Benutzer";
    $("#menuUsers").hidden = !can("admin");
    $("#menuAudit").hidden = !can("admin");
    $("#recOpen").hidden = !can("download");
    renderQuota(me.user.quota);
    set2faPill(me.user.twofa);
    $("#deck").hidden = !can("download");
    $("#clearDone").hidden = !can("delete");
    $("#selectBtn").hidden = !can("files");
    $("#secStorage").hidden = !can("storage");
    $("#secUpdate").hidden = !can("settings");
    $("#secCookies").hidden = !can("settings");
    $("#secBookmarks").hidden = !can("download");
    $("#secPhone").hidden = !can("download");
    $("#phoneInsecure").hidden = isHttps(); $("#phoneHelp").hidden = !isHttps(); $("#copyTemplate").hidden = !isHttps();
    $("#shareTemplate").textContent = new URL("share?url=", location.href).href;
    $("#settingsBtn").hidden = !(can("storage") || can("settings") || can("download"));
    $("#footStorage").hidden = !can("storage");

    const qp = new URLSearchParams(location.search);
    if (qp.get("share") === "1") {
      const sharedUrl = qp.get("url"), sharedTitle = qp.get("title");
      history.replaceState(null, "", location.pathname);
      if (!isHttps()) setTimeout(() => toast("Teilen geht nur über die verschlüsselte HTTPS-Adresse", "error", 6000), 400);
      else if (!sharedUrl) setTimeout(() => toast("Im geteilten Inhalt war kein Link", "error"), 400);
      else if (!can("download")) setTimeout(() => toast("Dir fehlt das Recht „Downloads starten“", "error"), 400);
      else setTimeout(() => openShareSheet(sharedUrl, sharedTitle), 300);
    } else if (qp.get("url")) {
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
    if (can("settings")) { startSystem(); loadHealer(); setInterval(loadHealer, 60000); }
    loadAppInfo();
    maybeSuggestPotato();
    initExtras(me.user);
    if (can("storage")) { loadStorage(); setInterval(loadStorage, 60000); }
  }
  boot();
})();
