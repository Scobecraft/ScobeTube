/* ScobeTube – Anmeldung */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const form = $("#form"), card = $("#card"), msg = $("#msg");
  let setup = false;

  document.querySelectorAll("[data-split]").forEach((row, r) => {
    const text = row.textContent; row.textContent = "";
    [...text].forEach((c, i) => {
      const s = document.createElement("span"); s.className = "ch"; s.textContent = c;
      s.style.setProperty("--i", i + r * 5); row.appendChild(s);
    });
  });

  const nextTarget = () => {
    const n = new URLSearchParams(location.search).get("next");
    // nur Query-Parameter für die Startseite zulassen – keine offenen Weiterleitungen
    return n && /^[\w=&%.+-]*$/.test(n) ? "./?" + n : "./";
  };

  async function post(path, body) {
    const res = await fetch("api/" + path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-ScobeTube": "1" },
      body: JSON.stringify(body),
    });
    let data = null; try { data = await res.json(); } catch { /* leer */ }
    if (!res.ok) throw new Error((data && data.detail) || `Fehler ${res.status}`);
    return data;
  }

  const strength = (pw) => {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return pw ? Math.max(1, s) : 0;
  };

  function fail(text) {
    msg.textContent = text;
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    $("#password").select();
  }

  $("#eye").addEventListener("click", () => {
    const pw = $("#password"); pw.type = pw.type === "password" ? "text" : "password"; pw.focus();
  });
  const caps = (e) => { if (e.getModifierState) $("#caps").classList.toggle("show", e.getModifierState("CapsLock")); };
  ["keydown", "keyup"].forEach((t) => $("#password").addEventListener(t, caps));
  $("#password").addEventListener("input", (e) => { if (setup) $("#strength").dataset.s = strength(e.target.value); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";
    const username = $("#username").value.trim(), password = $("#password").value;
    if (!username || !password) return fail("Bitte Benutzername und Passwort eingeben");
    const btn = $("#submit"); btn.classList.add("loading"); btn.disabled = true;
    try {
      if (setup) {
        if (password.length < 8) throw new Error("Das Passwort braucht mindestens 8 Zeichen");
        if (password !== $("#password2").value) throw new Error("Die Passwörter stimmen nicht überein");
        await post("auth/setup", { username, password });
      } else {
        await post("auth/login", { username, password, remember: $("#remember").checked });
      }
      $("#submitText").textContent = "Los geht's";
      card.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-30px) rotate(-3deg) scale(.96)", opacity: 0 }],
        { duration: 450, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
      setTimeout(() => location.replace(nextTarget()), 380);
    } catch (err) {
      fail(err.message);
      btn.classList.remove("loading"); btn.disabled = false;
    }
  });

  fetch("api/auth/status", { credentials: "same-origin" }).then((r) => r.json()).then((s) => {
    if (s.user) { location.replace(nextTarget()); return; }
    if (s.setup) {
      setup = true;
      $("#heading").textContent = "Admin einrichten";
      $("#lead").textContent = "Erster Start! Lege jetzt dein Administrator-Konto an.";
      $("#setupExtra").hidden = false;
      $("#rememberWrap").hidden = true;
      $("#password").autocomplete = "new-password";
      $("#submitText").textContent = "Konto anlegen";
    }
    $("#username").focus();
  }).catch(() => { msg.textContent = "Server nicht erreichbar"; });
})();
