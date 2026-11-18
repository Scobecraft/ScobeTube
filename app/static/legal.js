/* ScobeTube – Rechtliches: Anzeige und Bearbeitung durch Admins */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let data = null, editing = false, dirty = false;

  function toast(msg, type = "info") {
    const t = el("div", `toast ${type}`);
    t.append(el("span", "ti", type === "success" ? "✓" : type === "error" ? "!" : "i"), el("span", "", msg));
    $("#toasts").append(t);
    setTimeout(() => { t.classList.add("out"); t.addEventListener("animationend", () => t.remove(), { once: true }); setTimeout(() => t.remove(), 600); }, 3800);
  }
  async function send(path, method, body) {
    const res = await fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-ScobeTube": "1" }, body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await res.json(); } catch { /* leer */ }
    if (!res.ok) throw new Error((d && d.detail) || `Fehler ${res.status}`);
    return d;
  }

  // Platzhalter → Markdown
  function vars(name, contact) {
    const h = data.retention_hours;
    let betreiber;
    if (name || contact) {
      const parts = [];
      if (name) parts.push(`**${name}**`);
      if (contact) parts.push(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? `Kontakt: [${contact}](mailto:${contact})` : `Kontakt: ${contact}`);
      betreiber = parts.join("\n");
    } else {
      betreiber = "Diese private Installation wird von der Person betrieben, die dir deinen Zugang gegeben hat. Fragen, Auskunfts- und Löschwünsche richtest du direkt an sie.";
    }
    return {
      loeschfrist: h ? `automatisch nach ${String(h).replace(".", ",")} Stunden` : "nicht automatisch, sondern nur von Hand",
      betreiber,
    };
  }

  const visible = () => data.sections.filter((s) => s.key !== "login");

  function renderView() {
    const v = vars(data.operator_name, data.operator_contact);
    $("#legalNav").replaceChildren(...visible().map((s) => { const a = el("a", "", s.title.replace(/^\P{L}+/u, "")); a.href = "#" + s.key; return a; }));
    $("#sections").replaceChildren(...visible().map((s, i) => {
      const sec = el("section", "legal-sec box"); sec.id = s.key; sec.style.animationDelay = `${i * 60}ms`;
      sec.append(el("h2", "", s.title));
      const body = el("div", "md"); body.append(window.ScobeMD.render(s.text, v)); sec.append(body);
      return sec;
    }));
    const when = data.updated ? new Date(data.updated * 1000).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" }) : null;
    $("#legalFoot").textContent = (when ? `Stand: ${when}` : "") + (data.updated_by && data.can_edit ? ` · zuletzt geändert von ${data.updated_by}` : "") +
      (when ? " · " : "") + "ScobeTube ist freie, selbst gehostete Software. Diese Hinweise sind eine Vorlage und keine Rechtsberatung.";
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }

  // ------------------------------------------------------------ editor
  function renderEditor() {
    const opName = data.operator_name || "", opContact = data.operator_contact || "";
    $("#legalNav").replaceChildren(...data.sections.map((s) => { const a = el("a", "", s.key === "login" ? "Anmeldeseite" : s.title.replace(/^\P{L}+/u, "")); a.href = "#" + s.key; return a; }));
    $("#sections").replaceChildren(...data.sections.map((s) => {
      const sec = el("section", "legal-sec box editing"); sec.id = s.key; sec.dataset.key = s.key;
      const head = el("div", "ed-head");
      const title = el("input", "input ed-title"); title.value = s.title; title.maxLength = 120; title.setAttribute("aria-label", "Überschrift");
      const reset = el("button", "linkish", "Standard wiederherstellen"); reset.type = "button";
      reset.addEventListener("click", () => { title.value = s.default_title; ta.value = s.default_text; update(); markDirty(); });
      head.append(title, reset);
      if (s.key === "login") head.append(el("span", "pill", "nur auf der Anmeldeseite"));
      sec.append(head);

      if (s.key === "betreiber") {
        const row = el("div", "form-row ed-op");
        const f1 = el("label", "field"); f1.append(el("span", "label", "Name (optional)")); const n = el("input", "input"); n.id = "opName"; n.value = opName; n.maxLength = 200; f1.append(n);
        const f2 = el("label", "field"); f2.append(el("span", "label", "Kontakt / E-Mail (optional)")); const c = el("input", "input"); c.id = "opContact"; c.value = opContact; c.maxLength = 200; f2.append(c);
        row.append(f1, f2); sec.append(row);
        [n, c].forEach((x) => x.addEventListener("input", () => { updateAll(); markDirty(); }));
      }

      const grid = el("div", "ed-grid");
      const ta = el("textarea", "input ed-text mono"); ta.value = s.text; ta.spellcheck = true; ta.rows = Math.min(28, Math.max(6, s.text.split("\n").length + 2));
      const prev = el("div", "ed-preview md");
      const update = () => { prev.replaceChildren(window.ScobeMD.render(ta.value, vars($("#opName")?.value || "", $("#opContact")?.value || ""))); };
      sec._update = update;
      ta.addEventListener("input", () => { update(); markDirty(); });
      title.addEventListener("input", markDirty);
      const left = el("div"); left.append(el("span", "label", "Text"), ta);
      const right = el("div"); right.append(el("span", "label", "Vorschau"), prev);
      grid.append(left, right); sec.append(grid);
      update();
      return sec;
    }));
  }
  const updateAll = () => document.querySelectorAll(".legal-sec.editing").forEach((s) => s._update && s._update());
  function markDirty() { dirty = true; $("#dirtyInfo").textContent = "Ungespeicherte Änderungen"; $("#saveBar").classList.add("dirty"); }

  function setEditing(on) {
    editing = on; dirty = false;
    document.body.classList.toggle("legal-editing", on);
    $("#editHelp").hidden = !on; $("#saveBar").hidden = !on; $("#editBtn").hidden = on || !data.can_edit;
    $("#dirtyInfo").textContent = "Keine Änderungen"; $("#saveBar").classList.remove("dirty");
    if (on) renderEditor(); else renderView();
  }

  $("#editBtn").addEventListener("click", () => setEditing(true));
  $("#cancelEdit").addEventListener("click", () => {
    if (dirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
    setEditing(false);
  });
  $("#saveEdit").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.classList.add("busy");
    const sections = {};
    document.querySelectorAll(".legal-sec.editing").forEach((sec) => {
      sections[sec.dataset.key] = { title: $(".ed-title", sec).value, text: $(".ed-text", sec).value };
    });
    try {
      data = await send("api/legal", "PUT", { sections, operator_name: $("#opName").value, operator_contact: $("#opContact").value });
      setEditing(false); toast("Gespeichert – die neuen Texte sind sofort aktiv", "success");
    } catch (err) { toast(err.message, "error"); }
    finally { btn.classList.remove("busy"); }
  });
  $("#resetAll").addEventListener("click", async () => {
    if (!confirm("Alle Texte und Betreiberangaben auf den Standard zurücksetzen?")) return;
    try { data = await send("api/legal/reset", "POST"); setEditing(false); toast("Standardtexte wiederhergestellt", "success"); }
    catch (err) { toast(err.message, "error"); }
  });
  addEventListener("beforeunload", (e) => { if (editing && dirty) { e.preventDefault(); e.returnValue = ""; } });

  fetch("api/legal", { credentials: "same-origin" }).then((r) => r.json()).then((d) => {
    data = d;
    $("#editBtn").hidden = !d.can_edit;
    renderView();
  }).catch(() => { $("#sections").textContent = "Die Texte konnten nicht geladen werden."; });
})();
