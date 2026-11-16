/* ScobeTube – Easter Eggs 🥚  (psst …) */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const toast = (msg, type = "info", ms) => {
    if (window.ScobeToast) return window.ScobeToast(msg, type, ms);
    const m = $("#msg"); if (m) { m.textContent = msg; m.style.color = "var(--accent)"; setTimeout(() => { m.textContent = ""; m.style.color = ""; }, ms || 3500); }
  };
  const once = (key) => { try { if (sessionStorage.getItem("egg:" + key)) return false; sessionStorage.setItem("egg:" + key, "1"); } catch { /* egal */ } return true; };

  // --------------------------------------------------- Konsolen-Gruß
  console.log("%c SCOBE//TUBE ", "background:#b9ff33;color:#0b0b0c;font:900 28px sans-serif;padding:6px 12px;border:3px solid #0b0b0c");
  console.log("%cNa, neugierig? 👀  Probier mal: ↑ ↑ ↓ ↓ ← → ← → B A", "font:600 13px monospace;color:#8f6bff");

  // ------------------------------------------- Party-Modus (Konami)
  let partyTimer = null;
  function party() {
    document.body.classList.add("egg-party");
    toast("🕹️ KONAMI! Party-Modus aktiviert – 30 Leben gutgeschrieben", "success", 5000);
    if (!reduce) {
      let n = 0;
      const burst = () => {
        if (window.ScobeFx) window.ScobeFx(Math.random() * innerWidth, Math.random() * innerHeight * .6, 50);
        if (++n < 12) setTimeout(burst, 250);
      };
      burst();
    }
    clearTimeout(partyTimer);
    partyTimer = setTimeout(() => document.body.classList.remove("egg-party"), 12000);
  }
  const konami = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let kpos = 0;
  addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea")) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    kpos = k === konami[kpos] ? kpos + 1 : (k === konami[0] ? 1 : 0);
    if (kpos === konami.length) { kpos = 0; party(); }
  });

  // ---------------------------------------- DJ-Scratch (Logo 7×)
  let clicks = 0, clickTimer = null, actx = null;
  function scratch() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const dur = 0.9, rate = actx.sampleRate, buf = actx.createBuffer(1, rate * dur, rate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / rate;
        const wob = Math.sin(t * Math.PI * 2 * 3.2);               // vor/zurück
        d[i] = (Math.random() * 2 - 1) * Math.abs(wob) * (1 - t / dur) * 0.6
             + Math.sin(2 * Math.PI * (180 + 260 * wob) * t) * 0.25 * Math.abs(wob);
      }
      const src = actx.createBufferSource(); src.buffer = buf;
      const f = actx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1200; f.Q.value = 0.8;
      const g = actx.createGain(); g.gain.value = 0.5;
      src.connect(f).connect(g).connect(actx.destination); src.start();
    } catch { /* kein Audio – egal */ }
  }
  const logo = $(".brand .mark");
  if (logo) {
    const brand = logo.closest(".brand");
    const onApp = !!document.querySelector("#deck");
    brand.addEventListener("click", (e) => {
      if (!onApp) return;            // Login-Seite: normaler Link
      e.preventDefault();            // Hauptseite: ein Klick = nach oben scrollen
      clicks++;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        if (clicks < 7) scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
        clicks = 0;
      }, 450);
      if (clicks >= 7) {
        clicks = 0; clearTimeout(clickTimer);
        logo.classList.remove("egg-scratch"); void logo.offsetWidth; logo.classList.add("egg-scratch");
        scratch();
        toast("🎧 Wikka-wikka! DJ Scobe in da house", "success");
      }
    });
  }

  // ------------------------------------------- Zauberwörter im Eingabefeld
  function matrix(ms = 6000) {
    if (reduce) { toast("🟩 Folge dem weißen Kaninchen …"); return; }
    const cv = document.createElement("canvas"); cv.className = "egg-matrix"; document.body.appendChild(cv);
    const ctx = cv.getContext("2d"), fs = 18;
    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize();
    const cols = Math.ceil(innerWidth / fs), drops = Array.from({ length: cols }, () => Math.random() * -50);
    const chars = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789SCOBETUBE";
    const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#b9ff33";
    let raf;
    const tick = () => {
      ctx.fillStyle = "rgba(11,11,12,.12)"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = `700 ${fs}px monospace`;
      drops.forEach((y, i) => {
        ctx.fillStyle = Math.random() < .05 ? "#f3f0e7" : accent;
        ctx.fillText(chars[(Math.random() * chars.length) | 0], i * fs, y * fs);
        drops[i] = y * fs > cv.height && Math.random() > .97 ? 0 : y + 1;
      });
      raf = requestAnimationFrame(tick);
    };
    tick();
    toast("🟩 Wach auf, Neo … die Matrix hat dich.", "info", 4000);
    setTimeout(() => { cv.classList.add("out"); setTimeout(() => { cancelAnimationFrame(raf); cv.remove(); }, 800); }, ms);
  }

  function gravity() {
    const letters = [...document.querySelectorAll(".mega .ch")];
    if (!letters.length) return;
    toast("🍎 Newton hätte das kommen sehen", "info");
    if (reduce) return;
    letters.forEach((l, i) => {
      const r = l.getBoundingClientRect();
      const fall = innerHeight - r.top + 200;
      const rot = (Math.random() - .5) * 120;
      l.animate([
        { transform: "none" },
        { transform: `translateY(${fall}px) rotate(${rot}deg)`, offset: .45, easing: "cubic-bezier(.55,0,1,.45)" },
        { transform: `translateY(${fall}px) rotate(${rot}deg)`, offset: .6 },
        { transform: "translateY(-30px) rotate(0)", offset: .9, easing: "cubic-bezier(.22,1,.36,1)" },
        { transform: "none" },
      ], { duration: 3200, delay: i * 70, fill: "none" });
    });
  }

  function rickroll() {
    const t = $("#goText");
    if (t) {
      const old = t.textContent; t.textContent = "Never gonna";
      setTimeout(() => { t.textContent = "give you up"; }, 900);
      setTimeout(() => { t.textContent = old; }, 2200);
    }
    toast("🎤 Never gonna let you down … (aber trotzdem: Link einfügen!)", "info", 4500);
    document.body.classList.add("egg-dance");
    setTimeout(() => document.body.classList.remove("egg-dance"), 4000);
  }

  function barrelRoll() {
    if (reduce) return;
    document.querySelector(".app").animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }],
      { duration: 1400, easing: "cubic-bezier(.65,0,.35,1)" });
    toast("✈️ Do a barrel roll!", "info");
  }

  function hello() {
    const name = (document.querySelector("#userName") || {}).textContent || "du";
    toast(`👋 Hallo ${name}! Schön, dass du da bist.`, "success");
    if (window.ScobeFx) window.ScobeFx(innerWidth / 2, innerHeight / 3, 60);
  }

  const WORDS = [
    [/^(konami|party|disco)$/, party],
    [/^(matrix|neo|rote pille|red pill)$/, () => matrix()],
    [/^(gravity|schwerkraft|newton)$/, gravity],
    [/^(rick ?roll|never gonna give you up)$/, rickroll],
    [/^(do a barrel roll|barrel roll|fassrolle)$/, barrelRoll],
    [/^(scobe|hallo|hello|hi)$/, hello],
    [/^(42|sinn des lebens)$/, () => toast("🌌 42. Die Antwort auf die ultimative Frage – jetzt brauchst du nur noch die Frage.", "info", 5000)],
    [/^sudo /, () => toast("🔒 Netter Versuch. Diese Instanz gehorcht nur dem Admin.", "error")],
  ];
  // wird von app.js vor einer Suche aufgerufen; true = verbraucht
  window.ScobeEggs = {
    word(text) {
      const t = (text || "").trim().toLowerCase();
      for (const [re, fn] of WORDS) if (re.test(t)) { fn(); return true; }
      return false;
    },
  };

  // ------------------------------------------- Aufkleber abziehen
  const sticker = $(".sticker");
  if (sticker) {
    sticker.title = "…";
    sticker.addEventListener("dblclick", () => {
      if (sticker.classList.contains("egg-peel")) return;
      sticker.classList.add("egg-peel");
      toast("🏷️ Hey! Der klebte da gut.", "info");
      setTimeout(() => sticker.classList.remove("egg-peel"), 4000);
    });
  }

  // ------------------------------------------- Nachteule
  const h = new Date().getHours();
  if (h >= 0 && h < 5 && once("owl")) setTimeout(() => toast("🦉 Noch wach? Die besten Playlists entstehen nachts.", "info", 5000), 2500);

  // ------------------------------------------- Login-Seite: Platte anschubsen
  const rings = $(".login-art");
  if (rings && $(".login-art .rings")) {
    let spins = 0;
    rings.addEventListener("click", () => {
      spins++;
      const r = $(".login-art .rings");
      r.style.animationDuration = Math.max(0.4, 14 / (spins + 1)) + "s";
      if (spins === 6) toast("💿 Vorsicht, die Nadel springt gleich raus!", "info");
      if (spins >= 9) { spins = 0; r.style.animationDuration = ""; toast("🛑 Okay okay – Platte gestoppt.", "info"); }
    });
  }
})();
