/**
 * Smart Automation CRM — Offline Database
 * Motor: IndexedDB via wrapper assíncrono
 * Tabelas: clientes, produtos, leads, pedidos_offline, notificacoes, sync_log
 */

const SmartOfflineDB = (() => {

  const DB_NAME    = 'SmartCRM_OfflineDB';
  const DB_VERSION = 1;
  let   db         = null;

  // ── SCHEMA DAS STORES ───────────────────────────────────────────────────────
  const STORES = {
    clientes: {
      keyPath: 'id',
      indexes: [
        { name: 'nome',      field: 'nome',      unique: false },
        { name: 'vendedor',  field: 'vendedor',  unique: false },
        { name: 'status',    field: 'status',    unique: false },
        { name: 'updatedAt', field: 'updatedAt', unique: false },
      ]
    },
    produtos: {
      keyPath: 'id',
      indexes: [
        { name: 'categoria', field: 'categoria', unique: false },
        { name: 'ativo',     field: 'ativo',     unique: false },
      ]
    },
    leads: {
      keyPath: 'id',
      indexes: [
        { name: 'vendedor',  field: 'vendedor',  unique: false },
        { name: 'etapa',     field: 'etapa',     unique: false },
        { name: 'updatedAt', field: 'updatedAt', unique: false },
      ]
    },
    pedidos_offline: {
      keyPath: 'uuid',
      indexes: [
        { name: 'status',    field: 'status',    unique: false },
        { name: 'timestamp', field: 'timestamp', unique: false },
        { name: 'tipo',      field: 'tipo',      unique: false },
      ]
    },
    notificacoes: {
      keyPath: 'id',
      indexes: [
        { name: 'lida',       field: 'lida',       unique: false },
        { name: 'destino',    field: 'destino',    unique: false },
        { name: 'tipo',       field: 'tipo',       unique: false },
        { name: 'createdAt',  field: 'createdAt',  unique: false },
      ]
    },
    sync_log: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'operacao',  field: 'operacao',  unique: false },
        { name: 'status',    field: 'status',    unique: false },
        { name: 'timestamp', field: 'timestamp', unique: false },
      ]
    },
    config_usuario: {
      keyPath: 'chave',
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // INICIALIZAÇÃO DO BANCO
  // ═══════════════════════════════════════════════════════════════════════════
  async function init() {
    if (db) return db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        console.log('[OfflineDB] Criando/atualizando schema v', DB_VERSION);

        Object.entries(STORES).forEach(([storeName, config]) => {
          if (!database.objectStoreNames.contains(storeName)) {
            const storeConfig = { keyPath: config.keyPath };
            if (config.autoIncrement) storeConfig.autoIncrement = true;

            const store = database.createObjectStore(storeName, storeConfig);

            (config.indexes || []).forEach(idx => {
              store.createIndex(idx.name, idx.field, { unique: idx.unique });
            });

            console.log('[OfflineDB] Store criada:', storeName);
          }
        });
      };

      request.onsuccess = (event) => {
        db = event.target.result;
        console.log('[OfflineDB] Banco aberto com sucesso.');
        resolve(db);
      };

      request.onerror = (event) => {
        console.error('[OfflineDB] Erro ao abrir banco:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OPERAÇÕES CRUD GENÉRICAS
  // ═══════════════════════════════════════════════════════════════════════════
  async function _tx(storeName, mode, fn) {
    const database = await init();
    return new Promise((resolve, reject) => {
      const tx    = database.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req   = fn(store);

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    return _tx(storeName, 'readonly', store => store.get(key));
  }

  async function getAll(storeName, indexName, value) {
    const database = await init();
    return new Promise((resolve, reject) => {
      const tx    = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req   = indexName
        ? store.index(indexName).getAll(value)
        : store.getAll();

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function put(storeName, data) {
    data.updatedAt = new Date().toISOString();
    return _tx(storeName, 'readwrite', store => store.put(data));
  }

  async function putBatch(storeName, items) {
    const database = await init();
    return new Promise((resolve, reject) => {
      const tx    = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const now   = new Date().toISOString();

      items.forEach(item => {
        item.updatedAt = now;
        store.put(item);
      });

      tx.oncomplete = () => resolve(items.length);
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  async function remove(storeName, key) {
    return _tx(storeName, 'readwrite', store => store.delete(key));
  }

  async function count(storeName) {
    return _tx(storeName, 'readonly', store => store.count());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEADS — CRUD com controle de perfil
  // ═══════════════════════════════════════════════════════════════════════════
  const Leads = {
    async getAll(perfil = null, vendedorNome = null) {
      let todos = await getAll('leads');
      // Filtra por vendedor se perfil for 'vendedor'
      if (perfil === 'vendedor' && vendedorNome) {
        todos = todos.filter(l => l.vend === vendedorNome);
      }
      return todos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },

    async getById(id) {
      return get('leads', id);
    },

    async save(lead) {
      if (!lead.id) lead.id = `local-${crypto.randomUUID()}`;
      lead.syncStatus = lead.syncStatus || 'pending';
      await put('leads', lead);
      return lead;
    },

    async getPendentes() {
      const todos = await getAll('leads');
      return todos.filter(l => l.syncStatus === 'pending');
    },

    async marcarSincronizado(id) {
      const lead = await get('leads', id);
      if (lead) {
        lead.syncStatus = 'synced';
        await put('leads', lead);
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CLIENTES
  // ═══════════════════════════════════════════════════════════════════════════
  const Clientes = {
    async getAll(perfil = null, vendedorNome = null) {
      let todos = await getAll('clientes');
      if (perfil === 'vendedor' && vendedorNome) {
        todos = todos.filter(c => c.vendedor === vendedorNome);
      }
      return todos;
    },

    async getById(id) { return get('clientes', id); },
    async save(cliente) { return put('clientes', cliente); },
    async saveMany(clientes) { return putBatch('clientes', clientes); },
    async count() { return count('clientes'); }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUTOS
  // ═══════════════════════════════════════════════════════════════════════════
  const Produtos = {
    async getAll() { return getAll('produtos'); },
    async getById(id) { return get('produtos', id); },
    async save(produto) { return put('produtos', produto); },
    async saveMany(produtos) { return putBatch('produtos', produtos); },

    async getTabela() {
      const todos = await getAll('produtos');
      return todos.filter(p => p.ativo !== false);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // FILA DE PEDIDOS OFFLINE
  // ═══════════════════════════════════════════════════════════════════════════
  const PedidosOffline = {
    /**
     * Enfileira um pedido criado sem conexão
     * @param {Object} pedido - Dados do pedido
     * @param {string} tipo   - 'novo_lead' | 'atualizar_lead' | 'novo_pedido' | 'proposta'
     */
    async enfileirar(pedido, tipo = 'novo_pedido') {
      const item = {
        uuid:      crypto.randomUUID(),
        tipo,
        payload:   pedido,
        status:    'pendente',    // pendente | processando | enviado | erro
        tentativas: 0,
        maxTentativas: 3,
        timestamp:  Date.now(),
        createdAt:  new Date().toISOString(),
        error:      null
      };

      await put('pedidos_offline', item);
      console.log('[OfflineDB] Pedido enfileirado:', item.uuid, tipo);

      // Registra no log
      await SyncLog.registrar('enfileirar', tipo, 'pendente', { uuid: item.uuid });

      return item;
    },

    async getPendentes() {
      const todos = await getAll('pedidos_offline');
      return todos
        .filter(p => p.status === 'pendente' && p.tentativas < p.maxTentativas)
        .sort((a, b) => a.timestamp - b.timestamp);
    },

    async marcarEnviado(uuid) {
      const item = await get('pedidos_offline', uuid);
      if (item) {
        item.status = 'enviado';
        item.enviadoEm = new Date().toISOString();
        await put('pedidos_offline', item);
      }
    },

    async marcarErro(uuid, error) {
      const item = await get('pedidos_offline', uuid);
      if (item) {
        item.tentativas++;
        item.error = error;
        item.status = item.tentativas >= item.maxTentativas ? 'falhou' : 'pendente';
        await put('pedidos_offline', item);
      }
    },

    async limparEnviados() {
      const todos = await getAll('pedidos_offline');
      const enviados = todos.filter(p => p.status === 'enviado');
      await Promise.all(enviados.map(p => remove('pedidos_offline', p.uuid)));
      return enviados.length;
    },

    async count() {
      const pendentes = await this.getPendentes();
      return pendentes.length;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // LOG DE SINCRONIZAÇÃO
  // ═══════════════════════════════════════════════════════════════════════════
  const SyncLog = {
    async registrar(operacao, entidade, status, detalhes = {}) {
      const log = {
        operacao,
        entidade,
        status,
        detalhes,
        timestamp: Date.now(),
        createdAt: new Date().toISOString()
      };
      await put('sync_log', log);
    },

    async getRecentes(limite = 50) {
      const todos = await getAll('sync_log');
      return todos
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limite);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURAÇÕES DO USUÁRIO
  // ═══════════════════════════════════════════════════════════════════════════
  const Config = {
    async get(chave) {
      const item = await get('config_usuario', chave);
      return item ? item.valor : null;
    },
    async set(chave, valor) {
      return put('config_usuario', { chave, valor });
    },
    async getAll() {
      return getAll('config_usuario');
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SINCRONIZADOR — envia fila para Apps Script / Protheus
  // ═══════════════════════════════════════════════════════════════════════════
  const Sincronizador = {
    APPS_SCRIPT_URL: window.__CRM_CONFIG__?.appsScriptUrl || '',
    PROTHEUS_URL:    window.__CRM_CONFIG__?.protheusUrl    || '',
    sincronizando:   false,

    /**
     * Processa todos os pedidos pendentes na fila
     * Chamado automaticamente ao reconectar (online event)
     */
    async processarFila() {
      if (this.sincronizando) {
        console.log('[Sync] Sincronização já em andamento, aguardando...');
        return;
      }

      const pendentes = await PedidosOffline.getPendentes();
      if (!pendentes.length) {
        console.log('[Sync] Nenhum item pendente na fila.');
        return { enviados: 0, erros: 0 };
      }

      console.log('[Sync] Iniciando sincronização:', pendentes.length, 'itens');
      this.sincronizando = true;

      const resultado = { enviados: 0, erros: 0, detalhes: [] };

      // Dispara notificação de início
      NotificacoesUI.mostrar('Sincronizando dados offline...', 'info');

      for (const item of pendentes) {
        try {
          await this._enviarItem(item);
          await PedidosOffline.marcarEnviado(item.uuid);
          await SyncLog.registrar('sync_sucesso', item.tipo, 'enviado', { uuid: item.uuid });
          resultado.enviados++;
          resultado.detalhes.push({ uuid: item.uuid, status: 'ok' });
        } catch (error) {
          await PedidosOffline.marcarErro(item.uuid, error.message);
          await SyncLog.registrar('sync_erro', item.tipo, 'erro', { uuid: item.uuid, error: error.message });
          resultado.erros++;
          resultado.detalhes.push({ uuid: item.uuid, status: 'erro', error: error.message });
          console.error('[Sync] Erro ao enviar:', item.uuid, error);
        }
      }

      this.sincronizando = false;

      // Limpa enviados com sucesso
      await PedidosOffline.limparEnviados();

      const msg = `Sincronização concluída: ${resultado.enviados} enviados, ${resultado.erros} erros.`;
      console.log('[Sync]', msg);
      NotificacoesUI.mostrar(msg, resultado.erros ? 'warning' : 'success');

      // Dispara evento para o CRM atualizar a UI
      window.dispatchEvent(new CustomEvent('crm:sync-completo', { detail: resultado }));

      return resultado;
    },

    async _enviarItem(item) {
      const rota = this._getRota(item.tipo);

      const response = await fetch(rota.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acao:    rota.acao,
          dados:   item.payload,
          uuid:    item.uuid,
          offline: true
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },

    _getRota(tipo) {
      const rotas = {
        'novo_lead':      { url: this.APPS_SCRIPT_URL, acao: 'inserirLead' },
        'atualizar_lead': { url: this.APPS_SCRIPT_URL, acao: 'atualizarLead' },
        'novo_pedido':    { url: this.APPS_SCRIPT_URL, acao: 'inserirPedido' },
        'proposta':       { url: this.APPS_SCRIPT_URL, acao: 'salvarProposta' },
        // Rotas Protheus
        'pedido_protheus': { url: `${this.PROTHEUS_URL}/api/pedidos`, acao: 'POST' },
      };
      return rotas[tipo] || { url: this.APPS_SCRIPT_URL, acao: tipo };
    },

    /**
     * Carrega dados do servidor para o IndexedDB (carga inicial / refresh)
     */
    async carregarDadosServidor(perfil, vendedorNome) {
      if (!navigator.onLine) {
        console.log('[Sync] Offline — usando dados locais.');
        return false;
      }

      try {
        const params = new URLSearchParams({
          acao: 'carregarDados',
          perfil: perfil || 'admin',
          vendedor: vendedorNome || ''
        });

        const response = await fetch(`${this.APPS_SCRIPT_URL}?${params}`, {
          signal: AbortSignal.timeout(20000)
        });

        if (!response.ok) throw new Error('Servidor indisponível');

        const dados = await response.json();

        // Salva no IndexedDB
        if (dados.clientes?.length)  await Clientes.saveMany(dados.clientes);
        if (dados.produtos?.length)  await Produtos.saveMany(dados.produtos);
        if (dados.leads?.length)     await Leads.saveMany?.(dados.leads) || await putBatch('leads', dados.leads);

        await SyncLog.registrar('carga_servidor', 'todos', 'ok', {
          clientes: dados.clientes?.length,
          produtos: dados.produtos?.length,
          leads: dados.leads?.length
        });

        console.log('[Sync] Dados carregados do servidor:', {
          clientes: dados.clientes?.length,
          produtos: dados.produtos?.length,
          leads: dados.leads?.length
        });

        return true;
      } catch (error) {
        console.warn('[Sync] Falha ao carregar servidor, usando local:', error.message);
        return false;
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CLIENTE PROTHEUS — integração REST com ERP
  // ═══════════════════════════════════════════════════════════════════════════
  const ProtheusClient = {
    BASE_URL: window.__CRM_CONFIG__?.protheusUrl || '',
    TOKEN:    window.__CRM_CONFIG__?.protheusToken || '',

    _headers() {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.TOKEN}`,
        'X-CRM-Source': 'SmartAutomation'
      };
    },

    /**
     * POST de pedido de venda para o Protheus
     * Monta no padrão REST do Protheus Protheus (módulo MATA140)
     */
    async postPedido(pedido) {
      if (!navigator.onLine) {
        console.log('[Protheus] Offline — enfileirando pedido:', pedido.id);
        return PedidosOffline.enfileirar(pedido, 'pedido_protheus');
      }

      const payload = {
        codigo_empresa: pedido.codigoEmpresa || '01',
        codigo_filial:  pedido.codigoFilial  || '0101',
        pedido: {
          tipo:            'N',
          cliente:         pedido.cnpjCliente,
          loja:            pedido.loja || '01',
          tabela_preco:    pedido.tabelaPreco || '001',
          condicao_pagto:  pedido.condicaoPagto || '030',
          data_entrega:    pedido.dataEntrega,
          itens: (pedido.itens || []).map(item => ({
            produto:    item.codigoProduto,
            quantidade: item.quantidade,
            preco:      item.preco,
            desconto:   item.desconto || 0
          })),
          observacao: pedido.observacao || '',
          vendedor:   pedido.codigoVendedor || ''
        }
      };

      try {
        const response = await fetch(`${this.BASE_URL}/api/v1/pedidos`, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`Protheus ${response.status}: ${errBody}`);
        }

        const resultado = await response.json();
        await SyncLog.registrar('post_protheus', 'pedido', 'ok', resultado);
        return resultado;

      } catch (error) {
        console.error('[Protheus] Erro ao enviar pedido:', error.message);
        // Enfileira para tentativa posterior
        await PedidosOffline.enfileirar({ ...pedido, _protheusError: error.message }, 'pedido_protheus');
        throw error;
      }
    },

    /**
     * GET de clientes do Protheus → salva no IndexedDB
     */
    async getClientes(filtros = {}) {
      if (!navigator.onLine) {
        console.log('[Protheus] Offline — lendo clientes do IndexedDB');
        return Clientes.getAll();
      }

      const params = new URLSearchParams({
        empresa: filtros.empresa || '01',
        filial:  filtros.filial  || '0101',
        limite:  filtros.limite  || 500,
        pagina:  filtros.pagina  || 1,
        ativo:   'S'
      });

      try {
        const response = await fetch(`${this.BASE_URL}/api/v1/clientes?${params}`, {
          headers: this._headers(),
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const { dados } = await response.json();

        // Normaliza para o formato do CRM
        const clientesNormalizados = (dados || []).map(c => ({
          id:       c.A1_COD + c.A1_LOJA,
          nome:     c.A1_NOME,
          cnpj:     c.A1_CGC,
          telefone: c.A1_TEL,
          email:    c.A1_EMAIL,
          cidade:   c.A1_MUN,
          estado:   c.A1_EST,
          vendedor: c.A1_VEND,
          limite:   c.A1_LC,
          origem:   'protheus'
        }));

        // Salva/atualiza no IndexedDB
        if (clientesNormalizados.length) {
          await Clientes.saveMany(clientesNormalizados);
          console.log('[Protheus] Clientes sincronizados:', clientesNormalizados.length);
        }

        return clientesNormalizados;

      } catch (error) {
        console.warn('[Protheus] Falha ao buscar clientes, usando local:', error.message);
        return Clientes.getAll();
      }
    },

    /**
     * GET de produtos do Protheus → salva no IndexedDB
     */
    async getProdutos(filtros = {}) {
      if (!navigator.onLine) {
        return Produtos.getAll();
      }

      const params = new URLSearchParams({
        empresa: filtros.empresa || '01',
        filial:  filtros.filial  || '0101',
        tipo:    filtros.tipo    || 'PA', // Produto Acabado
        ativo:   'S'
      });

      try {
        const response = await fetch(`${this.BASE_URL}/api/v1/produtos?${params}`, {
          headers: this._headers(),
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const { dados } = await response.json();

        const produtosNormalizados = (dados || []).map(p => ({
          id:        p.B1_COD,
          nome:      p.B1_DESC,
          unidade:   p.B1_UM,
          preco:     p.B1_PRV1 || 0,
          custo:     p.B1_CUSTD || 0,
          estoque:   p.B2_QATU  || 0,
          categoria: p.BM_GRUPO,
          ativo:     p.B1_MSBLQL !== '1',
          origem:    'protheus'
        }));

        if (produtosNormalizados.length) {
          await Produtos.saveMany(produtosNormalizados);
          console.log('[Protheus] Produtos sincronizados:', produtosNormalizados.length);
        }

        return produtosNormalizados;

      } catch (error) {
        console.warn('[Protheus] Falha ao buscar produtos, usando local:', error.message);
        return Produtos.getAll();
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTIFICAÇÕES UI (helper interno)
  // ═══════════════════════════════════════════════════════════════════════════
  const NotificacoesUI = {
    mostrar(msg, tipo = 'info') {
      window.dispatchEvent(new CustomEvent('crm:toast', { detail: { msg, tipo } }));
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // LISTENER: online → processa fila automaticamente
  // ═══════════════════════════════════════════════════════════════════════════
  window.addEventListener('online', async () => {
    console.log('[OfflineDB] Conexão restaurada — iniciando sincronização...');
    window.dispatchEvent(new CustomEvent('crm:online'));

    // Pequena espera para garantir que a rede está estável
    await new Promise(r => setTimeout(r, 2000));

    const pendentes = await PedidosOffline.count();
    if (pendentes > 0) {
      await Sincronizador.processarFila();
    }
  });

  window.addEventListener('offline', () => {
    console.log('[OfflineDB] Conexão perdida — modo offline ativo.');
    window.dispatchEvent(new CustomEvent('crm:offline'));
  });

  // Recebe mensagem do Service Worker para processar fila
  navigator.serviceWorker?.addEventListener('message', async (event) => {
    if (event.data?.type === 'PROCESS_OFFLINE_QUEUE') {
      await Sincronizador.processarFila();
    }
    if (event.data?.type === 'QUEUE_OFFLINE_REQUEST') {
      const { payload } = event.data;
      await PedidosOffline.enfileirar(payload, payload.tipo || 'request');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    init,
    Leads,
    Clientes,
    Produtos,
    PedidosOffline,
    SyncLog,
    Config,
    Sincronizador,
    ProtheusClient,

    // Helpers
    isOnline: () => navigator.onLine,
    isOffline: () => !navigator.onLine,

    // Conta total de pendentes para badge UI
    async totalPendentes() {
      const leads = (await Leads.getPendentes()).length;
      const pedidos = await PedidosOffline.count();
      return leads + pedidos;
    }
  };
})();

// Exporta globalmente
window.SmartOfflineDB = SmartOfflineDB;

// Auto-inicializa
SmartOfflineDB.init().catch(console.error);
