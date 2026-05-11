/**
 * Service Worker do LeadHouse PWA
 *
 * Estrategia:
 *  - App shell (HTML, CSS, JS, icones): cache-first com revalidacao em background
 *  - /api/*: NUNCA cacheia (dados sempre frescos)
 *  - Outros (fotos do Supabase, etc): network-first com fallback pra cache
 *
 * Bump CACHE_VERSION quando o app shell mudar significativamente
 * (forcar o SW a re-cachear). Auto-update via skipWaiting + clients.claim.
 */
const CACHE_VERSION = 'lh-v4-2026-05-11-push-diag';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Arquivos do shell — minimos pra app abrir offline
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/favicon.svg',
  '/icon.svg',
  '/icon-maskable.svg',
  '/manifest.webmanifest',
];

// ──────────────── Install ────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

// ──────────────── Activate ────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ──────────────── Fetch ────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Soh intercepta GET. POST/PUT/DELETE vai direto pra rede.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API: sempre rede (dados frescos). Sem cache, sem fallback.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhook/')) {
    return;
  }

  // Mesma origem: shell + runtime cache
  if (url.origin === self.location.origin) {
    event.respondWith(handleSameOrigin(req));
    return;
  }

  // Recursos externos (Supabase fotos, fonts): cache-first com revalidacao
  event.respondWith(handleCrossOrigin(req));
});

async function handleSameOrigin(req) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(req.url);

  // HTML (documento) e manifest: network-FIRST. O usuario sempre ve a versao
  // mais nova; cache so e fallback offline. Evita "vi o app antigo na primeira
  // carga apos um deploy" — bug classico de PWA com stale-while-revalidate.
  const isDocument = req.mode === 'navigate'
    || req.destination === 'document'
    || url.pathname === '/'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.webmanifest');

  if (isDocument) {
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const cached = await cache.match(req);
      return cached || new Response('Offline', { status: 503 });
    }
  }

  // Outros assets (CSS, JS, SVG): stale-while-revalidate — rapido + atualiza bg
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || networkPromise || new Response('Offline', { status: 503 });
}

async function handleCrossOrigin(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    // Atualiza cache em background pra proxima visita
    fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ──────────────── Push (stub, ativado no PR6) ────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'LeadHouse', body: event.data?.text() || '' }; }
  const title = data.title || 'LeadHouse';
  const options = {
    body: data.body || 'Voce tem uma nova atualizacao',
    icon: '/icon.svg',
    badge: '/favicon.svg',
    data: data.data || { url: '/' },
    tag: data.tag || 'default',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Se app ja esta aberto, foca; senao, abre nova janela
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'navigate', url });
        return;
      }
      return self.clients.openWindow(url);
    })
  );
});
