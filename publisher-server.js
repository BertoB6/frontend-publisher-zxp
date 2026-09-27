/* =========================================================
   PUBLISHER SERVER — ZonaXP (versão API 2.0)
   ---------------------------------------------------------
   - Login fixo (Fase 1)
   - CRUD de jogos
   - Feed + pesquisa + likes
   - Edição de loja (cores, bio, avatar, capa)
   - Dados no GitHub + cache em memória
   - CORS para Vercel
   ========================================================= */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const TOKEN_FIXO = process.env.TOKEN_FIXO || 'zonaxp-editor-2025';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

/* ---------- Credenciais fixas (Fase 1) ---------- */
const LOGIN_FIXO = {
  nome: 'ZonaXP Membro',
  senha: 'Editor.Jogos',
};

/* ---------- Cores padrão ZonaXP (identidade da marca) ---------- */
const CORES_ZONAXP = {
  primaria: '#ff00aa',   // rosa neon
  secundaria: '#00aaff', // azul neon
  fundo: '#0a0a1a',      // fundo escuro
  cards: '#1a1a2e',      // cards escuros
  texto: '#ffffff',      // texto branco
};

/* ---------- Verificar variáveis obrigatórias ---------- */
if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN não definido no .env');
  process.exit(1);
}
if (!GITHUB_REPO) {
  console.error('❌ GITHUB_REPO não definido no .env');
  process.exit(1);
}

/* ---------- Ficheiros no GitHub ---------- */
const FICH_PUBLISHERS = 'dados-publishers/publishers.json';
const FICH_JOGOS = 'dados-publishers/jogos-publishers.json';

/* ---------- Cache em memória ---------- */
let cachePublishers = null;
let cacheJogos = null;

/* =========================================================
   CORS
   ========================================================= */
const ORIGENS_PERMITIDAS = [
  'http://localhost:3001',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  /\.vercel\.app$/,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const permitido = ORIGENS_PERMITIDAS.some(o => {
      if (typeof o === 'string') return o === origin;
      if (o instanceof RegExp) return o.test(origin);
      return false;
    });
    if (permitido) return callback(null, true);
    console.warn(`⚠️ CORS bloqueou origem: ${origin}`);
    return callback(new Error('Bloqueado por CORS'), false);
  },
  credentials: false,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   GITHUB API
   ========================================================= */
const GITHUB_API = 'https://api.github.com';

function headersGitHub() {
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ZonaXP-Publisher-Server',
  };
}

async function lerJSONdoGitHub(caminho) {
  const url = `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${caminho}?ref=${GITHUB_BRANCH}`;
  const resp = await fetch(url, { headers: headersGitHub() });

  if (resp.status === 404) return { dados: null, sha: null };

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`GitHub GET falhou (${resp.status}): ${erro}`);
  }

  const json = await resp.json();
  const conteudo = Buffer.from(json.content, 'base64').toString('utf-8');
  return { dados: JSON.parse(conteudo), sha: json.sha };
}

async function gravarJSONnoGitHub(caminho, dados, mensagem) {
  const { sha } = await lerJSONdoGitHub(caminho);

  const conteudo = JSON.stringify(dados, null, 2);
  const conteudoBase64 = Buffer.from(conteudo, 'utf-8').toString('base64');

  const url = `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${caminho}`;
  const body = {
    message: mensagem || 'update dados-publishers',
    content: conteudoBase64,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: { ...headersGitHub(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`GitHub PUT falhou (${resp.status}): ${erro}`);
  }
  return await resp.json();
}

/* =========================================================
   CACHE
   ========================================================= */

async function obterPublishers() {
  if (cachePublishers) return cachePublishers;
  const { dados } = await lerJSONdoGitHub(FICH_PUBLISHERS);
  cachePublishers = dados || { publishers: [] };

  // Garantir campos novos em publishers antigos
  cachePublishers.publishers = cachePublishers.publishers.map(p => ({
    ...p,
    avatar: p.avatar || '',
    capa: p.capa || '',
    cores: p.cores || { ...CORES_ZONAXP },
  }));

  return cachePublishers;
}

async function obterJogos() {
  if (cacheJogos) return cacheJogos;
  const { dados } = await lerJSONdoGitHub(FICH_JOGOS);
  cacheJogos = dados || { jogos: [] };

  // Garantir campo likes em jogos antigos
  cacheJogos.jogos = cacheJogos.jogos.map(j => ({
    ...j,
    likes: typeof j.likes === 'number' ? j.likes : 0,
  }));

  return cacheJogos;
}

async function guardarJogos(mensagem) {
  cacheJogos.ultimaAtualizacao = new Date().toISOString();
  cacheJogos.totalJogos = cacheJogos.jogos.length;
  await gravarJSONnoGitHub(FICH_JOGOS, cacheJogos, mensagem || 'update jogos');
}

async function guardarPublishers(mensagem) {
  cachePublishers.ultimaAtualizacao = new Date().toISOString();
  cachePublishers.totalPublishers = cachePublishers.publishers.length;
  await gravarJSONnoGitHub(FICH_PUBLISHERS, cachePublishers, mensagem || 'update publishers');
}

/* =========================================================
   HELPERS
   ========================================================= */

function gerarSlug(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function slugUnico(base, existentes) {
  let slug = base;
  let n = 2;
  while (existentes.includes(slug)) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

/* ---------- Combinar jogo + dados da loja (para feed/pesquisa) ---------- */
function jogoComLoja(jogo, publishers) {
  const loja = publishers.find(p => p.id === jogo.publisherId);
  return {
    id: jogo.id,
    slug: jogo.slug,
    nome: jogo.nome,
    categoria: jogo.categoria,
    plataforma: jogo.plataforma,
    imagem: jogo.imagem,
    tamanho: jogo.tamanho,
    likes: jogo.likes || 0,
    dataCriacao: jogo.dataCriacao,
    nomeLoja: loja?.nome || 'Desconhecida',
    slugLoja: loja?.slug || '',
    avatarLoja: loja?.avatar || '',
    coresLoja: loja?.cores || { ...CORES_ZONAXP },
  };
}

/* ---------- Garantir publisher fixo ---------- */
async function garantirPublisherFixo() {
  const dados = await obterPublishers();
  if (!dados.publishers || dados.publishers.length === 0) {
    dados.publishers = [{
      id: 1,
      nome: LOGIN_FIXO.nome,
      slug: 'zonaxp-membro',
      whatsapp: '840000000',
      bio: 'Loja oficial do mercado Publisher ZonaXP.',
      avatar: '',
      capa: '',
      cores: { ...CORES_ZONAXP },
      dataRegisto: new Date().toISOString(),
      status: 'ativo',
    }];
    await guardarPublishers('criar publisher fixo');
    console.log('✅ Publisher fixo criado no GitHub');
  } else {
    // Já existia — forçar gravar se faltavam campos novos
    await guardarPublishers('atualizar estrutura publisher');
  }
}

/* =========================================================
   MIDDLEWARE
   ========================================================= */
function verificarLogin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();

  if (token !== TOKEN_FIXO) {
    return res.status(401).json({ erro: 'Não autorizado. Faz login primeiro.' });
  }
  next();
}

/* =========================================================
   AUTH
   ========================================================= */

app.post('/api/login', (req, res) => {
  const { nome, senha } = req.body || {};
  if (nome === LOGIN_FIXO.nome && senha === LOGIN_FIXO.senha) {
    return res.json({
      ok: true,
      token: TOKEN_FIXO,
      publisher: { id: 1, nome: LOGIN_FIXO.nome, slug: 'zonaxp-membro' },
    });
  }
  return res.status(401).json({ ok: false, erro: 'Credenciais inválidas.' });
});

app.post('/api/logout', (req, res) => {
  res.json({ ok: true, mensagem: 'Sessão terminada.' });
});

/* =========================================================
   PUBLISHER — ver e editar a própria loja
   ========================================================= */

// GET /api/publisher/loja → dados da minha loja
app.get('/api/publisher/loja', verificarLogin, async (req, res) => {
  try {
    const dados = await obterPublishers();
    const loja = dados.publishers.find(p => p.id === 1);
    res.json({ ok: true, loja });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler loja.' });
  }
});

// PUT /api/publisher/loja → editar nome, bio, avatar, capa, cores, whatsapp
app.put('/api/publisher/loja', verificarLogin, async (req, res) => {
  try {
    const dados = await obterPublishers();
    const idx = dados.publishers.findIndex(p => p.id === 1);
    if (idx === -1) return res.status(404).json({ ok: false, erro: 'Loja não encontrada.' });

    const loja = dados.publishers[idx];
    const b = req.body || {};

    // Atualizar só os campos permitidos
    if (typeof b.nome === 'string' && b.nome.trim()) {
      const novoNome = b.nome.trim();
      if (novoNome !== loja.nome) {
        // Regerar slug se o nome mudou
        const outrosSlugs = dados.publishers.filter(p => p.id !== 1).map(p => p.slug);
        loja.slug = slugUnico(gerarSlug(novoNome), outrosSlugs);
        loja.nome = novoNome;
      }
    }

    if (typeof b.bio === 'string') loja.bio = b.bio.trim();
    if (typeof b.whatsapp === 'string') loja.whatsapp = b.whatsapp.trim();
    if (typeof b.avatar === 'string') loja.avatar = b.avatar.trim();
    if (typeof b.capa === 'string') loja.capa = b.capa.trim();

    // Cores — só aceitar campos válidos
    if (b.cores && typeof b.cores === 'object') {
      loja.cores = {
        primaria: b.cores.primaria || loja.cores.primaria || CORES_ZONAXP.primaria,
        secundaria: b.cores.secundaria || loja.cores.secundaria || CORES_ZONAXP.secundaria,
        fundo: b.cores.fundo || loja.cores.fundo || CORES_ZONAXP.fundo,
        cards: b.cores.cards || loja.cores.cards || CORES_ZONAXP.cards,
        texto: b.cores.texto || loja.cores.texto || CORES_ZONAXP.texto,
      };
    }

    dados.publishers[idx] = loja;
    await guardarPublishers(`editar loja: ${loja.nome}`);

    res.json({ ok: true, loja });
  } catch (e) {
    console.error('Erro PUT /api/publisher/loja:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao editar loja.' });
  }
});

/* =========================================================
   JOGOS — CRUD privado
   ========================================================= */

app.get('/api/jogos', verificarLogin, async (req, res) => {
  try {
    const dados = await obterJogos();
    res.json({ ok: true, total: dados.jogos.length, jogos: dados.jogos });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler jogos.' });
  }
});

app.get('/api/jogos/:id', verificarLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dados = await obterJogos();
    const jogo = dados.jogos.find(j => j.id === id);
    if (!jogo) return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });
    res.json({ ok: true, jogo });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler jogo.' });
  }
});

app.post('/api/jogos', verificarLogin, async (req, res) => {
  const campos = [
    'nome', 'categoria', 'plataforma', 'imagem',
    'tamanho', 'download', 'senha',
    'descricao_curta', 'descricao_longa',
  ];
  const faltam = campos.filter(c => {
    const v = req.body[c];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (faltam.length > 0) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios em falta.', faltam });
  }

  try {
    const dados = await obterJogos();
    const baseSlug = gerarSlug(req.body.nome);
    const slugsExistentes = dados.jogos.map(j => j.slug);
    const slug = slugUnico(baseSlug, slugsExistentes);

    const novoId = dados.jogos.length > 0
      ? Math.max(...dados.jogos.map(j => j.id)) + 1
      : 1;

    const novoJogo = {
      id: novoId,
      publisherId: 1,
      slug,
      nome: req.body.nome.trim(),
      categoria: req.body.categoria.trim(),
      plataforma: req.body.plataforma.trim(),
      imagem: req.body.imagem.trim(),
      tamanho: req.body.tamanho.trim(),
      download: req.body.download.trim(),
      senha: req.body.senha.trim(),
      descricao_curta: req.body.descricao_curta.trim(),
      descricao_longa: req.body.descricao_longa,
      likes: 0,
      dataCriacao: new Date().toISOString(),
      dataAtualizacao: new Date().toISOString(),
    };

    dados.jogos.push(novoJogo);
    await guardarJogos(`novo jogo: ${novoJogo.nome}`);

    res.status(201).json({ ok: true, jogo: novoJogo });
  } catch (e) {
    console.error('Erro POST /api/jogos:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao publicar jogo.' });
  }
});

app.put('/api/jogos/:id', verificarLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dados = await obterJogos();
    const idx = dados.jogos.findIndex(j => j.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });

    const jogoAtual = dados.jogos[idx];
    let slug = jogoAtual.slug;
    if (req.body.nome && req.body.nome.trim() !== jogoAtual.nome) {
      const baseSlug = gerarSlug(req.body.nome);
      const outrosSlugs = dados.jogos.filter(j => j.id !== id).map(j => j.slug);
      slug = slugUnico(baseSlug, outrosSlugs);
    }

    const campos = [
      'nome', 'categoria', 'plataforma', 'imagem',
      'tamanho', 'download', 'senha',
      'descricao_curta', 'descricao_longa',
    ];
    campos.forEach(c => {
      if (req.body[c] !== undefined) {
        dados.jogos[idx][c] = c === 'descricao_longa'
          ? req.body[c]
          : String(req.body[c]).trim();
      }
    });

    dados.jogos[idx].slug = slug;
    dados.jogos[idx].dataAtualizacao = new Date().toISOString();

    await guardarJogos(`editar jogo: ${dados.jogos[idx].nome}`);
    res.json({ ok: true, jogo: dados.jogos[idx] });
  } catch (e) {
    console.error('Erro PUT /api/jogos:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao editar jogo.' });
  }
});

app.delete('/api/jogos/:id', verificarLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dados = await obterJogos();
    const antes = dados.jogos.length;
    dados.jogos = dados.jogos.filter(j => j.id !== id);
    if (dados.jogos.length === antes) {
      return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });
    }
    await guardarJogos(`apagar jogo id ${id}`);
    res.json({ ok: true, mensagem: 'Jogo apagado.' });
  } catch (e) {
    console.error('Erro DELETE /api/jogos:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao apagar jogo.' });
  }
});

/* =========================================================
   PÚBLICO — FEED + PESQUISA
   ========================================================= */

// GET /api/publico/feed?ordem=recentes|populares&limite=50
app.get('/api/publico/feed', async (req, res) => {
  try {
    const jogos = await obterJogos();
    const pubs = await obterPublishers();

    const ordem = req.query.ordem === 'populares' ? 'populares' : 'recentes';
    const limite = Math.min(parseInt(req.query.limite, 10) || 50, 100);

    let lista = [...jogos.jogos];

    if (ordem === 'populares') {
      lista.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else {
      lista.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));
    }

    lista = lista.slice(0, limite);

    const resultado = lista.map(j => jogoComLoja(j, pubs.publishers));

    res.json({ ok: true, ordem, total: resultado.length, jogos: resultado });
  } catch (e) {
    console.error('Erro /api/publico/feed:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao ler feed.' });
  }
});

// GET /api/publico/pesquisa?q=texto
app.get('/api/publico/pesquisa', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ ok: true, jogos: [], lojas: [], total: 0 });

    const jogos = await obterJogos();
    const pubs = await obterPublishers();

    // Pesquisar jogos por nome
    const jogosEncontrados = jogos.jogos.filter(j =>
      j.nome.toLowerCase().includes(q)
    );

    // Pesquisar lojas por nome
    const lojasEncontradas = pubs.publishers.filter(p =>
      p.nome.toLowerCase().includes(q)
    ).map(p => ({
      id: p.id,
      nome: p.nome,
      slug: p.slug,
      bio: p.bio,
      avatar: p.avatar,
      cores: p.cores,
      totalJogos: jogos.jogos.filter(j => j.publisherId === p.id).length,
    }));

    res.json({
      ok: true,
      query: q,
      total: jogosEncontrados.length + lojasEncontradas.length,
      jogos: jogosEncontrados.map(j => jogoComLoja(j, pubs.publishers)),
      lojas: lojasEncontradas,
    });
  } catch (e) {
    console.error('Erro /api/publico/pesquisa:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro na pesquisa.' });
  }
});

/* =========================================================
   PÚBLICO — JOGO + LOJA + LIKE
   ========================================================= */

app.get('/api/publico/jogo/:slug', async (req, res) => {
  try {
    const dados = await obterJogos();
    const pubs = await obterPublishers();
    const jogo = dados.jogos.find(j => j.slug === req.params.slug);
    if (!jogo) return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });

    // Enriquecer com dados da loja
    const loja = pubs.publishers.find(p => p.id === jogo.publisherId);

    res.json({
      ok: true,
      jogo: {
        ...jogo,
        nomeLoja: loja?.nome || 'Desconhecida',
        slugLoja: loja?.slug || '',
        avatarLoja: loja?.avatar || '',
        bioLoja: loja?.bio || '',
        coresLoja: loja?.cores || { ...CORES_ZONAXP },
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler jogo.' });
  }
});

app.get('/api/publico/loja/:slug', async (req, res) => {
  try {
    const pubs = await obterPublishers();
    const loja = pubs.publishers.find(p => p.slug === req.params.slug);
    if (!loja) return res.status(404).json({ ok: false, erro: 'Loja não encontrada.' });

    const dados = await obterJogos();
    const jogos = dados.jogos.filter(j => j.publisherId === loja.id);

    // Ordenar: mais recentes primeiro
    jogos.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));

    res.json({
      ok: true,
      loja: {
        id: loja.id,
        nome: loja.nome,
        slug: loja.slug,
        bio: loja.bio,
        avatar: loja.avatar,
        capa: loja.capa,
        whatsapp: loja.whatsapp,
        cores: loja.cores || { ...CORES_ZONAXP },
        totalJogos: jogos.length,
      },
      jogos,
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler loja.' });
  }
});

// POST /api/publico/jogo/:slug/like
app.post('/api/publico/jogo/:slug/like', async (req, res) => {
  try {
    const dados = await obterJogos();
    const idx = dados.jogos.findIndex(j => j.slug === req.params.slug);
    if (idx === -1) return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });

    dados.jogos[idx].likes = (dados.jogos[idx].likes || 0) + 1;
    await guardarJogos(`like em: ${dados.jogos[idx].nome}`);

    res.json({ ok: true, likes: dados.jogos[idx].likes });
  } catch (e) {
    console.error('Erro POST like:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao dar like.' });
  }
});

/* =========================================================
   RAIZ — info da API
   ========================================================= */
app.get('/', (req, res) => {
  res.json({
    ok: true,
    sistema: 'Publisher ZonaXP — API',
    versao: '2.0.0',
    endpoints: {
      login: 'POST /api/login',
      minhaLoja: 'GET /api/publisher/loja',
      editarLoja: 'PUT /api/publisher/loja',
      listarJogos: 'GET /api/jogos',
      publicarJogo: 'POST /api/jogos',
      feed: 'GET /api/publico/feed?ordem=recentes|populares',
      pesquisa: 'GET /api/publico/pesquisa?q=texto',
      jogoPublico: 'GET /api/publico/jogo/:slug',
      like: 'POST /api/publico/jogo/:slug/like',
      lojaPublica: 'GET /api/publico/loja/:slug',
    },
  });
});

/* =========================================================
   404
   ========================================================= */
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    erro: 'Rota não encontrada.',
    caminho: req.originalUrl,
  });
});

/* =========================================================
   ARRANQUE
   ========================================================= */
(async () => {
  try {
    console.log('🔄 A ligar ao GitHub...');
    await garantirPublisherFixo();
    await obterJogos();
    console.log('✅ Dados carregados do GitHub.');

    app.listen(PORT, () => {
      console.log('=========================================');
      console.log(`🚀 Publisher API v2.0 — porta ${PORT}`);
      console.log(`🔑 Login: ${LOGIN_FIXO.nome} / ${LOGIN_FIXO.senha}`);
      console.log(`📦 Repo GitHub: ${GITHUB_REPO} (${GITHUB_BRANCH})`);
      console.log(`🌐 API em: http://localhost:${PORT}`);
      console.log('=========================================');
    });
  } catch (e) {
    console.error('❌ Erro no arranque:', e.message);
    process.exit(1);
  }
})();