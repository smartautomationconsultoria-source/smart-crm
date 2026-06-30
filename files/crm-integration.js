/**
 * Smart Automation CRM — Script de Integração
 *
 * COMO USAR: Adicione ao final do <body> do CRM, APÓS os outros scripts.
 *
 * Ordem de carregamento no HTML:
 * 1. <link rel="manifest" href="manifest.json">
 * 2. <script src="offline-db.js"></script>
 * 3. <script src="notifications.js"></script>
 * 4. <script src="copilot.js"></script>
 * 5. <script src="crm-integration.js"></script>  ← este arquivo
 *
 * Para intranet: adicione os 4 scripts acima no HTML existente.
 * Para PWA instalável: adicione também o registro do SW abaixo.
 */

// ── CONFIGURAÇÃO GLOBAL DO CRM ─────────────────────────────────────────────
// Edite estes valores antes de publicar
window.__CRM_CONFIG__ = {
  appsScriptUrl:  'SUA_URL_APPS_SCRIPT_AQUI',   // URL do Web App do Google Apps Script
  protheusUrl:    'https://protheus.suaempresa.com.br', // URL da API REST do Protheus
  protheusToken:  '',                              // Bearer token do Protheus (obtenha via login)
  versao:         '1.0.0',
  ambiente:       'demo',                          // 'demo' | 'producao'
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. REGISTRO DO SERVICE WORKER (PWA)
// ═══════════════════════════════════════════════════════════════════════════════
async function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service Worker não suportado neste navegador.');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[PWA] Service Worker registrado. Escopo:', reg.scope);

    // Detecta atualização disponível
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // Nova versão disponível — notifica o usuário
          _mostrarBannerAtualizacao(newWorker);
        }
      });
    });

    return reg;
  } catch (error) {
    console.error('[PWA] Falha ao registrar Service Worker:', error.message);
  }
}

function _mostrarBannerAtualizacao(newWorker) {
  const banner = document.createElement('div');
  banner.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:9999;
    background:linear-gradient(135deg,#1E6FFF,#0A3BAA);color:#fff;
    padding:12px 20px;display:flex;align-items:center;justify-content:space-between;
    font-family:'Inter',sans-serif;font-size:13px;
    box-shadow:0 -4px 20px rgba(0,0,0,.4);
  `;
  banner.innerHTML = `
    <span>🔄 Nova versão do CRM disponível!</span>
    <button onclick="window.location.reload()"
      style="background:#fff;color:#1E6FFF;border:none;border-radius:6px;
             padding:6px 16px;cursor:pointer;font-weight:600;font-family:'Inter',sans-serif">
      Atualizar agora
    </button>
  `;
  document.body.appendChild(banner);
  newWorker.postMessage({ type: 'SKIP_WAITING' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PROMPT DE INSTALAÇÃO (intranet / app)
// ═══════════════════════════════════════════════════════════════════════════════
let _installPromptEvent = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPromptEvent = e;
  console.log('[PWA] Prompt de instalação capturado.');
  _mostrarBotaoInstalar();
});

function _mostrarBotaoInstalar() {
  // Adiciona botão de instalar no topbar se ainda não existir
  if (document.getElementById('pwa-install-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'pwa-install-btn';
  btn.title = 'Instalar CRM como aplicativo';
  btn.style.cssText = `
    padding:6px 13px;border-radius:7px;border:1px solid rgba(30,111,255,.35);
    background:rgba(30,111,255,.12);color:var(--blue3,#4A9AFF);cursor:pointer;
    font-size:12px;font-weight:600;font-family:'Inter',sans-serif;
    transition:all .15s;display:flex;align-items:center;gap:6px;
  `;
  btn.innerHTML = '📲 Instalar CRM';
  btn.addEventListener('click', instalarApp);
  btn.addEventListener('mouseover', () => btn.style.background = 'rgba(30,111,255,.25)');
  btn.addEventListener('mouseout',  () => btn.style.background = 'rgba(30,111,255,.12)');

  const topbarRight = document.querySelector('.tr');
  if (topbarRight) {
    topbarRight.insertBefore(btn, topbarRight.firstChild);
  }
}

async function instalarApp() {
  if (!_installPromptEvent) {
    // Fallback: instrução manual
    alert('Para instalar o CRM:\n\n📱 Android/Chrome: Menu ⋮ → "Adicionar à tela inicial"\n💻 Desktop/Chrome: Ícone ⊕ na barra de endereços → Instalar\n🍎 iOS/Safari: Compartilhar → "Adicionar à Tela de Início"');
    return;
  }

  _installPromptEvent.prompt();
  const result = await _installPromptEvent.userChoice;

  if (result.outcome === 'accepted') {
    console.log('[PWA] App instalado com sucesso!');
    document.getElementById('pwa-install-btn')?.remove();
  }

  _installPromptEvent = null;
}

// Detecta se já está instalado como PWA
window.addEventListener('appinstalled', () => {
  console.log('[PWA] CRM instalado como aplicativo.');
  document.getElementById('pwa-install-btn')?.remove();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. BANNER OFFLINE / ONLINE
// ═══════════════════════════════════════════════════════════════════════════════
function _renderBannerOffline() {
  const existing = document.getElementById('offline-banner');
  if (existing) existing.remove();

  if (navigator.onLine) return;

  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:9998;
    background:#F59E0B;color:#1C1917;padding:8px 20px;
    display:flex;align-items:center;justify-content:center;gap:10px;
    font-family:'Inter',sans-serif;font-size:12px;font-weight:600;
  `;
  banner.innerHTML = `
    📶 Modo offline — dados carregados localmente. Pedidos serão sincronizados ao reconectar.
    <span id="offline-pending" style="background:rgba(0,0,0,.15);padding:2px 8px;border-radius:10px">
      Verificando...
    </span>
  `;
  document.body.insertBefore(banner, document.body.firstChild);

  // Conta pendentes
  SmartOfflineDB.totalPendentes().then(n => {
    const span = document.getElementById('offline-pending');
    if (span) span.textContent = n > 0 ? `${n} item(s) na fila` : 'Nenhum pendente';
  });
}

window.addEventListener('online',  () => {
  document.getElementById('offline-banner')?.remove();
  // Toast de reconexão
  window.dispatchEvent(new CustomEvent('crm:toast', {
    detail: { msg: '📶 Conexão restaurada! Sincronizando dados...', tipo: 'ok' }
  }));
});

window.addEventListener('offline', () => {
  _renderBannerOffline();
  window.dispatchEvent(new CustomEvent('crm:toast', {
    detail: { msg: '📶 Sem internet — CRM em modo offline', tipo: 'info' }
  }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LISTENER DO TOAST GLOBAL (eventos internos do sistema)
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('crm:toast', (e) => {
  const { msg, tipo } = e.detail || {};
  if (typeof window.toast === 'function') {
    window.toast(msg, tipo === 'ok' ? 'ok' : tipo === 'info' ? 'info' : 'err');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. INICIALIZAÇÃO PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
async function inicializarCRM() {
  console.log('[CRM] Inicializando Smart Automation CRM v' + window.__CRM_CONFIG__.versao);

  // Detecta perfil atual (definido pelo login)
  const perfil      = window.currentPerfil?.role?.toLowerCase().includes('admin') ? 'admin' : 'vendedor';
  const vendedorNome = perfil === 'vendedor' ? window.currentPerfil?.nome : null;

  // 1. Registra Service Worker
  await registrarServiceWorker();

  // 2. Inicializa banco offline
  await SmartOfflineDB.init();

  // 3. Carrega dados do servidor (com fallback para IndexedDB)
  const carregouServidor = await SmartOfflineDB.Sincronizador.carregarDadosServidor(perfil, vendedorNome);
  if (!carregouServidor) {
    console.log('[CRM] Usando dados do IndexedDB (offline ou servidor indisponível)');
  }

  // 4. Inicializa Central de Notificações
  if (window.SmartNotificacoes) {
    await SmartNotificacoes.init(perfil, vendedorNome);
  }

  // 5. Inicializa Copilot
  if (window.SmartCopilot) {
    SmartCopilot.init(perfil, vendedorNome);
  }

  // 6. Banner offline se necessário
  _renderBannerOffline();

  // 7. Listener para abrir lead via notificação
  window.addEventListener('crm:abrir-lead', (e) => {
    const { leadId } = e.detail || {};
    if (leadId && typeof verDet === 'function') {
      verDet(typeof leadId === 'number' ? leadId : parseInt(leadId));
    }
  });

  // 8. Notificações de demo (apenas em ambiente demo)
  if (window.__CRM_CONFIG__.ambiente === 'demo') {
    setTimeout(() => _dispararNotifDemo(), 5000);
  }

  console.log('[CRM] Inicialização concluída.', { perfil, vendedorNome, online: navigator.onLine });
}

function _dispararNotifDemo() {
  if (!window.SmartNotificacoes) return;

  // Simula notificações realistas para demonstração
  SmartNotificacoes.criar('risco_carteira',
    'Risco de carteira: Frigorífico Bela Vista',
    'Cliente vinculado exclusivamente a Carlos Silva. 45 dias de relacionamento.',
    { leadId: 1 }
  );

  setTimeout(() => {
    SmartNotificacoes.criar('lead_respondeu',
      'Pet Food Varejo RJ respondeu!',
      '"Olá! Tenho interesse em analisar a proposta. Pode me ligar amanhã?"',
      { leadId: 8 }
    );
  }, 3000);
}

// ── INICIA TUDO ───────────────────────────────────────────────────────────────
// Aguarda o DOM estar pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializarCRM);
} else {
  inicializarCRM();
}

// Expõe função de instalação globalmente
window.instalarCRMComoApp = instalarApp;
