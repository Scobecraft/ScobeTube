/* ScobeTube – 🥔 Potato-Modus: schaltet Animationen & Effekte für schwache Geräte ab.
   Wird im <head> geladen, damit die Seite gar nicht erst mit Animationen startet.
   Die Einstellung gilt pro Gerät (localStorage). */
(function () {
  "use strict";
  var KEY = "st2:potato";
  var root = document.documentElement;
  var on = false;
  try { on = localStorage.getItem(KEY) === "1"; } catch (e) { /* privat – egal */ }
  if (on) root.classList.add("potato");

  window.ScobePotato = {
    on: function () { return root.classList.contains("potato"); },
    set: function (value) {
      root.classList.toggle("potato", !!value);
      try { localStorage.setItem(KEY, value ? "1" : "0"); } catch (e) { /* egal */ }
      window.dispatchEvent(new CustomEvent("potato", { detail: !!value }));
    },
    toggle: function () { this.set(!this.on()); return this.on(); },
    // Wurde schon einmal bewusst entschieden? (dann keinen Vorschlag mehr zeigen)
    decided: function () { try { return localStorage.getItem(KEY) !== null; } catch (e) { return true; } },
  };

  // 🥔 Schwebende Kartoffel unten rechts – ein Klick schaltet den Modus um
  function addButton() {
    if (document.getElementById("potatoFab")) return;
    var btn = document.createElement("button");
    btn.id = "potatoFab";
    btn.type = "button";
    btn.className = "potato-fab";
    btn.innerHTML = '<span class="pf-emoji" aria-hidden="true">🥔</span>';
    function sync() {
      var on = window.ScobePotato.on();
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "Potato-Modus ist AN – klicken für volle Animationen" : "Potato-Modus einschalten (Animationen & Effekte aus)";
      btn.setAttribute("aria-label", btn.title);
    }
    btn.addEventListener("click", function () {
      var on = window.ScobePotato.toggle();
      btn.classList.remove("bump"); void btn.offsetWidth; btn.classList.add("bump");
      if (window.ScobeToast) window.ScobeToast(on ? "🥔 Potato-Modus an – Animationen & Effekte aus" : "✨ Potato-Modus aus – volle Show", "success", 2500);
    });
    window.addEventListener("potato", sync);
    sync();
    document.body.appendChild(btn);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
  else addButton();
})();
