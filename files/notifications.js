/**
 * Smart Automation CRM — Central de Notificações
 * Eventos: Risco de Carteira, Lead respondeu, Lead parado, Meta atingida, Sync completo
 * Persistência: Google Sheets (via Apps Script) + IndexedDB local
 */

const SmartNotificacoes = (() => {

  // ── CONFIGURAÇÃO ─────────────────────────────────────────────────────────
  const APPS_SCRIPT_URL = window.__CRM_CONFIG__?.appsScriptUrl || '';

  // Tipos de notificação com configuração de ícone e cor
  const TIPOS = {
    risco_carteira:  { label: 'Risco de Carteira', icon: '🛡️', cor: '#EF4444', destino: 'admin' },
    lead_respondeu:  { label: 'Lead Respondeu',    icon: '💬', cor: '#10B981', destino: 'vendedor' },
    lead_parado:     { label: 'Lead Parado',        icon: '⚠️', cor: '#F59E0B', destino: 'all' },
    meta_atingida:   { label: 'Meta Atingida',      icon: '🎯', cor: '#1E6FFF', destino: 'all' },
    proposta_vista:  { label: 'Proposta Visualizada',icon: '👁️', cor: '#8B5CF6', destino: 'vendedor' },
    contrato_vence:  { label: 'Contrato Vencendo',  icon: '📋', cor: '#F59E0B', destino: 'admin' },
    sync_completo:   { label: 'Sincronização',       icon: '🔄', cor: '#10B981', destino: 'all' },
    nova_mensagem:   { label: 'Nova Mensagem',       icon: '📩', cor: '#1E6FFF', destino: 'vendedor' },
  };

  // Estado interno
  let _notificacoes   = [];
  let _naoLidas       = 0;
  let _perfil         = 'admin';
  let _vendedorNome   = null;
  let _initialized    = false;
  let _pollingInterval= null;
  let _lastCheck      = null;

  // Preferências padrão
  let _prefs = {
    ativar_whatsapp:      true,
    ativar_email:         true,
    ativar_push:          false,
    ativar_som:           true,
    risco_carteira:       true,
    lead_respondeu:       true,
    lead_parado:          true,
    meta_atingida:        true,
    proposta_vista:       true,
    contrato_vence:       true,
    intervalo_polling_ms: 30000,  // 30 segundos
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // INICIALIZAÇÃO
  // ═══════════════════════════════════════════════════════════════════════════
  async function init(perfil = 'admin', vendedorNome = null) {
    _perfil       = perfil;
    _vendedorNome = vendedorNome;
    _initialized  = true;

    // Carrega preferências salvas
    if (window.SmartOfflineDB) {
      const prefsalvas = await SmartOfflineDB.Config.get('notif_prefs');
      if (prefsalvas) Object.assign(_prefs, prefsalvas);
    }

    // Renderiza UI
    _renderBadge();
    _renderModal();

    // Carrega notificações iniciais
    await _carregarDoServidor();

    // Inicia polling se online
    if (navigator.onLine) _iniciarPolling();

    // Listeners de eventos do CRM
    _registrarListeners();

    console.log('[Notificações] Central inicializada para perfil:', perfil);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI — BADGE NO HEADER
  // ═══════════════════════════════════════════════════════════════════════════
  function _renderBadge() {
    // Remove existente
    document.getElementById('notif-btn-wrapper')?.remove();

    const wrapper = document.createElement('div');
    wrapper.id = 'notif-btn-wrapper';
    wrapper.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
    wrapper.innerHTML = `
      <button id="notif-sino-btn" title="Notificações"
        style="width:34px;height:34px;border-radius:7px;background:var(--bg3,#0D1530);
               border:1px solid var(--line,rgba(30,111,255,.15));
               display:flex;align-items:center;justify-content:center;
               cursor:pointer;font-size:16px;position:relative;transition:border-color .15s;
               color:var(--white,#E8EEFF);"
        onmouseover="this.style.borderColor='var(--blue2,#2D84FF)'"
        onmouseout="this.style.borderColor='var(--line,rgba(30,111,255,.15))'">
        🔔
        <div id="notif-badge"
          style="position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;
                 background:#EF4444;border-radius:8px;
                 font-size:9px;font-weight:700;color:#fff;
                 display:none;align-items:center;justify-content:center;
                 padding:0 3px;font-family:'Inter',sans-serif;z-index:10">
          0
        </div>
      </button>
    `;

    wrapper.querySelector('#notif-sino-btn').addEventListener('click', toggleModal);

    // Insere antes do botão "+ Novo Lead" no topbar
    const topbarRight = document.querySelector('.tr');
    if (topbarRight) {
      const novoBtnRef = topbarRight.querySelector('.btn-p');
      topbarRight.insertBefore(wrapper, novoBtnRef);
    }
  }

  function _atualizarBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;

    _naoLidas = _notificacoes.filter(n => !n.lida).length;

    if (_naoLidas > 0) {
      badge.textContent = _naoLidas > 99 ? '99+' : _naoLidas;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI — MODAL DE NOTIFICAÇÕES
  // ═══════════════════════════════════════════════════════════════════════════
  function _renderModal() {
    document.getElementById('notif-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'notif-modal-overlay';
    overlay.style.cssText = `
      position:fixed;top:0;right:0;width:400px;height:100vh;
      background:var(--bg2,#080E1C);border-left:1px solid var(--line2,rgba(30,111,255,.28));
      z-index:800;display:flex;flex-direction:column;
      transform:translateX(100%);transition:transform .25s cubic-bezier(.4,0,.2,1);
      box-shadow:-8px 0 32px rgba(0,0,0,.5);font-family:'Inter',sans-serif;
    `;

    overlay.innerHTML = `
      <!-- Header -->
      <div style="padding:16px 18px;border-bottom:1px solid var(--line,rgba(30,111,255,.15));
                  display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--white,#E8EEFF)">
            🔔 Notificações
          </div>
          <div style="font-size:11px;color:var(--muted,#6B7299);margin-top:2px" id="notif-subtitulo">
            Carregando...
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="notif-marcar-todas" title="Marcar todas como lidas"
            style="background:none;border:1px solid var(--line,rgba(30,111,255,.15));
                   border-radius:6px;padding:4px 10px;color:var(--muted,#6B7299);
                   cursor:pointer;font-size:11px;font-family:'Inter',sans-serif"
            onmouseover="this.style.color='var(--white,#E8EEFF)'"
            onmouseout="this.style.color='var(--muted,#6B7299)'">
            ✓ Todas lidas
          </button>
          <button onclick="SmartNotificacoes.fecharModal()"
            style="background:none;border:none;color:var(--muted,#6B7299);
                   font-size:18px;cursor:pointer;padding:2px 6px;border-radius:5px"
            onmouseover="this.style.color='var(--white,#E8EEFF)'"
            onmouseout="this.style.color='var(--muted,#6B7299)'">✕</button>
        </div>
      </div>

      <!-- Tabs: Notificações | Configurações -->
      <div style="display:flex;border-bottom:1px solid var(--line,rgba(30,111,255,.15));flex-shrink:0">
        <button id="tab-notif" onclick="SmartNotificacoes._switchTab('notif')"
          style="flex:1;padding:10px;font-size:12px;font-weight:600;font-family:'Inter',sans-serif;
                 border:none;background:none;cursor:pointer;
                 color:var(--blue3,#4A9AFF);border-bottom:2px solid var(--blue,#1E6FFF)">
          Alertas
        </button>
        <button id="tab-config" onclick="SmartNotificacoes._switchTab('config')"
          style="flex:1;padding:10px;font-size:12px;font-weight:600;font-family:'Inter',sans-serif;
                 border:none;background:none;cursor:pointer;
                 color:var(--muted,#6B7299);border-bottom:2px solid transparent">
          ⚙️ Configurar
        </button>
      </div>

      <!-- Lista de notificações -->
      <div id="notif-lista" style="flex:1;overflow-y:auto;padding:8px 0">
        <div style="text-align:center;padding:48px 16px;color:var(--muted,#6B7299);font-size:13px">
          <div style="font-size:32px;margin-bottom:12px">🔔</div>
          Carregando notificações...
        </div>
      </div>

      <!-- Painel de configurações (oculto inicialmente) -->
      <div id="notif-config-panel" style="display:none;flex:1;overflow-y:auto;padding:16px">
        ${_renderConfigPanel()}
      </div>
    `;

    document.body.appendChild(overlay);

    // Botão "Marcar todas como lidas"
    overlay.querySelector('#notif-marcar-todas')
      .addEventListener('click', marcarTodasLidas);

    // Clique fora fecha
    document.addEventListener('click', (e) => {
      if (_modalAberto && !overlay.contains(e.target) &&
          !document.getElementById('notif-sino-btn')?.contains(e.target)) {
        fecharModal();
      }
    });
  }

  function _renderConfigPanel() {
    const canais = [
      { key: 'ativar_whatsapp', label: 'WhatsApp Business', desc: 'Notificações via WhatsApp' },
      { key: 'ativar_email',    label: 'E-mail',            desc: 'Relatórios e alertas por e-mail' },
      { key: 'ativar_push',     label: 'Push (Navegador)',  desc: 'Notificações mesmo com CRM fechado' },
      { key: 'ativar_som',      label: 'Som',               desc: 'Toque ao receber notificação' },
    ];

    const eventos = Object.entries(TIPOS).map(([key, t]) => ({
      key, label: t.label, icon: t.icon
    }));

    return `
      <div style="font-size:11px;color:var(--muted,#6B7299);letter-spacing:1px;
                  text-transform:uppercase;font-family:'JetBrains Mono',monospace;
                  margin-bottom:10px">Canais de notificação</div>
      ${canais.map(c => `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:11px 13px;background:var(--bg3,#0D1530);border-radius:8px;
                    border:1px solid var(--line,rgba(30,111,255,.15));margin-bottom:7px">
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--white,#E8EEFF)">${c.label}</div>
            <div style="font-size:10px;color:var(--muted,#6B7299);margin-top:1px">${c.desc}</div>
          </div>
          <button class="notif-toggle ${_prefs[c.key] ? 'on' : 'off'}" data-pref="${c.key}"
            style="width:34px;height:18px;border-radius:9px;border:none;cursor:pointer;
                   background:${_prefs[c.key] ? '#10B981' : 'var(--bg5,#141E38)'};
                   position:relative;transition:background .15s;flex-shrink:0"
            onclick="SmartNotificacoes._togglePref('${c.key}', this)">
            <span style="position:absolute;top:3px;left:${_prefs[c.key] ? '17px' : '3px'};
                         width:12px;height:12px;border-radius:50%;background:#fff;
                         transition:left .15s;display:block"></span>
          </button>
        </div>
      `).join('')}

      <div style="font-size:11px;color:var(--muted,#6B7299);letter-spacing:1px;
                  text-transform:uppercase;font-family:'JetBrains Mono',monospace;
                  margin:16px 0 10px">Tipos de alerta</div>
      ${eventos.map(e => `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:10px 13px;background:var(--bg3,#0D1530);border-radius:8px;
                    border:1px solid var(--line,rgba(30,111,255,.15));margin-bottom:6px">
          <div style="font-size:12px;color:var(--white,#E8EEFF)">
            ${e.icon} ${e.label}
          </div>
          <button class="notif-toggle ${_prefs[e.key] !== false ? 'on' : 'off'}" data-pref="${e.key}"
            style="width:34px;height:18px;border-radius:9px;border:none;cursor:pointer;
                   background:${_prefs[e.key] !== false ? '#10B981' : 'var(--bg5,#141E38)'};
                   position:relative;transition:background .15s;flex-shrink:0"
            onclick="SmartNotificacoes._togglePref('${e.key}', this)">
            <span style="position:absolute;top:3px;left:${_prefs[e.key] !== false ? '17px' : '3px'};
                         width:12px;height:12px;border-radius:50%;background:#fff;
                         transition:left .15s;display:block"></span>
          </button>
        </div>
      `).join('')}

      <button onclick="SmartNotificacoes._salvarPrefs()"
        style="width:100%;margin-top:14px;padding:10px;
               background:linear-gradient(135deg,#1E6FFF,#2D84FF);color:#fff;
               border:none;border-radius:8px;font-size:13px;font-weight:600;
               cursor:pointer;font-family:'Inter',sans-serif">
        ✓ Salvar preferências
      </button>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADO DO MODAL
  // ═══════════════════════════════════════════════════════════════════════════
  let _modalAberto = false;

  function toggleModal() {
    _modalAberto ? fecharModal() : abrirModal();
  }

  function abrirModal() {
    const overlay = document.getElementById('notif-modal-overlay');
    if (!overlay) return;
    overlay.style.transform = 'translateX(0)';
    _modalAberto = true;
    _renderLista();
  }

  function fecharModal() {
    const overlay = document.getElementById('notif-modal-overlay');
    if (!overlay) return;
    overlay.style.transform = 'translateX(100%)';
    _modalAberto = false;
  }

  function _switchTab(tab) {
    const lista   = document.getElementById('notif-lista');
    const config  = document.getElementById('notif-config-panel');
    const tabN    = document.getElementById('tab-notif');
    const tabC    = document.getElementById('tab-config');

    if (tab === 'notif') {
      lista.style.display   = 'block';
      config.style.display  = 'none';
      tabN.style.color      = 'var(--blue3,#4A9AFF)';
      tabN.style.borderBottom = '2px solid var(--blue,#1E6FFF)';
      tabC.style.color      = 'var(--muted,#6B7299)';
      tabC.style.borderBottom = '2px solid transparent';
    } else {
      lista.style.display   = 'none';
      config.style.display  = 'block';
      tabN.style.color      = 'var(--muted,#6B7299)';
      tabN.style.borderBottom = '2px solid transparent';
      tabC.style.color      = 'var(--blue3,#4A9AFF)';
      tabC.style.borderBottom = '2px solid var(--blue,#1E6FFF)';
      // Re-renderiza config com estado atualizado
      document.getElementById('notif-config-panel').innerHTML = _renderConfigPanel();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDERIZAR LISTA
  // ═══════════════════════════════════════════════════════════════════════════
  function _renderLista() {
    const container = document.getElementById('notif-lista');
    const subtitulo = document.getElementById('notif-subtitulo');
    if (!container) return;

    _naoLidas = _notificacoes.filter(n => !n.lida).length;
    if (subtitulo) {
      subtitulo.textContent = _naoLidas > 0
        ? `${_naoLidas} não ${_naoLidas === 1 ? 'lida' : 'lidas'}`
        : 'Todas lidas ✓';
    }

    if (!_notificacoes.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 16px;color:var(--muted,#6B7299);font-size:13px">
          <div style="font-size:40px;margin-bottom:12px">🎉</div>
          Nenhuma notificação
        </div>
      `;
      return;
    }

    // Agrupa por data
    const hoje = new Date().toDateString();
    const notifsHoje    = _notificacoes.filter(n => new Date(n.createdAt).toDateString() === hoje);
    const notifsAntigos = _notificacoes.filter(n => new Date(n.createdAt).toDateString() !== hoje);

    let html = '';
    if (notifsHoje.length) {
      html += `<div style="padding:6px 14px;font-size:10px;color:var(--muted,#6B7299);
                           letter-spacing:1.5px;text-transform:uppercase;
                           font-family:'JetBrains Mono',monospace">Hoje</div>`;
      html += notifsHoje.map(_renderItem).join('');
    }
    if (notifsAntigos.length) {
      html += `<div style="padding:10px 14px 6px;font-size:10px;color:var(--muted,#6B7299);
                           letter-spacing:1.5px;text-transform:uppercase;
                           font-family:'JetBrains Mono',monospace">Anteriores</div>`;
      html += notifsAntigos.map(_renderItem).join('');
    }

    container.innerHTML = html;
  }

  function _renderItem(n) {
    const tipo   = TIPOS[n.tipo] || { icon: '🔔', cor: '#6B7299', label: n.tipo };
    const tempo  = _formatarTempo(n.createdAt);
    const fundo  = n.lida ? 'transparent' : `${tipo.cor}11`;
    const borda  = n.lida ? 'var(--line,rgba(30,111,255,.15))' : `${tipo.cor}55`;

    return `
      <div onclick="SmartNotificacoes._clicarNotif('${n.id}')"
        style="padding:12px 14px;margin:2px 8px;border-radius:9px;cursor:pointer;
               background:${fundo};border:1px solid ${borda};
               transition:background .15s,border-color .15s"
        onmouseover="this.style.background='var(--bg3,#0D1530)'"
        onmouseout="this.style.background='${fundo}'">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="width:32px;height:32px;border-radius:8px;flex-shrink:0;
                      background:${tipo.cor}22;display:flex;align-items:center;
                      justify-content:center;font-size:15px">
            ${tipo.icon}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:${n.lida ? '400' : '600'};
                        color:var(--white,#E8EEFF);line-height:1.45;margin-bottom:3px">
              ${n.titulo}
            </div>
            <div style="font-size:11px;color:var(--muted,#6B7299);line-height:1.4">
              ${n.mensagem}
            </div>
            <div style="font-size:10px;color:var(--muted,#6B7299);margin-top:4px;
                        display:flex;align-items:center;gap:6px">
              <span>${tipo.label}</span>
              <span>·</span>
              <span>${tempo}</span>
              ${!n.lida ? `<span style="width:6px;height:6px;border-radius:50%;
                                       background:${tipo.cor};display:inline-block;
                                       margin-left:auto"></span>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AÇÕES
  // ═══════════════════════════════════════════════════════════════════════════
  async function _clicarNotif(id) {
    const notif = _notificacoes.find(n => n.id === id);
    if (!notif) return;

    // Marca como lida
    if (!notif.lida) await marcarLida(id);

    // Navega para o lead correspondente
    if (notif.leadId) {
      fecharModal();
      // Dispara abertura do detalhe do lead
      window.dispatchEvent(new CustomEvent('crm:abrir-lead', { detail: { leadId: notif.leadId } }));
      // Tenta chamar a função global do CRM se disponível
      if (typeof verDet === 'function') verDet(notif.leadId);
    }
  }

  async function marcarLida(id) {
    const notif = _notificacoes.find(n => n.id === id);
    if (!notif || notif.lida) return;

    notif.lida = true;
    _atualizarBadge();
    _renderLista();

    // Persiste no Sheets via Apps Script
    if (navigator.onLine && APPS_SCRIPT_URL) {
      try {
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acao: 'marcarNotifLida', id })
        });
      } catch (e) {
        console.warn('[Notificações] Falha ao marcar lida no servidor:', e.message);
      }
    }

    // Salva localmente no IndexedDB
    if (window.SmartOfflineDB) {
      await SmartOfflineDB.Config.set(`notif_lida_${id}`, true);
    }
  }

  async function marcarTodasLidas() {
    const naoLidas = _notificacoes.filter(n => !n.lida);
    naoLidas.forEach(n => { n.lida = true; });
    _atualizarBadge();
    _renderLista();

    if (navigator.onLine && APPS_SCRIPT_URL && naoLidas.length) {
      try {
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            acao: 'marcarTodasLidas',
            ids: naoLidas.map(n => n.id)
          })
        });
      } catch (e) {
        console.warn('[Notificações] Falha ao marcar todas:', e.message);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CRIAR NOTIFICAÇÃO (chamado internamente ou por eventos do CRM)
  // ═══════════════════════════════════════════════════════════════════════════
  async function criar(tipo, titulo, mensagem, opts = {}) {
    // Verifica se este tipo está ativado nas preferências
    if (_prefs[tipo] === false) return;

    const tipo_info = TIPOS[tipo] || { destino: 'all' };

    // Filtra por perfil: notificações de admin não vão para vendedor
    if (tipo_info.destino === 'admin' && _perfil !== 'admin') return;
    if (tipo_info.destino === 'vendedor' && _perfil === 'admin' && !opts.forcarAdmin) return;

    const notif = {
      id:        `notif-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      tipo,
      titulo,
      mensagem,
      lida:      false,
      leadId:    opts.leadId  || null,
      createdAt: new Date().toISOString(),
      destino:   _perfil,
      vendedor:  _vendedorNome
    };

    _notificacoes.unshift(notif);
    if (_notificacoes.length > 100) _notificacoes.pop(); // Mantém últimas 100

    _atualizarBadge();
    if (_modalAberto) _renderLista();

    // Toast UI
    _mostrarToast(notif);

    // Som se ativado
    if (_prefs.ativar_som) _tocarSom();

    // Persiste no Sheets
    await _persistirNoSheets(notif);

    return notif;
  }

  function _mostrarToast(notif) {
    const tipo = TIPOS[notif.tipo] || { icon: '🔔', cor: '#6B7299' };
    window.dispatchEvent(new CustomEvent('crm:toast', {
      detail: { msg: `${tipo.icon} ${notif.titulo} — ${notif.mensagem}`, tipo: 'info' }
    }));
  }

  function _tocarSom() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARREGAR DO SERVIDOR (Google Sheets via Apps Script)
  // ═══════════════════════════════════════════════════════════════════════════
  async function _carregarDoServidor() {
    if (!navigator.onLine || !APPS_SCRIPT_URL) {
      _renderLista();
      _atualizarBadge();
      return;
    }

    try {
      const params = new URLSearchParams({
        acao: 'getNotificacoes',
        perfil: _perfil,
        vendedor: _vendedorNome || '',
        desde: _lastCheck || new Date(Date.now() - 86400000 * 7).toISOString() // últimos 7 dias
      });

      const response = await fetch(`${APPS_SCRIPT_URL}?${params}`, {
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) return;

      const { notificacoes } = await response.json();
      if (Array.isArray(notificacoes)) {
        // Merge com locais (evita duplicatas)
        const idsExistentes = new Set(_notificacoes.map(n => n.id));
        const novas = notificacoes.filter(n => !idsExistentes.has(n.id));
        _notificacoes = [...novas, ..._notificacoes]
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      _lastCheck = new Date().toISOString();
    } catch (e) {
      console.warn('[Notificações] Falha ao carregar do servidor:', e.message);
    }

    _renderLista();
    _atualizarBadge();
  }

  async function _persistirNoSheets(notif) {
    if (!navigator.onLine || !APPS_SCRIPT_URL) return;
    try {
      await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'salvarNotificacao', notif })
      });
    } catch (e) {
      console.warn('[Notificações] Falha ao persistir:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POLLING — verifica servidor periodicamente
  // ═══════════════════════════════════════════════════════════════════════════
  function _iniciarPolling() {
    if (_pollingInterval) clearInterval(_pollingInterval);

    _pollingInterval = setInterval(async () => {
      if (!navigator.onLine) return;
      await _carregarDoServidor();

      // Verifica riscos de carteira (apenas admin)
      if (_perfil === 'admin') await _verificarRiscosCarteira();

    }, _prefs.intervalo_polling_ms);

    console.log('[Notificações] Polling iniciado:', _prefs.intervalo_polling_ms, 'ms');
  }

  async function _verificarRiscosCarteira() {
    // Consulta o IndexedDB local para verificar clientes de risco
    if (!window.SmartOfflineDB) return;

    try {
      const clientes = await SmartOfflineDB.Clientes.getAll();
      const risco = clientes.filter(c =>
        c.exclusivo && c.diasSemContato > 30
      );

      risco.forEach(async c => {
        const notifExistente = _notificacoes.find(n =>
          n.tipo === 'risco_carteira' && n.leadId === c.id &&
          new Date(n.createdAt) > new Date(Date.now() - 86400000) // menos de 1 dia
        );
        if (!notifExistente) {
          await criar(
            'risco_carteira',
            `Risco de carteira: ${c.nome}`,
            `Cliente vinculado apenas a ${c.vendedor}. ${c.diasSemContato} dias sem contato.`,
            { leadId: c.id }
          );
        }
      });
    } catch (e) {
      console.warn('[Notificações] Erro ao verificar riscos:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREFERÊNCIAS
  // ═══════════════════════════════════════════════════════════════════════════
  function _togglePref(key, btn) {
    _prefs[key] = !_prefs[key];
    const on = _prefs[key];
    btn.style.background = on ? '#10B981' : 'var(--bg5,#141E38)';
    const thumb = btn.querySelector('span');
    if (thumb) thumb.style.left = on ? '17px' : '3px';
    btn.classList.toggle('on', on);
    btn.classList.toggle('off', !on);
  }

  async function _salvarPrefs() {
    if (window.SmartOfflineDB) {
      await SmartOfflineDB.Config.set('notif_prefs', _prefs);
    }
    window.dispatchEvent(new CustomEvent('crm:toast', {
      detail: { msg: 'Preferências de notificação salvas!', tipo: 'ok' }
    }));

    // Reinicia polling com novo intervalo
    if (_pollingInterval) {
      clearInterval(_pollingInterval);
      _iniciarPolling();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  function _formatarTempo(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 60000)   return 'agora';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}min`;
    if (diff < 86400000)return `${Math.floor(diff / 3600000)}h`;
    return new Date(isoString).toLocaleDateString('pt-BR');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LISTENERS DE EVENTOS DO CRM
  // ═══════════════════════════════════════════════════════════════════════════
  function _registrarListeners() {
    // Sync concluído
    window.addEventListener('crm:sync-completo', (e) => {
      const { enviados, erros } = e.detail;
      criar('sync_completo',
        'Sincronização concluída',
        `${enviados} ${enviados === 1 ? 'item enviado' : 'itens enviados'}${erros ? `, ${erros} erro(s)` : ''}.`
      );
    });

    // Reconexão
    window.addEventListener('online', () => {
      _iniciarPolling();
    });

    window.addEventListener('offline', () => {
      if (_pollingInterval) clearInterval(_pollingInterval);
    });

    // Service Worker — notificação de clique
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (event.data?.type === 'NOTIFICATION_CLICK') {
        abrirModal();
        if (event.data.leadId) {
          _clicarNotif(event.data.leadId);
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    init,
    criar,
    marcarLida,
    marcarTodasLidas,
    abrirModal,
    fecharModal,
    toggleModal,
    _switchTab,
    _togglePref,
    _salvarPrefs,
    _clicarNotif,

    // Eventos pré-definidos para uso direto no CRM
    alertarRiscoCarteira: (cliente) => criar(
      'risco_carteira',
      `Risco: ${cliente.nome}`,
      `Vinculado exclusivamente a ${cliente.vendedor}. ${cliente.diasSemContato} dias sem contato.`,
      { leadId: cliente.id }
    ),

    alertarLeadRespondeu: (lead, mensagem) => criar(
      'lead_respondeu',
      `${lead.nome} respondeu!`,
      mensagem || 'Lead respondeu a uma mensagem automática via WhatsApp.',
      { leadId: lead.id }
    ),

    alertarLeadParado: (lead) => criar(
      'lead_parado',
      `Lead parado: ${lead.nome}`,
      `Sem contato há ${lead.diasSemContato} dias. Vendedor: ${lead.vend}.`,
      { leadId: lead.id }
    ),

    alertarContratoVence: (contrato) => criar(
      'contrato_vence',
      `Contrato vencendo: ${contrato.cliente}`,
      `Vence em ${contrato.vencDias} dias. Valor: ${contrato.val}.`,
      { leadId: contrato.id }
    ),

    get naoLidas() { return _naoLidas; },
    get total() { return _notificacoes.length; }
  };
})();

window.SmartNotificacoes = SmartNotificacoes;
