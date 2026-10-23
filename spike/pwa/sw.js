// Minimal service worker: offline shell + push display. Throwaway spike.
self.addEventListener("install", (e) => {
	self.skipWaiting();
	e.waitUntil(caches.open("v1").then((c) => c.addAll(["./", "app.js"])));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) =>
	e.respondWith(fetch(e.request).catch(() => caches.match(e.request))),
);
self.addEventListener("push", (e) => {
	const d = e.data ? e.data.json() : { title: "durable" };
	e.waitUntil(
		self.registration.showNotification(d.title ?? "durable", {
			body: d.body ?? "",
		}),
	);
});
