/* ScobeTube – Rechtliches: Betreiberangaben und Löschfrist einsetzen */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  fetch("api/legal", { credentials: "same-origin" }).then((r) => r.json()).then((d) => {
    if (d.retention_hours) {
      $("#retentionText").textContent = `automatisch nach ${String(d.retention_hours).replace(".", ",")} Stunden`;
    }
    if (d.operator_name || d.operator_contact) {
      const box = $("#operator");
      box.replaceChildren();
      const p = document.createElement("p");
      if (d.operator_name) { const b = document.createElement("b"); b.textContent = d.operator_name; p.append(b); }
      if (d.operator_contact) {
        if (d.operator_name) p.append(document.createElement("br"));
        const c = d.operator_contact;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) {
          const a = document.createElement("a"); a.href = "mailto:" + c; a.textContent = c; p.append("Kontakt: ", a);
        } else p.append("Kontakt: " + c);
      }
      box.append(p);
    }
    if (d.updated) $("#legalDate").textContent = d.updated;
  }).catch(() => { /* Standardtext bleibt stehen */ });
})();
