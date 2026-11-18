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
})();
