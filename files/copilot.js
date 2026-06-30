/**
 * Smart Automation CRM — Copilot IA
 * Motor: Anthropic claude-sonnet-4-6
 * Níveis: Admin (visão total) | Vendedor (apenas própria carteira)
 * Anti-alucinação: System Prompt com dados reais como única fonte da verdade
 */

const SmartCopilot = (() => {

  // ── ESTADO ───────────────────────────────────────────────────────────────
  let _perfil       = 'admin';
  let _vendedorNome = null;
  let _historico    = [];          // Histórico da conversa (context window)
  let _aberto       = false;
  let _processando  = false;
  const MAX_HIST    = 10;          // Máximo de turnos mantidos no contexto

  // ── SYSTEM PROMPTS POR PERFIL ─────────────────────────────────────────────

  /**
   * Monta o System Prompt injetando os dados reais do CRM como fonte da verdade.
   * Isso previne alucinação — a IA só pode afirmar o que está nos dados fornecidos.
   */
  function _buildSystemPrompt(dadosCRM) {
    const base = `
Você é o Copilot do CRM Smart Automation — um assistente de inteligência artificial especializado em análise de vendas e gestão comercial.

REGRAS ABSOLUTAS (nunca viole):
1. USE APENAS os dados fornecidos abaixo como fonte da verdade. Se a informação não estiver nos dados, diga "Não tenho essa informação nos dados atuais do CRM".
2. NUNCA invente números, nomes, datas ou valores que não estejam explicitamente nos dados.
3. Responda SEMPRE em português brasileiro, de forma direta e útil.
4. Use emojis com moderação para facilitar a leitura.
5. Seja objetivo: máximo 4 parágrafos por resposta, a menos que solicitado relatório completo.
6. Quando detectar um problema (ex: lead parado, risco de carteira), proponha uma ação concreta.

DADOS ATUAIS DO CRM (única fonte da verdade):
${JSON.stringify(dadosCRM, null, 2)}

DATA E HORA ATUAL: ${new Date().toLocaleString('pt-BR')}
`;

    if (_perfil === 'admin') {
      return base + `
PERFIL DO USUÁRIO: Admin / Gestor
ESCOPO: Acesso total a todos os dados da operação comercial.
FUNÇÕES PRINCIPAIS:
- Analisar performance do time completo (todos os vendedores)
- Identificar riscos de carteira (clientes exclusivos de 1 vendedor)
- Analisar motivos de perda e recomendar ações corretivas
- Comparar performance PJ vs CLT
- Identificar leads parados e alertar sobre prioridades
- Fazer projeções de receita (forecast) com base no pipeline
- Gerar insights sobre conversão por produto, região ou canal
- Alertar sobre contratos vencendo

Seja analítico e estratégico. O gestor quer respostas que o ajudem a tomar decisões.`;

    } else {
      return base + `
PERFIL DO USUÁRIO: Vendedor — ${_vendedorNome}
ESCOPO RESTRITO: Você só pode ver e comentar sobre dados da carteira de ${_vendedorNome}. 
REGRA DE PRIVACIDADE: NUNCA mencione dados, leads, resultados ou informações de outros vendedores. Se perguntado sobre outros, responda: "Só tenho acesso à sua carteira."
FUNÇÕES PRINCIPAIS:
- Ajudar a redigir mensagens de follow-up para leads específicos
- Resumir o histórico de um contato para preparar abordagem
- Sugerir próximos passos para leads em cada etapa do funil
- Responder dúvidas sobre o processo de vendas
- Analisar a própria performance do vendedor
- Sugerir argumentos para objeções comuns (preço, prazo, concorrente)

Seja prático e operacional. O vendedor quer ajuda para fechar o próximo negócio.`;
    }
  }

  // ── UI: SIDEBAR ───────────────────────────────────────────────────────────
  function _renderSidebar() {
    document.getElementById('copilot-sidebar')?.remove();

    const sidebar = document.createElement('div');
    sidebar.id = 'copilot-sidebar';
    sidebar.style.cssText = `
      position:fixed;bottom:0;right:0;width:420px;height:100vh;
      background:var(--bg2,#080E1C);border-left:1px solid var(--line2,rgba(30,111,255,.28));
      z-index:700;display:flex;flex-direction:column;
      transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);
      box-shadow:-8px 0 32px rgba(0,0,0,.55);font-family:'Inter',sans-serif;
    `;

    sidebar.innerHTML = `
      <!-- Header -->
      <div style="padding:14px 16px;background:linear-gradient(135deg,#1E6FFF,#0A3BAA);
                  display:flex;align-items:center;gap:10px;flex-shrink:0">
        <div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.2);
                    display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">
          🤖
        </div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;color:#fff">Copilot Smart CRM</div>
          <div style="font-size:11px;color:rgba(255,255,255,.75);display:flex;align-items:center;gap:5px">
            <div style="width:6px;height:6px;border-radius:50%;background:#10B981;box-shadow:0 0 5px #10B981"></div>
            ${_perfil === 'admin' ? 'Visão Admin — acesso total' : `Vendedor: ${_vendedorNome}`}
          </div>
        </div>
        <button onclick="SmartCopilot.limparHistorico()" title="Limpar histórico"
          style="background:rgba(255,255,255,.15);border:none;border-radius:6px;
                 padding:5px 9px;color:#fff;cursor:pointer;font-size:11px;
                 font-family:'Inter',sans-serif">🗑</button>
        <button onclick="SmartCopilot.fechar()"
          style="background:rgba(255,255,255,.15);border:none;border-radius:6px;
                 padding:5px 9px;color:#fff;cursor:pointer;font-size:16px">✕</button>
      </div>

      <!-- Contexto atual -->
      <div id="copilot-ctx" style="padding:8px 14px;background:rgba(30,111,255,.08);
                                    border-bottom:1px solid var(--line,rgba(30,111,255,.15));
                                    font-size:11px;color:var(--blue3,#4A9AFF);flex-shrink:0">
        📍 Carregando contexto do CRM...
      </div>

      <!-- Mensagens -->
      <div id="copilot-msgs" style="flex:1;overflow-y:auto;padding:14px;
                                     display:flex;flex-direction:column;gap:10px">
        <!-- Mensagem de boas-vindas -->
        <div class="cop-msg-bot">
          <div style="max-width:88%;background:var(--bg3,#0D1530);padding:11px 14px;
                      border-radius:12px;border-bottom-left-radius:3px;
                      font-size:13px;line-height:1.55;color:var(--white,#E8EEFF)">
            ${_perfil === 'admin'
              ? 'Olá! Sou o Copilot do CRM 🤖\n\nTenho acesso completo aos dados da operação. Posso analisar performance do time, riscos de carteira, motivos de perda e muito mais.\n\nComo posso ajudar?'
              : `Olá, ${_vendedorNome}! Sou o Copilot 🤖\n\nEstou aqui para ajudar com a sua carteira: redigir mensagens de follow-up, resumir histórico de contatos ou sugerir próximos passos.\n\nSobre qual lead quer trabalhar?`
            }
          </div>
          <div style="font-size:9px;color:var(--muted,#6B7299);margin-top:3px;padding:0 2px">
            Copilot · agora
          </div>
        </div>
      </div>

      <!-- Atalhos rápidos -->
      <div id="copilot-atalhos" style="padding:8px 12px;display:flex;gap:6px;
                                        flex-wrap:wrap;border-top:1px solid var(--line,rgba(30,111,255,.15))">
        ${_getAtalhos().map(a => `
          <button onclick="SmartCopilot.perguntar('${a.q}')"
            style="background:rgba(30,111,255,.12);border:1px solid rgba(30,111,255,.25);
                   border-radius:20px;padding:4px 10px;font-size:10px;
                   color:var(--blue3,#4A9AFF);cursor:pointer;
                   font-family:'Inter',sans-serif;transition:all .12s"
            onmouseover="this.style.background='rgba(30,111,255,.25)'"
            onmouseout="this.style.background='rgba(30,111,255,.12)'">
            ${a.label}
          </button>
        `).join('')}
      </div>

      <!-- Input -->
      <div style="padding:12px;border-top:1px solid var(--line,rgba(30,111,255,.15));
                  display:flex;gap:8px;flex-shrink:0;align-items:flex-end">
        <textarea id="copilot-input" placeholder="Pergunte sobre leads, vendas, performance..."
          style="flex:1;background:var(--bg3,#0D1530);border:1px solid var(--line,rgba(30,111,255,.15));
                 border-radius:8px;padding:9px 12px;color:var(--white,#E8EEFF);
                 font-family:'Inter',sans-serif;font-size:13px;outline:none;resize:none;
                 min-height:42px;max-height:120px;line-height:1.5;transition:border-color .12s"
          onfocus="this.style.borderColor='var(--blue2,#2D84FF)'"
          onblur="this.style.borderColor='var(--line,rgba(30,111,255,.15))'"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();SmartCopilot.enviar()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'">
        </textarea>
        <button onclick="SmartCopilot.enviar()" id="copilot-send-btn"
          style="width:38px;height:38px;border-radius:8px;border:none;cursor:pointer;
                 background:linear-gradient(135deg,#1E6FFF,#2D84FF);color:#fff;
                 font-size:16px;display:flex;align-items:center;justify-content:center;
                 flex-shrink:0;transition:transform .12s"
          onmouseover="this.style.transform='scale(1.08)'"
          onmouseout="this.style.transform='scale(1)'">
          ➤
        </button>
      </div>
    `;

    document.body.appendChild(sidebar);
  }

  function _getAtalhos() {
    if (_perfil === 'admin') {
      return [
        { label: 'Risco de carteira',     q: 'Quais clientes estão em maior risco de carteira agora?' },
        { label: 'Motivos de perda',       q: 'Quais são os principais motivos de perda este mês e o que fazer?' },
        { label: 'Pipeline crítico',       q: 'Quais negócios preciso priorizar para fechar este mês?' },
        { label: 'Performance do time',    q: 'Como está a performance de cada vendedor?' },
        { label: 'Leads parados',          q: 'Quais leads estão parados há mais de 7 dias?' },
        { label: 'Forecast',               q: 'Qual é a previsão de receita para este mês com base no pipeline?' },
      ];
    } else {
      return [
        { label: 'Follow-up WhatsApp',  q: 'Escreva uma mensagem de follow-up para o meu lead em negociação' },
        { label: 'Resumo do lead',      q: 'Resuma o histórico do lead mais importante da minha carteira' },
        { label: 'Próxima ação',        q: 'Qual lead devo priorizar agora e o que fazer?' },
        { label: 'Objeção de preço',    q: 'Como responder quando o cliente diz que o preço está alto?' },
        { label: 'Minha performance',   q: 'Como está minha taxa de conversão este mês?' },
      ];
    }
  }

  // ── ENVIO DE MENSAGEM ─────────────────────────────────────────────────────
  async function enviar() {
    const input = document.getElementById('copilot-input');
    const texto = input?.value.trim();
    if (!texto || _processando) return;

    input.value = '';
    input.style.height = '42px';

    await perguntar(texto);
  }

  async function perguntar(pergunta) {
    if (_processando) return;
    _processando = true;

    // Adiciona mensagem do usuário
    _adicionarMensagem('user', pergunta);
    _adicionarTyping();

    // Atualiza contexto no header
    _atualizarContexto(`Analisando: "${pergunta.slice(0, 50)}${pergunta.length > 50 ? '...' : ''}"`);

    try {
      // Coleta dados do CRM (IndexedDB ou estado global)
      const dadosCRM = await _coletarDadosCRM();
      const systemPrompt = _buildSystemPrompt(dadosCRM);

      // Monta histórico para o contexto
      const messages = [
        ..._historico.slice(-MAX_HIST).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: pergunta }
      ];

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1000,
          system:     systemPrompt,
          messages
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || `HTTP ${response.status}`);
      }

      const data   = await response.json();
      const resposta = data.content?.[0]?.text || 'Não obtive resposta.';

      // Salva no histórico
      _historico.push({ role: 'user',      content: pergunta });
      _historico.push({ role: 'assistant', content: resposta });
      if (_historico.length > MAX_HIST * 2) {
        _historico = _historico.slice(-MAX_HIST * 2);
      }

      _removerTyping();
      _adicionarMensagem('bot', resposta);

    } catch (error) {
      _removerTyping();

      let msgErro = 'Erro ao conectar com o Copilot.';
      if (!navigator.onLine) {
        msgErro = '📶 Sem conexão. O Copilot requer internet. Reconecte e tente novamente.';
      } else if (error.message.includes('401')) {
        msgErro = '🔑 Chave de API inválida. Verifique as configurações.';
      }

      _adicionarMensagem('bot', msgErro);
      console.error('[Copilot] Erro:', error.message);
    }

    _processando = false;
    _atualizarContexto(_getContextoLabel());
  }

  // ── COLETA DE DADOS DO CRM ────────────────────────────────────────────────
  async function _coletarDadosCRM() {
    const dados = {};

    try {
      // Tenta IndexedDB primeiro (mais rápido, offline-friendly)
      if (window.SmartOfflineDB) {
        dados.leads    = await SmartOfflineDB.Leads.getAll(_perfil, _vendedorNome);
        dados.clientes = await SmartOfflineDB.Clientes.getAll(_perfil, _vendedorNome);
        dados.produtos = await SmartOfflineDB.Produtos.getAll();
      }

      // Complementa com variáveis globais do CRM se disponíveis
      if (window.leads)        dados.leads        = dados.leads?.length ? dados.leads : window.leads;
      if (window.vendedores)   dados.vendedores   = window.vendedores;
      if (window.propostas)    dados.propostas    = window.propostas;
      if (window.contratos)    dados.contratos    = window.contratos;
      if (window.perdaData)    dados.perdaData    = window.perdaData;
      if (window.metas_data)   dados.metas        = window.metas_data;
      if (window.forecast_data)dados.forecast     = window.forecast_data;
      if (window.clientesRisco)dados.clientesRisco= window.clientesRisco;

      // Filtra dados por perfil — NUNCA expõe dados de outros vendedores para um vendedor
      if (_perfil === 'vendedor' && _vendedorNome) {
        if (dados.leads)     dados.leads     = dados.leads.filter(l => l.vend === _vendedorNome);
        if (dados.propostas) dados.propostas = dados.propostas.filter(p => p.vend === _vendedorNome);
        if (dados.vendedores)dados.vendedores= dados.vendedores.filter(v => v.nome === _vendedorNome);
        if (dados.metas)     dados.metas     = dados.metas.filter(m => m.nome === _vendedorNome);

        // Remove dados sensíveis de outros vendedores
        delete dados.clientesRisco;
        delete dados.forecast;
      }

      // Resume os dados para não exceder o contexto (muito JSON mata performance)
      return _resumirDados(dados);

    } catch (error) {
      console.warn('[Copilot] Erro ao coletar dados:', error.message);
      return { erro: 'Dados parcialmente disponíveis', mensagem: error.message };
    }
  }

  function _resumirDados(dados) {
    const resumo = {};

    // Leads — mantém campos essenciais, limita quantidade
    if (dados.leads?.length) {
      resumo.leads = dados.leads.slice(0, 50).map(l => ({
        id: l.id, nome: l.nome, vend: l.vend, tipo: l.tipo,
        etapa: l.etxt || l.etapa, val: l.val, orig: l.orig,
        prod: l.prod, ult: l.ult, obs: l.obs?.slice(0, 100)
      }));
      resumo.total_leads = dados.leads.length;
    }

    // Vendedores
    if (dados.vendedores) resumo.vendedores = dados.vendedores;

    // Motivos de perda
    if (dados.perdaData) resumo.perdas = dados.perdaData;

    // Forecast
    if (dados.forecast) resumo.forecast = dados.forecast;

    // Metas
    if (dados.metas) resumo.metas = dados.metas;

    // Propostas
    if (dados.propostas?.length) {
      resumo.propostas = dados.propostas.slice(0, 20).map(p => ({
        id: p.id, cliente: p.cliente, vend: p.vend,
        val: p.val, status: p.status, prob: p.prob
      }));
    }

    // Contratos
    if (dados.contratos?.length) {
      resumo.contratos = dados.contratos.map(c => ({
        cliente: c.cliente, val: c.val, vencDias: c.vencDias, status: c.status
      }));
    }

    // Clientes em risco
    if (dados.clientesRisco) resumo.clientes_em_risco = dados.clientesRisco;

    return resumo;
  }

  // ── HELPERS DE UI ─────────────────────────────────────────────────────────
  function _adicionarMensagem(role, texto) {
    const container = document.getElementById('copilot-msgs');
    if (!container) return;

    const isBot = role === 'bot';
    const hora  = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const div = document.createElement('div');
    div.style.cssText = `display:flex;flex-direction:column;align-items:${isBot ? 'flex-start' : 'flex-end'};`;

    // Converte markdown simples para HTML
    const htmlTexto = texto
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>')
      .replace(/`(.*?)`/g, '<code style="background:rgba(30,111,255,.15);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:11px">$1</code>')
      .replace(/\n/g, '<br>');

    div.innerHTML = `
      <div style="max-width:88%;padding:10px 13px;border-radius:12px;font-size:13px;
                  line-height:1.55;
                  ${isBot
                    ? 'background:var(--bg3,#0D1530);color:var(--white,#E8EEFF);border-bottom-left-radius:3px'
                    : 'background:linear-gradient(135deg,#1E6FFF,#2D84FF);color:#fff;border-bottom-right-radius:3px'}">
        ${htmlTexto}
      </div>
      <div style="font-size:9px;color:var(--muted,#6B7299);margin-top:3px;padding:0 2px">
        ${isBot ? 'Copilot' : 'Você'} · ${hora}
      </div>
    `;

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function _adicionarTyping() {
    const container = document.getElementById('copilot-msgs');
    if (!container) return;

    const div = document.createElement('div');
    div.id = 'copilot-typing';
    div.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;';
    div.innerHTML = `
      <div style="background:var(--bg3,#0D1530);padding:10px 14px;border-radius:12px;
                  border-bottom-left-radius:3px">
        <div style="display:flex;gap:4px;align-items:center">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--muted,#6B7299);
                       animation:cop-bounce .8s infinite"></span>
          <span style="width:6px;height:6px;border-radius:50%;background:var(--muted,#6B7299);
                       animation:cop-bounce .8s .15s infinite"></span>
          <span style="width:6px;height:6px;border-radius:50%;background:var(--muted,#6B7299);
                       animation:cop-bounce .8s .3s infinite"></span>
        </div>
      </div>
    `;

    // Injeta animação se ainda não existe
    if (!document.getElementById('cop-anim-style')) {
      const style = document.createElement('style');
      style.id = 'cop-anim-style';
      style.textContent = `@keyframes cop-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}`;
      document.head.appendChild(style);
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function _removerTyping() {
    document.getElementById('copilot-typing')?.remove();
  }

  function _atualizarContexto(label) {
    const ctx = document.getElementById('copilot-ctx');
    if (ctx) ctx.textContent = `📍 ${label}`;
  }

  function _getContextoLabel() {
    return _perfil === 'admin'
      ? 'Visão completa — todos os vendedores e leads'
      : `Sua carteira — ${_vendedorNome}`;
  }

  // ── BOTÃO FLUTUANTE ───────────────────────────────────────────────────────
  function _renderBotaoFlutuante() {
    document.getElementById('copilot-fab')?.remove();

    const fab = document.createElement('button');
    fab.id = 'copilot-fab';
    fab.title = 'Abrir Copilot IA';
    fab.style.cssText = `
      position:fixed;bottom:24px;left:24px;z-index:695;
      width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;
      background:linear-gradient(135deg,#1E6FFF,#0A3BAA);color:#fff;
      font-size:22px;display:flex;align-items:center;justify-content:center;
      box-shadow:0 0 24px rgba(30,111,255,.55);transition:transform .18s,box-shadow .18s;
      font-family:'Inter',sans-serif;
    `;
    fab.textContent = '🤖';
    fab.addEventListener('click', toggle);
    fab.addEventListener('mouseover', () => {
      fab.style.transform = 'scale(1.08)';
      fab.style.boxShadow = '0 0 36px rgba(30,111,255,.75)';
    });
    fab.addEventListener('mouseout', () => {
      fab.style.transform = 'scale(1)';
      fab.style.boxShadow = '0 0 24px rgba(30,111,255,.55)';
    });

    document.body.appendChild(fab);
  }

  // ── API PÚBLICA ───────────────────────────────────────────────────────────
  function init(perfil = 'admin', vendedorNome = null) {
    _perfil       = perfil;
    _vendedorNome = vendedorNome;
    _historico    = [];

    _renderBotaoFlutuante();
    _renderSidebar();

    console.log('[Copilot] Inicializado — perfil:', perfil, vendedorNome || '');
  }

  function abrir() {
    const sidebar = document.getElementById('copilot-sidebar');
    if (!sidebar) return;
    sidebar.style.transform = 'translateX(0)';
    _aberto = true;
    _atualizarContexto(_getContextoLabel());
  }

  function fechar() {
    const sidebar = document.getElementById('copilot-sidebar');
    if (!sidebar) return;
    sidebar.style.transform = 'translateX(100%)';
    _aberto = false;
  }

  function toggle() {
    _aberto ? fechar() : abrir();
  }

  function limparHistorico() {
    _historico = [];
    const msgs = document.getElementById('copilot-msgs');
    if (msgs) msgs.innerHTML = '';
    _adicionarMensagem('bot', 'Histórico limpo. Como posso ajudar?');
  }

  return {
    init, abrir, fechar, toggle, enviar, perguntar, limparHistorico
  };

})();

window.SmartCopilot = SmartCopilot;
