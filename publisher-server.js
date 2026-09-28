/* =========================================================
   PUBLISHER SERVER — ZonaXP (v3.0 — Multi-Publisher)
   ---------------------------------------------------------
   - Registo real com WhatsApp + senha
   - Login por WhatsApp + senha
   - Tokens únicos por publisher
   - Cada publisher vê só os SEUS jogos
   - Feed + pesquisa + likes
   - Edição de loja (cores, bio, avatar, capa)
   - Dados no GitHub + cache em memória
   - CORS para Vercel
   ========================================================= */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

/* ---------- Publisher fixo (para o dono) ---------- */
const PUBLISHER_FIXO = {
  nome: 'ZonaXP Membro',
  whatsapp: '840000000',
  senha: 'Editor.Jogos',
};

/* ---------- Cores padrão ZonaXP ---------- */
const CORES_ZONAXP = {
  primaria: '#ff00aa',
  secundaria: '#00aaff',
  fundo: '#0a0a1a',
  cards: '#1a1a2e',
  texto: '#ffffff',
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

  // Migração: garantir campos em publishers antigos
  let precisaGravar = false;
  cachePublishers.publishers = cachePublishers.publishers.map(p => {
    const novo = { ...p };
    if (!novo.cores) novo.cores = { ...CORES_ZONAXP };
    if (novo.avatar === undefined) novo.avatar = '';
    if (novo.capa === undefined) novo.capa = '';
    if (!novo.status) novo.status = 'ativo';
    return novo;
  });

  // Se o publisher 1 existir e não tiver senha/token, é preciso migrar
  if (cachePublishers.publishers.length > 0) {
    for (const p of cachePublishers.publishers) {
      if (!p.senhaHash || !p.token) {
        precisaGravar = true;
        // Se for o publisher fixo (nome "ZonaXP Membro"), dar senha fixa
        if (p.nome === PUBLISHER_FIXO.nome) {
          p.senhaHash = await bcrypt.hash(PUBLISHER_FIXO.senha, 10);
          p.token = gerarToken();
        }
      }
    }
    if (precisaGravar) {
      await gravarJSONnoGitHub(FICH_PUBLISHERS, cachePublishers, 'migrar publishers com senha/token');
      console.log('✅ Publishers migrados (senha + token).');
    }
  }

  return cachePublishers;
}

async function obterJogos() {
  if (cacheJogos) return cacheJogos;
  const { dados } = await lerJSONdoGitHub(FICH_JOGOS);
  cacheJogos = dados || { jogos: [] };

  // Garantir campo likes
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

/* ---------- Gerar token único ---------- */
function gerarToken() {
  return 'zxzp_' + crypto.randomBytes(24).toString('hex');
}

/* ---------- Normalizar WhatsApp (só dígitos) ---------- */
function normalizarWhatsApp(w) {
  return String(w || '').replace(/\D/g, '');
}

/* ---------- Combinar jogo + dados da loja ---------- */
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
    const senhaHash = await bcrypt.hash(PUBLISHER_FIXO.senha, 10);
    dados.publishers = [{
      id: 1,
      nome: PUBLISHER_FIXO.nome,
      slug: 'zonaxp-membro',
      whatsapp: PUBLISHER_FIXO.whatsapp,
      senhaHash,
      token: gerarToken(),
      bio: 'Loja oficial do mercado Publisher ZonaXP.',
      avatar: '',
      capa: '',
      cores: { ...CORES_ZONAXP },
      dataRegisto: new Date().toISOString(),
      status: 'ativo',
    }];
    await guardarPublishers('criar publisher fixo');
    console.log('✅ Publisher fixo criado com senha e token.');
  }
}

/* =========================================================
   MIDDLEWARE — verificar login
   ========================================================= */
async function verificarLogin(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '').trim();

    if (!token) {
      return res.status(401).json({ ok: false, erro: 'Token não fornecido.' });
    }

    const dados = await obterPublishers();
    const publisher = dados.publishers.find(p => p.token === token);

    if (!publisher) {
      return res.status(401).json({ ok: false, erro: 'Token inválido ou expirado.' });
    }

    if (publisher.status !== 'ativo') {
      return res.status(403).json({ ok: false, erro: 'Conta suspensa.' });
    }

    req.publisher = publisher;
    next();
  } catch (e) {
    console.error('Erro no middleware:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro de autenticação.' });
  }
}

/* =========================================================
   AUTH
   ========================================================= */

// POST /api/publisher/registar
app.post('/api/publisher/registar', async (req, res) => {
  try {
    const nome = String(req.body.nome || '').trim();
    const whatsapp = normalizarWhatsApp(req.body.whatsapp);
    const senha = String(req.body.senha || '');

    // Validações
    if (!nome || nome.length < 3) {
      return res.status(400).json({ ok: false, erro: 'Nome muito curto (mín. 3 letras).' });
    }
    if (!whatsapp || whatsapp.length < 9) {
      return res.status(400).json({ ok: false, erro: 'WhatsApp inválido.' });
    }
    if (!senha || senha.length < 6) {
      return res.status(400).json({ ok: false, erro: 'Senha muito curta (mín. 6 caracteres).' });
    }

    const dados = await obterPublishers();

    // Verificar se WhatsApp já existe
    if (dados.publishers.some(p => p.whatsapp === whatsapp)) {
      return res.status(400).json({ ok: false, erro: 'Este WhatsApp já está registado.' });
    }

    // Gerar slug único
    const baseSlug = gerarSlug(nome);
    const slugsExistentes = dados.publishers.map(p => p.slug);
    const slug = slugUnico(baseSlug, slugsExistentes);

    // Novo ID
    const novoId = dados.publishers.length > 0
      ? Math.max(...dados.publishers.map(p => p.id)) + 1
      : 1;

    // Encriptar senha + gerar token
    const senhaHash = await bcrypt.hash(senha, 10);
    const token = gerarToken();

    const novo = {
      id: novoId,
      nome,
      slug,
      whatsapp,
      senhaHash,
      token,
      bio: '',
      avatar: '',
      capa: '',
      cores: { ...CORES_ZONAXP },
      dataRegisto: new Date().toISOString(),
      status: 'ativo',
    };

    dados.publishers.push(novo);
    await guardarPublishers(`novo publisher: ${nome}`);

    // Devolver sem senhaHash
    const { senhaHash: _, ...novoSemSenha } = novo;

    res.status(201).json({
      ok: true,
      token,
      publisher: novoSemSenha,
    });

  } catch (e) {
    console.error('Erro /api/publisher/registar:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao registar.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const whatsapp = normalizarWhatsApp(req.body.whatsapp);
    const senha = String(req.body.senha || '');

    if (!whatsapp || !senha) {
      return res.status(400).json({ ok: false, erro: 'Preenche WhatsApp e senha.' });
    }

    const dados = await obterPublishers();
    const publisher = dados.publishers.find(p => p.whatsapp === whatsapp);

    if (!publisher) {
      return res.status(401).json({ ok: false, erro: 'WhatsApp ou senha errados.' });
    }

    if (!publisher.senhaHash) {
      return res.status(401).json({ ok: false, erro: 'Conta sem senha definida. Contacta o suporte.' });
    }

    const ok = await bcrypt.compare(senha, publisher.senhaHash);
    if (!ok) {
      return res.status(401).json({ ok: false, erro: 'WhatsApp ou senha errados.' });
    }

    if (publisher.status !== 'ativo') {
      return res.status(403).json({ ok: false, erro: 'Conta suspensa.' });
    }

    // Regenerar token se não tiver (segurança)
    if (!publisher.token) {
      publisher.token = gerarToken();
      await guardarPublishers('regenerar token');
    }

    const { senhaHash: _, ...publisherSemSenha } = publisher;

    res.json({
      ok: true,
      token: publisher.token,
      publisher: publisherSemSenha,
    });

  } catch (e) {
    console.error('Erro /api/login:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao fazer login.' });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.json({ ok: true, mensagem: 'Sessão terminada.' });
});

/* =========================================================
   PUBLISHER — a própria loja
   ========================================================= */

// GET /api/publisher/loja
app.get('/api/publisher/loja', verificarLogin, async (req, res) => {
  const { senhaHash: _, ...loja } = req.publisher;
  res.json({ ok: true, loja });
});

// PUT /api/publisher/loja
app.put('/api/publisher/loja', verificarLogin, async (req, res) => {
  try {
    const dados = await obterPublishers();
    const idx = dados.publishers.findIndex(p => p.id === req.publisher.id);
    if (idx === -1) return res.status(404).json({ ok: false, erro: 'Loja não encontrada.' });

    const loja = dados.publishers[idx];
    const b = req.body || {};

    if (typeof b.nome === 'string' && b.nome.trim()) {
      const novoNome = b.nome.trim();
      if (novoNome !== loja.nome) {
        const outrosSlugs = dados.publishers.filter(p => p.id !== loja.id).map(p => p.slug);
        loja.slug = slugUnico(gerarSlug(novoNome), outrosSlugs);
        loja.nome = novoNome;
      }
    }

    if (typeof b.bio === 'string') loja.bio = b.bio.trim();
    if (typeof b.whatsapp === 'string') {
      const novoWpp = normalizarWhatsApp(b.whatsapp);
      if (novoWpp && novoWpp !== loja.whatsapp) {
        if (dados.publishers.some(p => p.whatsapp === novoWpp && p.id !== loja.id)) {
          return res.status(400).json({ ok: false, erro: 'WhatsApp já usado por outra loja.' });
        }
        loja.whatsapp = novoWpp;
      }
    }
    if (typeof b.avatar === 'string') loja.avatar = b.avatar.trim();
    if (typeof b.capa === 'string') loja.capa = b.capa.trim();

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

    const { senhaHash: _, ...lojaSemSenha } = loja;
    res.json({ ok: true, loja: lojaSemSenha });
  } catch (e) {
    console.error('Erro PUT /api/publisher/loja:', e.message);
    res.status(500).json({ ok: false, erro: 'Erro ao editar loja.' });
  }
});

/* =========================================================
   JOGOS — CRUD privado (por publisher)
   ========================================================= */

// GET /api/jogos — só os MEUS
app.get('/api/jogos', verificarLogin, async (req, res) => {
  try {
    const dados = await obterJogos();
    const meus = dados.jogos.filter(j => j.publisherId === req.publisher.id);
    res.json({ ok: true, total: meus.length, jogos: meus });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler jogos.' });
  }
});

// GET /api/jogos/:id — só se for MEU
app.get('/api/jogos/:id', verificarLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dados = await obterJogos();
    const jogo = dados.jogos.find(j => j.id === id && j.publisherId === req.publisher.id);
    if (!jogo) return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });
    res.json({ ok: true, jogo });
  } catch (e) {
    res.status(500).json({ ok: false, erro: 'Erro ao ler jogo.' });
  }
});

// POST /api/jogos — cria para MIM
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
      publisherId: req.publisher.id,   // ← agora vem do token!
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

// PUT /api/jogos/:id — só se for MEU
app.put('/api/jogos/:id', verificarLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dados = await obterJogos();
    const idx = dados.jogos.findIndex(j => j.id === id && j.publisherId === req.publisher.id);
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

// DELETE /api/jogos/:id — só se for MEU
app.delete('/api/jogos/:id', verificarLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dados = await obterJogos();
    const alvo = dados.jogos.find(j => j.id === id && j.publisherId === req.publisher.id);
    if (!alvo) {
      return res.status(404).json({ ok: false, erro: 'Jogo não encontrado.' });
    }

    dados.jogos = dados.jogos.filter(j => !(j.id === id && j.publisherId === req.publisher.id));
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

app.get('/api/publico/pesquisa', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ ok: true, jogos: [], lojas: [], total: 0 });

    const jogos = await obterJogos();
    const pubs = await obterPublishers();

    const jogosEncontrados = jogos.jogos.filter(j =>
      j.nome.toLowerCase().includes(q)
    );

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
    versao: '3.0.0',
    endpoints: {
      registar: 'POST /api/publisher/registar',
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
      console.log(`🚀 Publisher API v3.0 — porta ${PORT}`);
      console.log(`👥 Multi-publisher com tokens`);
      console.log(`📦 Repo GitHub: ${GITHUB_REPO} (${GITHUB_BRANCH})`);
      console.log(`🌐 API em: http://localhost:${PORT}`);
      console.log('=========================================');
    });
  } catch (e) {
    console.error('❌ Erro no arranque:', e.message);
    process.exit(1);
  }
})();