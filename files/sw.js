/**
 * Smart Automation CRM — Service Worker
 * Versão: 1.0.0
 * Estratégias: Cache First para estáticos, Network First para dados, Background Sync para pedidos
 */

const CACHE_VERSION = 'smart-crm-v1';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const DATA_CACHE    = `${CACHE_VERSION}-data`;
const SYNC_TAG      = 'smart-crm-sync-pedidos';

// ── ATIVOS ESTÁTICOS (Cache First — nunca mudam) ─────────────────────────────
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline-db.js',
  '/notifications.js',
  '/manifest.json',
  // Chart.js via CDN — cacheia na primeira visita
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  // Fontes Google (cache offline)
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap',
];

// ── ROTAS DA API (Network First — dados sempre frescos quando online) ─────────
const API_ROUTES = [
  /apps\.script\.google\.com/,
  /script\.google\.com/,
];

// ── ROTAS PROTHEUS (Network First com fallback IndexedDB) ─────────────────────
const PROTHEUS_ROUTES = [
  /\/api\/protheus\//,
  /protheus\.empresa\.com\.br/,
];

// ═══════════════════════════════════════════════════════════════════════════════
// INSTALL — cacheia todos os ativos estáticos
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log('[SW] Instalando versão:', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[SW] Cacheando ativos estáticos...');
        // Cacheia individualmente para não falhar tudo se um asset falhar
        return Promise.allSettled(
          STATIC_ASSETS.map(asset =>
            cache.add(asset).catch(err =>
              console.warn('[SW] Falha ao cachear:', asset, err.message)
            )
          )
        );
      })
      .then(() => {
        console.log('[SW] Instalação concluída.');
        return self.skipWaiting(); // Ativa imediatamente sem aguardar recarregamento
      })
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVATE — remove caches antigas
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('[SW] Ativando...');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('smart-crm-') && key !== STATIC_CACHE && key !== DATA_CACHE)
          .map(key => {
            console.log('[SW] Removendo cache antiga:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim()) // Assume controle de todas as abas imediatamente
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// FETCH — intercepta todas as requisições
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requisições não-GET para estratégia diferente
  if (request.method !== 'GET') {
    event.respondWith(handleNonGet(request));
    return;
  }

  // Ignora extensões do Chrome e outros protocolos
  if (!request.url.startsWith('http')) return;

  // ── Estratégia para APIs do Google Apps Script ──────────────────────────────
  if (API_ROUTES.some(r => r.test(request.url))) {
    event.respondWith(networkFirstWithOfflineFallback(request, 'apps-script'));
    return;
  }

  // ── Estratégia para API do Protheus ─────────────────────────────────────────
  if (PROTHEUS_ROUTES.some(r => r.test(request.url))) {
    event.respondWith(networkFirstWithOfflineFallback(request, 'protheus'));
    return;
  }

  // ── Estratégia para API da Anthropic ────────────────────────────────────────
  if (url.hostname === 'api.anthropic.com') {
    // Nunca cacheia respostas da IA — sempre tenta rede, sem fallback
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({
          content: [{ type: 'text', text: 'Assistente indisponível no modo offline. Reconecte à internet para usar o Copilot.' }]
        }), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // ── Estratégia para fontes e CDNs ───────────────────────────────────────────
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirstWithNetworkFallback(request));
    return;
  }

  // ── Estratégia para ativos estáticos locais ─────────────────────────────────
  event.respondWith(cacheFirstWithNetworkFallback(request));
});

// ─── Cache First (estáticos que raramente mudam) ──────────────────────────────
async function cacheFirstWithNetworkFallback(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Retorna página offline customizada se disponível
    const offlinePage = await caches.match('/offline.html');
    return offlinePage || new Response('CRM offline — reconecte à internet.', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// ─── Network First (dados frescos com fallback para cache) ────────────────────
async function networkFirstWithOfflineFallback(request, cacheKey) {
  const cacheName = `${DATA_CACHE}-${cacheKey}`;

  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    console.warn('[SW] Rede indisponível, usando cache para:', request.url);
    const cached = await caches.match(request, { cacheName });
    if (cached) return cached;

    // Retorna resposta de offline estruturada para o JS tratar
    return new Response(JSON.stringify({
      offline: true,
      message: 'Dados carregados do cache local. Reconecte para sincronizar.',
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' }
    });
  }
}

// ─── POST/PUT offline — enfileira para sync posterior ─────────────────────────
async function handleNonGet(request) {
  try {
    // Tenta enviar normalmente primeiro
    return await fetch(request.clone(), { signal: AbortSignal.timeout(10000) });
  } catch {
    console.warn('[SW] POST falhou offline, enfileirando para Background Sync');

    // Clona o body para persistir
    const body = await request.text();
    const payload = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      timestamp: Date.now(),
      uuid: crypto.randomUUID()
    };

    // Notifica o cliente para salvar no IndexedDB
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({
      type: 'QUEUE_OFFLINE_REQUEST',
      payload
    }));

    // Registra Background Sync se suportado
    if ('serviceWorker' in navigator && 'sync' in self.registration) {
      await self.registration.sync.register(SYNC_TAG);
    }

    return new Response(JSON.stringify({
      offline: true,
      queued: true,
      uuid: payload.uuid,
      message: 'Pedido salvo offline. Será sincronizado ao reconectar.'
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'X-Queued': 'true' }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKGROUND SYNC — dispara quando a conexão volta
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] Background Sync iniciado — processando fila offline...');
    event.waitUntil(processOfflineQueue());
  }
});

async function processOfflineQueue() {
  // Notifica o cliente principal para processar a fila do IndexedDB
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length > 0) {
    clients[0].postMessage({ type: 'PROCESS_OFFLINE_QUEUE' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS — recebe notificações do servidor
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('push', event => {
  if (!event.data) return;

  const data = event.data.json();
  console.log('[SW] Push recebido:', data);

  const options = {
    body: data.body || 'Nova notificação do CRM',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'smart-crm-notif',
    renotify: true,
    requireInteraction: data.urgente || false,
    data: {
      url: data.url || '/',
      leadId: data.leadId,
      tipo: data.tipo
    },
    actions: [
      { action: 'abrir', title: 'Abrir no CRM', icon: '/icons/icon-72.png' },
      { action: 'dispensar', title: 'Dispensar' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Smart Automation CRM', options)
  );
});

// Clique na notificação
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dispensar') return;

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existingClient = clients.find(c => c.url.includes(targetUrl));
        if (existingClient) {
          existingClient.focus();
          existingClient.postMessage({
            type: 'NOTIFICATION_CLICK',
            leadId: event.notification.data?.leadId,
            tipo: event.notification.data?.tipo
          });
        } else {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// MENSAGENS DO CLIENTE → SERVICE WORKER
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CLEAR_CACHE':
      caches.keys().then(keys =>
        Promise.all(keys.map(k => caches.delete(k)))
      ).then(() => event.ports[0]?.postMessage({ success: true }));
      break;

    case 'CACHE_VERSION':
      event.ports[0]?.postMessage({ version: CACHE_VERSION });
      break;

    default:
      console.log('[SW] Mensagem não reconhecida:', type);
  }
});
