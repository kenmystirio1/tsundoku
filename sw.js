/* App shell cache: the app opens instantly; data always comes live from Supabase. */
const V = "tsundoku-v1";
const SHELL = ["./", "index.html", "platform.js", "config.js", "vendor/supabase.js", "manifest.webmanifest", "icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.includes("/covers/")) { // covers: cache-first
    e.respondWith(caches.open(V + "-covers").then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { if (n.ok) c.put(e.request, n.clone()); return n; }))));
    return;
  }
  e.respondWith(fetch(e.request).then(n => { if (n.ok) { const copy = n.clone(); caches.open(V).then(c => c.put(e.request, copy)); } return n; }).catch(() => caches.match(e.request)));
});
