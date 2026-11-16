/* ScobeTube – Service-Worker.
   Nötig, damit ScobeTube als App installiert werden und im „Teilen“-Menü erscheinen kann.
   Speichert absichtlich nichts zwischen (immer aktuelle, private Daten); zeigt nur offline einen Hinweis. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
    "<body style='background:#0b0b0c;color:#f3f0e7;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center'>" +
    "<div><h1 style='font-size:28px'>Offline</h1><p>ScobeTube ist gerade nicht erreichbar.<br>Prüfe deine Verbindung und versuche es erneut.</p></div>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
