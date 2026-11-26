/* global self */
// Minimal PWA service worker for XeIO (/app) installability.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Network passthrough so auth, Supabase RPCs, and live lab state stay fresh.
});
