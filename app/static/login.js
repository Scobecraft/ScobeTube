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
        const res = await post("auth/login", { username, password, remember: $("#remember").checked });
        if (res.twofa) { showStep2(res); btn.classList.remove("loading"); btn.disabled = false; return; }
      }
      success();
    } catch (err) {
      fail(err.message);
      btn.classList.remove("loading"); btn.disabled = false;
    }
  });

  function success() {
      $("#submitText").textContent = "Los geht's";
      card.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-30px) rotate(-3deg) scale(.96)", opacity: 0 }],
        { duration: 450, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
      setTimeout(() => location.replace(nextTarget()), 380);
  }

  // ------------------------------------------------- zweiter Schritt
  let ticket = null, recoveryMode = false;
  function showStep2(res) {
    ticket = res.ticket;
    form.hidden = true;
    $("#step2").hidden = false;
    $("#heading").textContent = "Zweiter Schritt";
    $("#lead").textContent = "Bestätige, dass du es wirklich bist.";
    const pk = res.methods.passkey, totp = res.methods.totp;
    const pkOk = pk && window.ScobePasskey.available();
    $("#pkLogin").hidden = !pkOk;
    $("#pkInsecure").hidden = !(pk && !window.ScobePasskey.secure());
    $("#orLine").hidden = !(pkOk && (totp || res.methods.recovery));
    setRecovery(!totp);
    $("#useRecovery").hidden = !totp || !res.methods.recovery;
    card.animate([{ transform: "rotate(2deg) translateX(30px)", opacity: .3 }, { transform: "none", opacity: 1 }], { duration: 450, easing: "cubic-bezier(.22,1,.36,1)" });
    if (pkOk) { $("#pkLogin").focus(); passkeyLogin(); } else $("#code").focus();
  }
  function setRecovery(on) {
    recoveryMode = on;
    $("#codeLabel").textContent = on ? "Wiederherstellungscode" : "Code aus der Authenticator-App";
    $("#code").placeholder = on ? "ABCD-EFGH" : "123456";
    $("#code").inputMode = on ? "text" : "numeric";
    $("#code").value = "";
    $("#useRecovery").textContent = on ? "Code aus der App verwenden" : "Wiederherstellungscode verwenden";
  }
  $("#useRecovery").addEventListener("click", () => { setRecovery(!recoveryMode); $("#code").focus(); });
  $("#backBtn").addEventListener("click", () => location.reload());

  function fail2(text) {
    $("#msg2").textContent = text;
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    $("#code").select();
    if (/abgelaufen|erneut/.test(text)) setTimeout(() => location.reload(), 2500);
  }
  async function submitCode() {
    const code = $("#code").value.trim();
    if (!code) return;
    const b = $("#codeSubmit"); b.classList.add("loading"); b.disabled = true; $("#msg2").textContent = "";
    try { await post("auth/login/2fa", { ticket, code }); success(); }
    catch (err) { fail2(err.message); }
    finally { b.classList.remove("loading"); b.disabled = false; }
  }
  $("#codeForm").addEventListener("submit", (e) => { e.preventDefault(); submitCode(); });
  $("#code").addEventListener("input", (e) => {
    if (recoveryMode) return;
    const v = e.target.value.replace(/\D/g, ""); e.target.value = v;
    if (v.length === 6) submitCode();
  });

  async function passkeyLogin() {
    const b = $("#pkLogin"); b.classList.add("busy"); $("#msg2").textContent = "";
    try {
      const opts = await post("auth/login/passkey/options", { ticket });
      const credential = await window.ScobePasskey.get(opts);
      await post("auth/login/passkey", { ticket, credential });
      success();
    } catch (err) { fail2(err.message); }
    finally { b.classList.remove("busy"); }
  }
  $("#pkLogin").addEventListener("click", passkeyLogin);

  // Android-App anbieten (nur im Browser auf Android, nicht in der App selbst)
  if (/Android/i.test(navigator.userAgent) && !/ScobeTubeApp\//.test(navigator.userAgent)) {
    fetch("api/app/version").then((r) => r.json()).then((a) => {
      if (a.available) { $("#loginApp").hidden = false; $("#loginAppVer").textContent = "v" + a.version_name; }
    }).catch(() => { /* egal */ });
  }

  // Hinweistext (vom Admin bearbeitbar) laden
  fetch("api/legal", { credentials: "same-origin" }).then((r) => r.json()).then((d) => {
    const sec = (d.sections || []).find((x) => x.key === "login");
    if (sec && window.ScobeMD) $("#loginLegal").replaceChildren(window.ScobeMD.render(sec.text));
  }).catch(() => { /* Standardtext bleibt */ });

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
