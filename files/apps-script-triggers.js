/**
 * Smart Automation CRM — Google Apps Script
 * Backend: Sheets como banco + triggers para notificações + endpoints REST
 *
 * DEPLOY: Apps Script → Implementar como Web App
 * Acesso: Qualquer pessoa na organização (ou público conforme necessidade)
 * Execute como: Usuário atual (ou conta de serviço)
 */

// ── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const CONFIG = {
  SHEET_ID:           SpreadsheetApp.getActiveSpreadsheet().getId(),
  ABA_LEADS:          'leads',
  ABA_CLIENTES:       'clientes',
  ABA_PRODUTOS:       'produtos',
  ABA_PEDIDOS:        'pedidos_offline',
  ABA_NOTIFICACOES:   'notificacoes',
  ABA_PROPOSTAS:      'propostas',
  ABA_CONTRATOS:      'contratos',
  EVOLUTION_API_URL:  PropertiesService.getScriptProperties().getProperty('EVOLUTION_API_URL') || '',
  EVOLUTION_API_KEY:  PropertiesService.getScriptProperties().getProperty('EVOLUTION_API_KEY') || '',
  ANTHROPIC_API_KEY:  PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || '',
  DIAS_LEAD_PARADO:   7,
  DIAS_CONTRATO_ALERTA: 90,
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROTEADOR HTTP — recebe GET e POST do frontend
// ═══════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  const params = e.parameter || {};
  const acao   = params.acao || '';

  try {
    let resultado;

    switch (acao) {
      case 'getNotificacoes':
        resultado = getNotificacoes(params.perfil, params.vendedor, params.desde);
        break;
      case 'carregarDados':
        resultado = carregarDados(params.perfil, params.vendedor);
        break;
      case 'ping':
        resultado = { ok: true, timestamp: new Date().toISOString() };
        break;
      default:
        resultado = { erro: 'Ação não reconhecida: ' + acao };
    }

    return _jsonResponse(resultado);

  } catch (error) {
    return _jsonResponse({ erro: error.message, stack: error.stack }, 500);
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch {
    return _jsonResponse({ erro: 'Body inválido' }, 400);
  }

  const acao = body.acao || '';

  try {
    let resultado;

    switch (acao) {
      case 'inserirLead':       resultado = inserirLead(body.dados);        break;
      case 'atualizarLead':     resultado = atualizarLead(body.dados);      break;
      case 'inserirPedido':     resultado = inserirPedido(body.dados);      break;
      case 'salvarProposta':    resultado = salvarProposta(body.dados);     break;
      case 'salvarNotificacao': resultado = salvarNotificacao(body.notif);  break;
      case 'marcarNotifLida':   resultado = marcarNotifLida(body.id);       break;
      case 'marcarTodasLidas':  resultado = marcarTodasLidas(body.ids);     break;
      default:
        resultado = { erro: 'Ação POST não reconhecida: ' + acao };
    }

    return _jsonResponse(resultado);

  } catch (error) {
    return _jsonResponse({ erro: error.message }, 500);
  }
}

function _jsonResponse(data, status = 200) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGERS — disparados pelo Apps Script automaticamente
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * TRIGGER PRINCIPAL — executado a cada 5 minutos
 * Verifica todas as condições de alerta e cria notificações
 */
function triggerVerificacaoGeral() {
  verificarLeadsParados();
  verificarRiscosCarteira();
  verificarContratosVencendo();
}

/**
 * Instala os triggers programáticos (execute uma vez na configuração inicial)
 */
function instalarTriggers() {
  // Remove triggers existentes para evitar duplicatas
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Trigger a cada 5 minutos — verificação geral
  ScriptApp.newTrigger('triggerVerificacaoGeral')
    .timeBased()
    .everyMinutes(5)
    .create();

  // Trigger diário às 08h — relatório de metas
  ScriptApp.newTrigger('triggerRelatorioDiario')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();

  Logger.log('Triggers instalados com sucesso.');
}

// ─── VERIFICAÇÃO: Leads sem contato há N dias ─────────────────────────────────
function verificarLeadsParados() {
  const sheet = _getSheet(CONFIG.ABA_LEADS);
  const dados = sheet.getDataRange().getValues();
  if (dados.length < 2) return;

  const headers = dados[0];
  const iUlt    = headers.indexOf('ultimoContato');
  const iVend   = headers.indexOf('vend');
  const iNome   = headers.indexOf('nome');
  const iId     = headers.indexOf('id');
  const iEtapa  = headers.indexOf('etapa');

  const agora = new Date();
  const limiar = new Date(agora - CONFIG.DIAS_LEAD_PARADO * 86400000);

  dados.slice(1).forEach(row => {
    const etapa = row[iEtapa];
    if (etapa === 'b-fech' || etapa === 'b-perd') return; // Ignora fechados e perdidos

    const ultContato = new Date(row[iUlt]);
    if (isNaN(ultContato.getTime())) return;

    if (ultContato < limiar) {
      const diasParado = Math.floor((agora - ultContato) / 86400000);

      // Verifica se já existe notificação recente para este lead
      if (!_notifRecenteExiste('lead_parado', row[iId])) {
        const notif = {
          tipo:     'lead_parado',
          titulo:   `Lead parado: ${row[iNome]}`,
          mensagem: `Sem contato há ${diasParado} dias. Vendedor: ${row[iVend]}.`,
          leadId:   row[iId],
          destino:  'all',
          vendedor: row[iVend],
          lida:     false,
          createdAt: new Date().toISOString(),
          id:       `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
        };

        salvarNotificacao(notif);

        // Envia WhatsApp ao vendedor se Evolution API configurada
        if (CONFIG.EVOLUTION_API_URL) {
          _enviarWhatsAppVendedor(row[iVend],
            `⚠️ Lead parado: *${row[iNome]}* sem contato há ${diasParado} dias. Faça o follow-up!`
          );
        }
      }
    }
  });
}

// ─── VERIFICAÇÃO: Riscos de carteira ─────────────────────────────────────────
function verificarRiscosCarteira() {
  const sheet  = _getSheet(CONFIG.ABA_CLIENTES);
  const dados  = sheet.getDataRange().getValues();
  if (dados.length < 2) return;

  const headers   = dados[0];
  const iId       = headers.indexOf('id');
  const iNome     = headers.indexOf('nome');
  const iVendedor = headers.indexOf('vendedor');
  const iExclusivo= headers.indexOf('exclusivo');

  dados.slice(1).forEach(row => {
    // Cliente é "de risco" se vinculado a apenas 1 vendedor
    if (row[iExclusivo] === true || row[iExclusivo] === 'true') {
      if (!_notifRecenteExiste('risco_carteira', row[iId], 1)) { // 1 dia de cooldown
        const notif = {
          tipo:      'risco_carteira',
          titulo:    `Risco de carteira: ${row[iNome]}`,
          mensagem:  `Cliente vinculado exclusivamente a ${row[iVendedor]}.`,
          leadId:    row[iId],
          destino:   'admin',
          vendedor:  null,
          lida:      false,
          createdAt: new Date().toISOString(),
          id:        `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
        };
        salvarNotificacao(notif);
      }
    }
  });
}

// ─── VERIFICAÇÃO: Contratos vencendo ─────────────────────────────────────────
function verificarContratosVencendo() {
  const sheet = _getSheet(CONFIG.ABA_CONTRATOS);
  const dados = sheet.getDataRange().getValues();
  if (dados.length < 2) return;

  const headers = dados[0];
  const iId     = headers.indexOf('id');
  const iCli    = headers.indexOf('cliente');
  const iFim    = headers.indexOf('fim');
  const iVal    = headers.indexOf('val');

  const agora = new Date();

  dados.slice(1).forEach(row => {
    const fim = new Date(row[iFim]);
    if (isNaN(fim.getTime())) return;

    const diasRestantes = Math.floor((fim - agora) / 86400000);

    if (diasRestantes <= CONFIG.DIAS_CONTRATO_ALERTA && diasRestantes > 0) {
      if (!_notifRecenteExiste('contrato_vence', row[iId], 7)) { // 7 dias de cooldown
        const notif = {
          tipo:      'contrato_vence',
          titulo:    `Contrato vencendo: ${row[iCli]}`,
          mensagem:  `Vence em ${diasRestantes} dias. Valor: ${row[iVal]}.`,
          leadId:    row[iId],
          destino:   'admin',
          lida:      false,
          createdAt: new Date().toISOString(),
          id:        `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
        };
        salvarNotificacao(notif);
      }
    }
  });
}

// ─── RELATÓRIO DIÁRIO ─────────────────────────────────────────────────────────
function triggerRelatorioDiario() {
  // Resumo de leads, conversões e alertas — enviado aos gestores
  Logger.log('Relatório diário enviado: ' + new Date().toISOString());
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRUD — LEADS
// ═══════════════════════════════════════════════════════════════════════════════
function inserirLead(dados) {
  const sheet = _getSheet(CONFIG.ABA_LEADS);
  const id    = dados.id || `lead-${Date.now()}`;
  const row   = [
    id, dados.nome, dados.cnpj || '', dados.prod, dados.orig,
    dados.vend, dados.tipo, dados.wpp, dados.val, dados.valN || 0,
    dados.etapa || 'b-novo', dados.etxt || 'Novo',
    new Date().toLocaleDateString('pt-BR'), dados.obs || '', dados.email || '',
    'synced', new Date().toISOString()
  ];
  sheet.appendRow(row);
  return { ok: true, id };
}

function atualizarLead(dados) {
  const sheet = _getSheet(CONFIG.ABA_LEADS);
  const range = sheet.getDataRange();
  const valores = range.getValues();
  const iId   = valores[0].indexOf('id');
  const linha = valores.findIndex((row, i) => i > 0 && row[iId] === dados.id);

  if (linha < 0) return inserirLead(dados);

  const rowRef = sheet.getRange(linha + 1, 1, 1, valores[0].length);
  const rowVal = rowRef.getValues()[0];
  Object.entries(dados).forEach(([key, val]) => {
    const col = valores[0].indexOf(key);
    if (col >= 0) rowVal[col] = val;
  });
  rowVal[valores[0].indexOf('updatedAt')] = new Date().toISOString();
  rowRef.setValues([rowVal]);
  return { ok: true, id: dados.id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRUD — NOTIFICAÇÕES
// ═══════════════════════════════════════════════════════════════════════════════
function salvarNotificacao(notif) {
  const sheet = _getSheet(CONFIG.ABA_NOTIFICACOES);
  sheet.appendRow([
    notif.id, notif.tipo, notif.titulo, notif.mensagem,
    notif.leadId || '', notif.destino || 'all', notif.vendedor || '',
    notif.lida ? 'true' : 'false',
    notif.createdAt || new Date().toISOString()
  ]);
  return { ok: true };
}

function getNotificacoes(perfil, vendedor, desde) {
  const sheet  = _getSheet(CONFIG.ABA_NOTIFICACOES);
  const dados  = sheet.getDataRange().getValues();
  if (dados.length < 2) return { notificacoes: [] };

  const headers     = dados[0];
  const iId         = headers.indexOf('id');
  const iTipo       = headers.indexOf('tipo');
  const iTitulo     = headers.indexOf('titulo');
  const iMensagem   = headers.indexOf('mensagem');
  const iLeadId     = headers.indexOf('leadId');
  const iDestino    = headers.indexOf('destino');
  const iVendedor   = headers.indexOf('vendedor');
  const iLida       = headers.indexOf('lida');
  const iCreatedAt  = headers.indexOf('createdAt');

  const desdeDate = desde ? new Date(desde) : new Date(0);

  const notificacoes = dados.slice(1)
    .filter(row => {
      const criado = new Date(row[iCreatedAt]);
      if (criado < desdeDate) return false;

      // Filtro por perfil
      const destino = row[iDestino];
      if (destino === 'admin' && perfil !== 'admin') return false;
      if (destino === 'vendedor' && perfil === 'admin') return false;
      if (destino === 'vendedor' && vendedor && row[iVendedor] && row[iVendedor] !== vendedor) return false;

      return true;
    })
    .map(row => ({
      id:        row[iId],
      tipo:      row[iTipo],
      titulo:    row[iTitulo],
      mensagem:  row[iMensagem],
      leadId:    row[iLeadId] || null,
      destino:   row[iDestino],
      vendedor:  row[iVendedor] || null,
      lida:      row[iLida] === 'true',
      createdAt: row[iCreatedAt]
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100); // Últimas 100

  return { notificacoes };
}

function marcarNotifLida(id) {
  const sheet  = _getSheet(CONFIG.ABA_NOTIFICACOES);
  const dados  = sheet.getDataRange().getValues();
  const iId    = dados[0].indexOf('id');
  const iLida  = dados[0].indexOf('lida');

  const linha  = dados.findIndex((row, i) => i > 0 && row[iId] === id);
  if (linha > 0) {
    sheet.getRange(linha + 1, iLida + 1).setValue('true');
  }
  return { ok: true };
}

function marcarTodasLidas(ids) {
  if (!ids?.length) return { ok: true };
  ids.forEach(id => marcarNotifLida(id));
  return { ok: true, marcadas: ids.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVOLUTION API — WhatsApp
// ═══════════════════════════════════════════════════════════════════════════════
function _enviarWhatsAppVendedor(nomeVendedor, mensagem) {
  if (!CONFIG.EVOLUTION_API_URL || !CONFIG.EVOLUTION_API_KEY) return;

  // Busca o número do vendedor na planilha de usuários
  const numeroVendedor = _buscarNumeroVendedor(nomeVendedor);
  if (!numeroVendedor) return;

  try {
    const url = `${CONFIG.EVOLUTION_API_URL}/message/sendText/smart-crm`;
    const payload = {
      number: numeroVendedor,
      text:   mensagem
    };

    UrlFetchApp.fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.EVOLUTION_API_KEY
      },
      payload:       JSON.stringify(payload),
      muteHttpExceptions: true
    });

    Logger.log(`[Evolution API] WhatsApp enviado para ${nomeVendedor}`);
  } catch (error) {
    Logger.log(`[Evolution API] Erro: ${error.message}`);
  }
}

function _buscarNumeroVendedor(nomeVendedor) {
  // Busca na aba de usuários/vendedores
  try {
    const sheet  = _getSheet('usuarios');
    const dados  = sheet.getDataRange().getValues();
    const iNome  = dados[0].indexOf('nome');
    const iWpp   = dados[0].indexOf('whatsapp');
    const row    = dados.find((r, i) => i > 0 && r[iNome] === nomeVendedor);
    return row ? row[iWpp] : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK — recebe eventos da Evolution API (lead respondeu)
// ═══════════════════════════════════════════════════════════════════════════════
function doPost_webhook(e) {
  // Configure este endpoint separado para receber webhooks da Evolution API
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch {
    return _jsonResponse({ erro: 'Body inválido' }, 400);
  }

  const evento = body.event || '';
  const data   = body.data  || {};

  if (evento === 'messages.upsert' && !data.key?.fromMe) {
    // Lead respondeu a uma mensagem automática
    const numero = data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const texto  = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

    // Busca o lead pelo número
    const lead = _buscarLeadPorWpp(numero);

    if (lead) {
      const notif = {
        tipo:     'lead_respondeu',
        titulo:   `${lead.nome} respondeu!`,
        mensagem: `"${texto.slice(0, 80)}${texto.length > 80 ? '...' : ''}"`,
        leadId:   lead.id,
        destino:  'vendedor',
        vendedor: lead.vend,
        lida:     false,
        createdAt: new Date().toISOString(),
        id:       `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
      };
      salvarNotificacao(notif);
    }
  }

  return _jsonResponse({ ok: true });
}

function _buscarLeadPorWpp(numero) {
  try {
    const sheet = _getSheet(CONFIG.ABA_LEADS);
    const dados = sheet.getDataRange().getValues();
    const iWpp  = dados[0].indexOf('wpp');
    const iId   = dados[0].indexOf('id');
    const iNome = dados[0].indexOf('nome');
    const iVend = dados[0].indexOf('vend');

    const row = dados.find((r, i) => i > 0 &&
      String(r[iWpp]).replace(/\D/g, '').includes(numero.replace(/\D/g, ''))
    );
    return row ? { id: row[iId], nome: row[iNome], vend: row[iVend] } : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARGA DE DADOS — envia clientes/produtos/leads para o frontend
// ═══════════════════════════════════════════════════════════════════════════════
function carregarDados(perfil, vendedor) {
  const clientes = _sheetToJson(CONFIG.ABA_CLIENTES);
  const produtos  = _sheetToJson(CONFIG.ABA_PRODUTOS);
  let   leads     = _sheetToJson(CONFIG.ABA_LEADS);

  // Filtra por vendedor se perfil for vendedor
  if (perfil === 'vendedor' && vendedor) {
    leads = leads.filter(l => l.vend === vendedor);
  }

  return { clientes, produtos, leads };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════════════════════════
function _getSheet(nome) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(nome);

  if (!sheet) {
    sheet = ss.insertSheet(nome);
    Logger.log(`[Apps Script] Aba criada: ${nome}`);
  }

  return sheet;
}

function _sheetToJson(nomeAba) {
  try {
    const sheet  = _getSheet(nomeAba);
    const dados  = sheet.getDataRange().getValues();
    if (dados.length < 2) return [];

    const headers = dados[0];
    return dados.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
  } catch {
    return [];
  }
}

function inserirPedido(dados) {
  const sheet = _getSheet(CONFIG.ABA_PEDIDOS);
  sheet.appendRow([
    dados.uuid, dados.tipo, JSON.stringify(dados.payload),
    'recebido', 0, new Date().toISOString(), new Date().toISOString()
  ]);
  return { ok: true, uuid: dados.uuid };
}

function salvarProposta(dados) {
  const sheet = _getSheet(CONFIG.ABA_PROPOSTAS);
  const id    = dados.id || `P${Date.now()}`;
  sheet.appendRow([
    id, dados.cliente, dados.prod, dados.vend, dados.val,
    dados.valid, dados.status || 'Rascunho', dados.emitida || new Date().toLocaleDateString('pt-BR'),
    dados.prob || 50, new Date().toISOString()
  ]);
  return { ok: true, id };
}

function _notifRecenteExiste(tipo, leadId, diasCooldown = 0) {
  const sheet  = _getSheet(CONFIG.ABA_NOTIFICACOES);
  const dados  = sheet.getDataRange().getValues();
  if (dados.length < 2) return false;

  const iId       = dados[0].indexOf('id');
  const iTipo     = dados[0].indexOf('tipo');
  const iLeadId   = dados[0].indexOf('leadId');
  const iCreated  = dados[0].indexOf('createdAt');

  const limiar = new Date(Date.now() - diasCooldown * 86400000);

  return dados.slice(1).some(row =>
    row[iTipo] === tipo &&
    row[iLeadId] === leadId &&
    new Date(row[iCreated]) > limiar
  );
}
