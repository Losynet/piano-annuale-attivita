// Service worker di «I miei impegni 2026/27»
// Serve impegni.ics come un vero file del sito, così Safari su iPhone
// lo passa al Calendario con «Aggiungi tutti».
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.endsWith("/impegni.ics")) return;
  e.respondWith((async () => {
    const c = await caches.open("impegni-ics");
    const r = await c.match("/__impegni_ics__");
    if (!r) return new Response("Torna alla pagina e scegli le classi.", {status: 404, headers: {"Content-Type": "text/plain; charset=utf-8"}});
    return new Response(await r.text(), {headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="impegni-scuola-2026-27.ics"',
      "Cache-Control": "no-store"}});
  })());
});
