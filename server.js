const http = require("http");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const PUBLIC = path.join(DIR, "public");
const CONFIG = path.join(DIR, "config.json");
const DADOS = path.join(DIR, "dados-diarios");
const DIR_EMPRESA = path.join(DIR, "dados-empresa");
const ARQ_EMPRESA = path.join(DIR_EMPRESA, "empresa.json");
const ARQ_LEADS = path.join(DIR_EMPRESA, "leads.json");
const ARQ_CONTRATOS = path.join(DIR_EMPRESA, "contratos.json");
const ARQ_COBRANCAS = path.join(DIR_EMPRESA, "cobrancas.json");
const ARQ_CONHECIMENTO = path.join(DIR_EMPRESA, "conhecimento.json");
const ARQ_FINANCEIRO = path.join(DIR_EMPRESA, "financeiro.json");

const config = Object.assign(
  fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {},
  {
    gemini_key: process.env.GEMINI_KEY || (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")).gemini_key : ""),
    groq_key: process.env.GROQ_KEY || (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")).groq_key : ""),
    openrouter_key: process.env.OPENROUTER_KEY || (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")).openrouter_key : "")
  }
);

const SENHA = process.env.SENHA || config.senha || "";

function autenticado(req) {
  return SENHA && req.headers["x-senha"] === SENHA;
}

function precisaAuth(req, res) {
  if (autenticado(req)) return true;
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ erro: "Não autenticado." }));
  return false;
}

[DIR_EMPRESA, DADOS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const INSTRUCAO_SISTEMA = `Você é o Multi PH, um assistente de inteligência artificial para consultores de crédito empresarial brasileiros.
Regras obrigatórias:
1. Hoje é ${hoje()}. Sempre considere essa data.
2. NUNCA invente ou chute informações. Se não tiver certeza ou se a informação pode estar desatualizada, avise claramente: "não tenho informação atualizada sobre isso" e explique o que você sabe.
3. Se a pergunta envolver dados do momento (câmbio, juros, notícias, políticas atuais), diga explicitamente que seus dados podem estar defasados.
4. Responda em português do Brasil, de forma clara e direta.
5. Não prometa resultados garantidos de crédito ou aprovação bancária.`;

function hoje() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${dia}`;
}

function horaAgora() {
  return `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
}

async function coletarDadosDiarios() {
  const dados = { data: hoje(), hora: horaAgora(), cambio: null, selic: null, ipca: null };

  try {
    const c = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL", { signal: AbortSignal.timeout(15000) });
    const j = await c.json();
    dados.cambio = { dolar: j["USDBRL"]?.bid, variacao: j["USDBRL"]?.pctChange };
  } catch (e) { dados.cambio = null; }

  try {
    const s = await fetch("https://api.bcb.gov.br/dados/serie/bcdata.sgs/432/dados/ultimos/1?formato=json", { signal: AbortSignal.timeout(15000) });
    const j = await s.json();
    dados.selic = j[0]?.valor;
  } catch (e) { dados.selic = null; }

  try {
    const i = await fetch("https://api.bcb.gov.br/dados/serie/bcdata.sgs/433/dados/ultimos/1?formato=json", { signal: AbortSignal.timeout(15000) });
    const j = await i.json();
    dados.ipca = j[0]?.valor;
  } catch (e) { dados.ipca = null; }

  return dados;
}

async function gerarResumoDiario() {
  const dados = await coletarDadosDiarios();

  const parteEconomia = [
    dados.cambio ? `Dólar (USD/BRL): R$ ${dados.cambio.dolar} (variação ${dados.cambio.variacao}%)` : "Câmbio: indisponível",
    dados.selic ? `Taxa Selic atual: ${dados.selic}% a.a.` : "Selic: indisponível",
    dados.ipca ? `IPCA acumulado: ${dados.ipca}%` : "IPCA: indisponível"
  ].join(" | ");

  const pergunta = `Hoje é ${dados.data} (${dados.hora}). Faça um resumo informativo e útil sobre o dia para um consultor de crédito empresarial brasileiro.\n\nDados econômicos de hoje:\n${parteEconomia}\n\nFormato da resposta: um parágrafo sobre o cenário econômico, depois uma seção 'O que isso significa para o crédito empresarial' com 3 pontos. Escreva em português do Brasil.`;

  const respostas = [];
  for (const p of provedores) {
    try {
      const texto = await p.perguntar(pergunta);
      respostas.push({ id: p.id, nome: p.nome, modelo: p.modelo, cor: p.cor, resposta: texto, ok: true });
    } catch (e) {
      respostas.push({ id: p.id, nome: p.nome, modelo: p.modelo, cor: p.cor, erro: e.message || "erro", ok: false });
    }
  }

  let resumo = "";
  const ok = respostas.filter(r => r.ok);
  if (ok.length > 1) {
    resumo = await montarResumo("resumo diário", ok.map(r => ({ nome: r.nome, resposta: r.resposta })));
  } else if (ok.length === 1) {
    resumo = ok[0].resposta;
  }

  const arquivo = {
    data: dados.data,
    horaGerado: dados.hora,
    dados: dados,
    respostas: respostas,
    resumo: resumo
  };

  if (!fs.existsSync(DADOS)) fs.mkdirSync(DADOS, { recursive: true });
  fs.writeFileSync(path.join(DADOS, `${dados.data}.json`), JSON.stringify(arquivo, null, 2), "utf8");
  return arquivo;
}

function agendarRotinaDiaria() {
  const horaMeta = Number(config.hora_diario) || 6;
  let ultima = "";
  const rodarSePrecisar = async () => {
    if (provedores.length === 0) return;
    const hojeStr = hoje();
    const existe = fs.existsSync(path.join(DADOS, `${hojeStr}.json`));
    const agoraHora = new Date().getHours();
    if (ultima === hojeStr) return;
    if (existe) { ultima = hojeStr; return; }
    if (agoraHora >= horaMeta) {
      ultima = hojeStr;
      try {
        const arquivo = await gerarResumoDiario();
        console.log(`[Multi PH] Resumo diário gerado: ${arquivo.data} (${arquivo.respostas.filter(r => r.ok).length} IA(s))`);
      } catch (e) {
        console.log("[Multi PH] Falha na rotina diária:", e.message);
      }
    }
  };
  rodarSePrecisar();
  setInterval(rodarSePrecisar, 60 * 1000);
}

function temChave(provedor) {
  return config[provedor] && String(config[provedor]).trim() !== "" && !String(config[provedor]).startsWith("coloque");
}

const provedores = [];

if (temChave("gemini_key")) {
  provedores.push({
    id: "gemini",
    nome: "Google Gemini",
    modelo: "gemini-2.5-flash",
    cor: "#4285F4",
    perguntar: async (pergunta) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini_key}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: INSTRUCAO_SISTEMA }] },
          contents: [{ role: "user", parts: [{ text: pergunta }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.6 }
        }),
        signal: AbortSignal.timeout(90000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "erro Gemini");
      const texto = j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "(resposta vazia)";
      return texto;
    },
    perguntarComInstrucao: async (instrucao, pergunta) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini_key}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instrucao }] },
          contents: [{ role: "user", parts: [{ text: pergunta }] }],
          generationConfig: { temperature: 0.5 }
        }),
        signal: AbortSignal.timeout(90000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "erro Gemini");
      return j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "(resposta vazia)";
    }
  });
}

if (temChave("groq_key")) {
  provedores.push({
    id: "groq",
    nome: "Groq (Llama)",
    modelo: "llama-3.3-70b-versatile",
    cor: "#F55036",
    perguntar: async (pergunta) => {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.groq_key}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: INSTRUCAO_SISTEMA },
            { role: "user", content: pergunta }
          ],
          temperature: 0.6
        }),
        signal: AbortSignal.timeout(90000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "erro Groq");
      return j.choices?.[0]?.message?.content || "(resposta vazia)";
    },
    perguntarComInstrucao: async (instrucao, pergunta) => {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.groq_key}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: instrucao },
            { role: "user", content: pergunta }
          ],
          temperature: 0.5
        }),
        signal: AbortSignal.timeout(90000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "erro Groq");
      return j.choices?.[0]?.message?.content || "(resposta vazia)";
    }
  });
}

if (temChave("openrouter_key")) {
  function criarOpenRouter(id, nome, modelo, cor) {
    return {
      id, nome, modelo, cor,
      perguntar: async (pergunta) => {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.openrouter_key}`
          },
          body: JSON.stringify({
            model: modelo,
            messages: [
              { role: "system", content: INSTRUCAO_SISTEMA },
              { role: "user", content: pergunta }
            ],
            temperature: 0.6
          }),
          signal: AbortSignal.timeout(90000)
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || "erro OpenRouter");
        return j.choices?.[0]?.message?.content || "(resposta vazia)";
      },
      perguntarComInstrucao: async (instrucao, pergunta) => {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.openrouter_key}`
          },
          body: JSON.stringify({
            model: modelo,
            messages: [
              { role: "system", content: instrucao },
              { role: "user", content: pergunta }
            ],
            temperature: 0.5
          }),
          signal: AbortSignal.timeout(90000)
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || "erro OpenRouter");
        return j.choices?.[0]?.message?.content || "(resposta vazia)";
      }
    };
  }
  provedores.push(
    criarOpenRouter("openrouter-gptoss", "OpenAI GPT-OSS", "openai/gpt-oss-20b:free", "#10A37F"),
    criarOpenRouter("openrouter-nemotron", "NVIDIA Nemotron", "nvidia/nemotron-3-super-120b-a12b:free", "#76B900"),
    criarOpenRouter("openrouter-ling", "Ling Flash", "inclusionai/ling-3.0-flash:free", "#F59E0B")
  );
}

function montarResumo(pergunta, respostas) {
  const melhor = provedores[0];
  if (!melhor) return Promise.resolve("Nenhuma IA configurada ainda.");
  const texto = respostas.filter(r => r.resposta)
    .map(r => `=== ${r.nome} ===\n${r.resposta}`)
    .join("\n\n");
  if (!texto.trim()) return Promise.resolve("Nenhuma IA conseguiu responder.");
  const instrucao = `Recebi respostas de várias IAs para a pergunta: "${pergunta}".\n\n${texto}\n\nAgora faça um resumo único e objetivo, juntando o melhor de cada resposta, destacando consensos e divergências. Escreva em português do Brasil.`;
  return melhor.perguntar(instrucao);
}

function classificarPergunta(pergunta) {
  const t = pergunta.toLowerCase();
  const palavrasAtual = ["hoje", "atual", "cotação", "cotacao", "dólar", "dolar", "selic", "ipca", "juros", "taxa", "câmbio", "cambio", "notícia", "noticia", "notícias", "agora", "preço", "preco", "ontem", "amanhã", "amanha", "2026", "última", "ultima", "copom", "banco central", "eleição", "eleicao", "presidente", "governo", "quanto custa", "cotação do", "vale hoje"];
  const palavrasLogica = ["calcule", "calcular", "quanto é", "quanto e", "resolve", "resolver", "equação", "equacao", "código", "codigo", "programa", "bug", "script", "função", "funcao", "algoritmo", "matemática", "matematica", "fórmula", "formula", "raciocínio", "raciocinio", "lógica", "logica", "python", "javascript", "sql", "excel", "planilha", "somar", "calcular"];
  const palavrasCriativo = ["escreva", "crie", "cria", "texto", "marketing", "anúncio", "anuncio", "legenda", "post", "poema", "história", "historia", "slogan", "campanha", "roteiro", "story", "copy", "frase"];
  let tipo = "geral";
  let pontos = 0;
  const qtdAtual = palavrasAtual.filter(p => t.includes(p)).length;
  const qtdLogica = palavrasLogica.filter(p => t.includes(p)).length;
  const qtdCriativo = palavrasCriativo.filter(p => t.includes(p)).length;
  if (qtdAtual > 0 && qtdAtual >= qtdLogica && qtdAtual >= qtdCriativo) tipo = "atual";
  else if (qtdLogica > 0 && qtdLogica >= qtdCriativo) tipo = "logica";
  else if (qtdCriativo > 0) tipo = "criativo";
  const recomendada = { atual: "gemini", logica: "openrouter-nemotron", criativo: "openrouter-gptoss", geral: "gemini" }[tipo];
  const nomesTipo = { atual: "dados atuais / tempo real", logica: "lógica, matemática e técnica", criativo: "criação e texto", geral: "conhecimento geral" };
  return { tipo, recomendada, descricao: nomesTipo[tipo] };
}

function contextoEconomico() {
  try {
    const lista = fs.existsSync(DADOS) ? fs.readdirSync(DADOS).filter(f => f.endsWith(".json")).sort().reverse() : [];
    if (lista.length === 0) return "";
    const ultimo = JSON.parse(fs.readFileSync(path.join(DADOS, lista[0]), "utf8"));
    const e = ultimo.dados || {};
    const partes = [
      e.cambio ? `Dólar: R$ ${e.cambio.dolar} (variação ${e.cambio.variacao}%)` : "",
      e.selic ? `Selic: ${e.selic}% a.a.` : "",
      e.ipca ? `IPCA: ${e.ipca}%` : ""
    ].filter(Boolean).join(" | ");
    if (!partes) return "";
    return `\n\nDados econômicos coletados automaticamente hoje (${ultimo.data}, ${ultimo.horaGerado}): ${partes}. Use-os na resposta quando relevantes.`;
  } catch (e) {
    return "";
  }
}

function lerJSON(caminho, padrao) {
  try {
    if (fs.existsSync(caminho)) return JSON.parse(fs.readFileSync(caminho, "utf8"));
  } catch (e) { }
  return JSON.parse(JSON.stringify(padrao));
}

function salvarJSON(caminho, obj) {
  if (!fs.existsSync(DIR_EMPRESA)) fs.mkdirSync(DIR_EMPRESA, { recursive: true });
  fs.writeFileSync(caminho, JSON.stringify(obj, null, 2), "utf8");
}

function novoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function limparTexto(t) {
  return String(t || "").replace(/<[^>]*>/g, "").replace(/[{}[\]"`]/g, "").trim().slice(0, 2000);
}

function empresaPadrao() {
  return {
    nome: "Minha Empresa",
    whatsapp: "",
    pix_chave: "",
    pix_nome: "",
    pix_cidade: "",
    regras: "Oferecemos consultoria em crédito empresarial. Atendemos empresas de qualquer porte.",
    lgpd_msg: "Seus dados estão seguros e são usados apenas para o atendimento."
  };
}

function lerEmpresa() {
  const e = Object.assign(empresaPadrao(), lerJSON(ARQ_EMPRESA, {}));
  e.conhecimento = lerJSON(ARQ_CONHECIMENTO, []);
  return e;
}

function lerLeads() { return lerJSON(ARQ_LEADS, []); }
function lerContratos() { return lerJSON(ARQ_CONTRATOS, []); }
function lerCobrancas() { return lerJSON(ARQ_COBRANCAS, []); }
function lerFinanceiro() { return lerJSON(ARQ_FINANCEIRO, []); }
function salvarFinanceiro(lista) { salvarJSON(ARQ_FINANCEIRO, lista); }

function calcularResumoFinanceiro() {
  const lancamentos = lerFinanceiro();
  const hojeStr = hoje();
  const agora = new Date();
  const inicioSemana = new Date(agora);
  inicioSemana.setDate(agora.getDate() - ((agora.getDay() + 6) % 7));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const iniMes = new Date(agora.getFullYear(), agora.getMonth(), 1);

  const soma = (lista, tipo) => lista.filter(l => l.tipo === tipo).reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const noPeriodo = (ini) => lancamentos.filter(l => l.data >= fmt(ini) && l.data <= hoje());
  const doDia = lancamentos.filter(l => l.data === hoje());

  const entradaHoje = soma(doDia, "entrada");
  const saidaHoje = soma(doDia, "saida");
  const entradasSemana = soma(noPeriodo(inicioSemana), "entrada");
  const entradasMes = soma(noPeriodo(iniMes), "entrada");
  const saidasMes = soma(noPeriodo(iniMes), "saida");

  return {
    data: hoje(),
    entradasHoje: Math.round(entradaHoje * 100) / 100,
    saidasHoje: Math.round(saidaHoje * 100) / 100,
    lucroHoje: Math.round((entradaHoje - saidaHoje) * 100) / 100,
    entradasSemana: Math.round(entradasSemana * 100) / 100,
    entradasMes: Math.round(entradasMes * 100) / 100,
    saidasMes: Math.round(saidasMes * 100) / 100,
    lucroMes: Math.round((entradasMes - saidasMes) * 100) / 100,
    totalLancamentos: lancamentos.length,
    ultimos: lancamentos.slice(-15).reverse()
  };
}

function contextoFinanceiroParaIA() {
  const r = calcularResumoFinanceiro();
  const moeda = v => "R$ " + Number(v || 0).toFixed(2).replace(".", ",");
  let txt = `\n\nDados financeiros da empresa de hoje (${r.data}):
Faturamento hoje: ${moeda(r.entradasHoje)} | Despesas hoje: ${moeda(r.saidasHoje)} | Lucro hoje: ${moeda(r.lucroHoje)}
Faturamento semana: ${moeda(r.entradasSemana)} | Faturamento mês: ${moeda(r.entradasMes)} | Despesas mês: ${moeda(r.saidasMes)} | Lucro mês: ${moeda(r.lucroMes)}
Lançamentos recentes:
${(r.ultimos || []).map(l => `- ${l.data} ${l.tipo} (${l.categoria}): ${moeda(l.valor)} ${l.descricao || ""}`).join("\n")}`;
  return txt;
}

function instrucaoAtendimento(empresa, lead) {
  const partes = [];
  partes.push(`Você é o atendente de IA da empresa "${empresa.nome}". O dono da empresa te contratou para atender os clientes no WhatsApp.`);
  partes.push("Regras obrigatórias:");
  partes.push("1. Hoje é " + hoje() + ". Sempre considere essa data.");
  partes.push("2. NUNCA invente ou chute informações. Se não souber, diga que vai verificar com a empresa e peça para aguardar.");
  partes.push("3. Responda apenas com base no conhecimento e nas regras da empresa. Não prometa aprovação de crédito e não vincule a programas do governo.");
  partes.push("4. Responda em português do Brasil, curto e direto, como uma conversa de WhatsApp. Não use markdown.");
  if (empresa.regras) partes.push("\nRegras da empresa:\n" + String(empresa.regras).slice(0, 3000));
  if (empresa.lgpd_msg) partes.push("\nPolítica de dados (LGPD): " + String(empresa.lgpd_msg).slice(0, 500));
  if (empresa.conhecimento && empresa.conhecimento.length) {
    partes.push("\nBase de conhecimento da empresa (use SOMENTE isto para responder sobre produtos, preços e serviços):\n" +
      empresa.conhecimento.map(k => "- " + k.titulo + ": " + k.texto).join("\n").slice(0, 6000));
  }
  if (lead) {
    if (lead.nome) partes.push("\nO cliente se chama " + lead.nome + ". Trate-o pelo nome.");
    const historico = (lead.mensagens || []).slice(-20)
      .map(m => (m.de === "cliente" ? "Cliente: " : m.de === "dono" ? "Dono: " : "Você: ") + m.texto)
      .join("\n");
    if (historico) partes.push("\nHistórico da conversa:\n" + historico);
  }
  return partes.join("\n");
}

async function responderLead(leadId, textoCliente) {
  const leads = lerLeads();
  const lead = leads.find(l => l.id === leadId);
  if (!lead) throw new Error("Lead não encontrado.");
  textoCliente = limparTexto(textoCliente);
  if (!textoCliente) throw new Error("Mensagem vazia.");
  lead.mensagens = lead.mensagens || [];
  lead.mensagens.push({ de: "cliente", texto: textoCliente, data: `${hoje()} ${horaAgora()}` });
  lead.ultimoContato = hoje();
  const empresa = lerEmpresa();
  const instrucao = instrucaoAtendimento(empresa, lead);
  const melhor = provedores.find(p => p.id === "gemini") || provedores[0];
  if (!melhor) throw new Error("Nenhuma IA configurada.");
  const resposta = await melhor.perguntarComInstrucao(instrucao, textoCliente);
  lead.mensagens.push({ de: "ia", texto: resposta, data: `${hoje()} ${horaAgora()}` });
  salvarJSON(ARQ_LEADS, leads);
  return { lead, resposta };
}

function crc16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function campoPix(id, valor) {
  const v = String(valor);
  return id + String(v.length).padStart(2, "0") + v;
}

function gerarBrcodePix(opts) {
  const chave = String(opts.chave || "").trim();
  if (!chave) throw new Error("Chave PIX não configurada. Defina em Configurações.");
  let payload = "000201";
  payload += campoPix("26", "0014BR.GOV.BCB.PIX01" + campoPix("01", chave));
  payload += "520400005303986";
  if (opts.valor > 0) payload += campoPix("54", Number(opts.valor).toFixed(2));
  payload += "5802BR";
  payload += campoPix("59", String(opts.nome || "").slice(0, 25));
  payload += campoPix("60", String(opts.cidade || "").slice(0, 15));
  payload += "62070503***";
  payload += "6304";
  return payload + crc16(payload);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = "";
    req.on("data", c => { dados += c; if (dados.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(dados));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/login") {
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      if (corpo.senha === SENHA) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ erro: "Senha incorreta." }));
    }

    if (req.method === "POST" && req.url === "/api/perguntar") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const pergunta = String(corpo.pergunta || "").trim();
      if (!pergunta) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Pergunta vazia." }));
      }
      if (provedores.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ aviso: "Nenhuma chave configurada. Edite o arquivo config.json e veja o passo a passo no COMO-COMECAR.md.", respostas: [] }));
      }
      const classificacao = classificarPergunta(pergunta);
      const contexto = classificacao.tipo === "atual" ? contextoEconomico() : "";
      const perguntaFinal = pergunta + contexto;
      const resultados = await Promise.all(provedores.map(async p => {
        try {
          const resposta = await p.perguntar(perguntaFinal);
          return { id: p.id, nome: p.nome, modelo: p.modelo, cor: p.cor, resposta, ok: true };
        } catch (e) {
          return { id: p.id, nome: p.nome, modelo: p.modelo, cor: p.cor, erro: e.message || "erro desconhecido", ok: false };
        }
      }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ tipo: classificacao.tipo, descricao: classificacao.descricao, recomendada: classificacao.recomendada, respostas: resultados }));
    }

    if (req.method === "POST" && req.url === "/api/resumir") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const pergunta = String(corpo.pergunta || "").trim();
      const respostas = Array.isArray(corpo.respostas) ? corpo.respostas : [];
      const resumo = await montarResumo(pergunta, respostas);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ resumo }));
    }

    if (req.method === "GET" && req.url.startsWith("/api/diario")) {
      if (!precisaAuth(req, res)) return;
      const lista = fs.existsSync(DADOS) ? fs.readdirSync(DADOS).filter(f => f.endsWith(".json")).sort().reverse() : [];
      const dados = lista.map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(DADOS, f), "utf8")); } catch (e) { return null; }
      }).filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ dias: dados }));
    }

    if (req.method === "POST" && req.url === "/api/slides") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const tema = String(corpo.tema || "").trim();
      if (!tema) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Tema vazio." }));
      }
      if (provedores.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ aviso: "Nenhuma IA configurada ainda." }));
      }
      const instrucao = `Crie uma apresentação de slides profissional em português do Brasil sobre o tema: "${tema}".
Responda SOMENTE com um JSON válido, sem texto fora dele, neste formato exato:
{"titulo":"título da apresentação","slides":[{"titulo":"título do slide","pontos":["ponto 1","ponto 2","ponto 3"]}]}
Regras: de 6 a 10 slides, cada um com 3 a 5 pontos curtos e diretos. O primeiro slide deve ser a capa (só título), o último deve ser de fechamento/encerramento.`;
      try {
        const texto = await provedores[0].perguntar(instrucao);
        const limpo = texto.replace(/```json|```/g, "").trim();
        const inicio = limpo.indexOf("{");
        const fim = limpo.lastIndexOf("}");
        const parsed = inicio >= 0 && fim > inicio ? JSON.parse(limpo.slice(inicio, fim + 1)) : null;
        const slides = parsed && Array.isArray(parsed.slides) ? parsed.slides : [{ titulo: "Resultado", pontos: [texto] }];
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ titulo: parsed?.titulo || tema, slides }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }

    if (req.method === "POST" && req.url === "/api/diario/agora") {
      if (!precisaAuth(req, res)) return;
      if (provedores.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ aviso: "Nenhuma IA configurada ainda." }));
      }
      try {
        const arquivo = await gerarResumoDiario();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, dia: arquivo }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }

    // ================= MODO EMPRESA (estilo Babel OS) =================

    if (req.method === "GET" && req.url === "/api/visao") {
      if (!precisaAuth(req, res)) return;
      const leads = lerLeads();
      const contratos = lerContratos();
      const cobrancas = lerCobrancas();
      const statusContagem = {};
      leads.forEach(l => { statusContagem[l.status || "novo"] = (statusContagem[l.status || "novo"] || 0) + 1; });
      const aReceber = cobrancas.filter(c => !c.pago).reduce((s, c) => s + (Number(c.valor) || 0), 0);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        leads: leads.length,
        status: statusContagem,
        contratos: contratos.length,
        assinados: contratos.filter(c => c.status === "assinado").length,
        cobrancas: cobrancas.length,
        aReceber,
        pagas: cobrancas.filter(c => c.pago).reduce((s, c) => s + (Number(c.valor) || 0), 0)
      }));
    }

    if (req.method === "GET" && req.url === "/api/empresa/publica") {
      const e = lerEmpresa();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ nome: e.nome, whatsapp: e.whatsapp, lgpd_msg: e.lgpd_msg }));
    }

    if (req.method === "GET" && req.url === "/api/empresa") {
      if (!precisaAuth(req, res)) return;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(lerEmpresa()));
    }

    if (req.method === "POST" && req.url === "/api/empresa") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const atual = lerEmpresa();
      const novo = {
        nome: String(corpo.nome || atual.nome).slice(0, 80),
        whatsapp: String(corpo.whatsapp || atual.whatsapp || "").replace(/\D/g, "").slice(0, 15),
        pix_chave: String(corpo.pix_chave || atual.pix_chave || "").slice(0, 80),
        pix_nome: String(corpo.pix_nome || atual.pix_nome || "").slice(0, 25),
        pix_cidade: String(corpo.pix_cidade || atual.pix_cidade || "").slice(0, 15),
        regras: String(corpo.regras || atual.regras || "").slice(0, 3000),
        lgpd_msg: String(corpo.lgpd_msg || atual.lgpd_msg || "").slice(0, 500)
      };
      salvarJSON(ARQ_EMPRESA, novo);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, empresa: novo }));
    }

    if (req.method === "POST" && req.url === "/api/conhecimento") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const titulo = limparTexto(corpo.titulo) || "Item sem título";
      const texto = limparTexto(corpo.texto);
      if (!texto) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Texto da base de conhecimento vazio." }));
      }
      const lista = lerJSON(ARQ_CONHECIMENTO, []);
      lista.push({ id: novoId(), titulo, texto, data: hoje() });
      salvarJSON(ARQ_CONHECIMENTO, lista);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, conhecimento: lista }));
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/conhecimento")) {
      if (!precisaAuth(req, res)) return;
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      let lista = lerJSON(ARQ_CONHECIMENTO, []);
      lista = lista.filter(k => k.id !== id);
      salvarJSON(ARQ_CONHECIMENTO, lista);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, conhecimento: lista }));
    }

    if (req.method === "GET" && req.url === "/api/leads") {
      if (!precisaAuth(req, res)) return;
      const leads = lerLeads().sort((a, b) => String(b.ultimoContato || b.criado).localeCompare(String(a.ultimoContato || a.criado)));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ leads }));
    }

    if (req.method === "POST" && req.url === "/api/leads") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const nome = limparTexto(corpo.nome);
      if (!nome) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Nome do lead é obrigatório." }));
      }
      const leads = lerLeads();
      const lead = {
        id: novoId(),
        nome,
        whatsapp: limparTexto(corpo.whatsapp),
        origem: limparTexto(corpo.origem) || "site",
        status: "novo",
        nota: null,
        valor: null,
        consentimento: !!corpo.consentimento,
        raiox: null,
        mensagens: [],
        criado: `${hoje()} ${horaAgora()}`,
        ultimoContato: hoje()
      };
      leads.push(lead);
      salvarJSON(ARQ_LEADS, leads);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, lead }));
    }

    if (req.method === "PUT" && req.url === "/api/leads") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const leads = lerLeads();
      const lead = leads.find(l => l.id === corpo.id);
      if (!lead) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Lead não encontrado." }));
      }
      if (corpo.status !== undefined) lead.status = ["novo", "qualificado", "negociando", "fechado", "perdido"].includes(corpo.status) ? corpo.status : lead.status;
      if (corpo.nota !== undefined) lead.nota = corpo.nota === "" || corpo.nota === null ? null : Number(corpo.nota);
      if (corpo.valor !== undefined) lead.valor = corpo.valor === "" || corpo.valor === null ? null : Number(corpo.valor);
      if (corpo.nome !== undefined) lead.nome = limparTexto(corpo.nome) || lead.nome;
      if (corpo.whatsapp !== undefined) lead.whatsapp = limparTexto(corpo.whatsapp);
      salvarJSON(ARQ_LEADS, leads);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, lead }));
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/leads")) {
      if (!precisaAuth(req, res)) return;
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      let leads = lerLeads();
      const restantes = leads.filter(l => l.id !== id);
      if (restantes.length === leads.length) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Lead não encontrado." }));
      }
      salvarJSON(ARQ_LEADS, restantes);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === "GET" && req.url === "/api/leads/parados") {
      if (!precisaAuth(req, res)) return;
      const leads = lerLeads();
      const parados = leads.filter(l => l.status !== "fechado" && l.status !== "perdido")
        .map(l => {
          const ultimo = l.ultimoContato || l.criado || "";
          const dias = ultimo ? Math.floor((Date.now() - new Date(ultimo).getTime()) / 86400000) : 999;
          return { ...l, diasParado: dias };
        })
        .filter(l => l.diasParado >= 3);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ parados }));
    }

    if (req.method === "GET" && req.url.startsWith("/api/leads/") && req.url.endsWith("/conversa")) {
      if (!precisaAuth(req, res)) return;
      const id = req.url.split("/")[3];
      const leads = lerLeads();
      const lead = leads.find(l => l.id === id);
      if (!lead) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Lead não encontrado." }));
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ lead }));
    }

    if (req.method === "POST" && req.url.startsWith("/api/leads/") && req.url.endsWith("/responder")) {
      if (!precisaAuth(req, res)) return;
      const id = req.url.split("/")[3];
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      try {
        const r = await responderLead(id, corpo.texto);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, resposta: r.resposta, lead: r.lead }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }

    if (req.method === "POST" && req.url.startsWith("/api/leads/") && req.url.endsWith("/raio-x")) {
      if (!precisaAuth(req, res)) return;
      const id = req.url.split("/")[3];
      const leads = lerLeads();
      const lead = leads.find(l => l.id === id);
      if (!lead) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Lead não encontrado." }));
      }
      const historico = (lead.mensagens || []).map(m => `${m.de}: ${m.texto}`).join("\n") || "(sem conversas ainda)";
      const pergunta = `Faça um raio-x deste lead de uma empresa de consultoria.\nNome: ${lead.nome}\nOrigem: ${lead.origem}\nNota atual: ${lead.nota ?? "sem nota"}\nHistórico:\n${historico}\n\nResponda SOMENTE com JSON válido neste formato exato:\n{"intencao":"alta|media|baixa","nota":0,"resumo":"2 frases","proximoPasso":"ação concreta para o dono","statusSugerido":"novo|qualificado|negociando|fechado|perdido"}`;
      const melhor = provedores.find(p => p.id === "gemini") || provedores[0];
      if (!melhor) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Nenhuma IA configurada." }));
      }
      try {
        const texto = await melhor.perguntar(pergunta);
        const limpo = texto.replace(/```json|```/g, "").trim();
        const inicio = limpo.indexOf("{");
        const fim = limpo.lastIndexOf("}");
        const raiox = inicio >= 0 && fim > inicio ? JSON.parse(limpo.slice(inicio, fim + 1)) : null;
        lead.raiox = Object.assign({ gerado: `${hoje()} ${horaAgora()}` }, raiox || {});
        if (raiox?.statusSugerido && ["novo", "qualificado", "negociando", "fechado", "perdido"].includes(raiox.statusSugerido)) {
          lead.status = raiox.statusSugerido;
        }
        salvarJSON(ARQ_LEADS, leads);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, raiox: lead.raiox, lead }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }

    if (req.method === "POST" && req.url === "/api/atendimento") {
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const leads = lerLeads();
      const whatsapp = limparTexto(corpo.whatsapp);
      let lead = null;
      if (corpo.leadId) {
        lead = leads.find(l => l.id === corpo.leadId) || null;
      } else if (whatsapp) {
        lead = leads.find(l => l.whatsapp === whatsapp) || null;
      }
      if (!lead) {
        lead = {
          id: novoId(),
          nome: limparTexto(corpo.nome) || "Visitante",
          whatsapp,
          origem: limparTexto(corpo.origem) || "atendimento",
          status: "novo",
          nota: null,
          valor: null,
          consentimento: true,
          raiox: null,
          mensagens: [],
          criado: `${hoje()} ${horaAgora()}`,
          ultimoContato: hoje()
        };
        leads.push(lead);
      } else {
        if (!lead.nome || lead.nome === "Visitante") lead.nome = limparTexto(corpo.nome) || lead.nome;
      }
      salvarJSON(ARQ_LEADS, leads);
      try {
        const r = await responderLead(lead.id, corpo.mensagem);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, leadId: lead.id, resposta: r.resposta }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }

    if (req.method === "GET" && req.url === "/api/contratos") {
      if (!precisaAuth(req, res)) return;
      const leads = lerLeads();
      const contratos = lerContratos().sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
      const comNome = contratos.map(c => ({ ...c, leadNome: leads.find(l => l.id === c.leadId)?.nome || "Lead removido" }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ contratos: comNome }));
    }

    if (req.method === "POST" && req.url === "/api/contratos") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const titulo = limparTexto(corpo.titulo) || "Contrato";
      const corpoTexto = String(corpo.corpo || "").trim();
      if (!corpo.leadId || !corpoTexto) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Lead e corpo do contrato são obrigatórios." }));
      }
      const contratos = lerContratos();
      const contrato = {
        id: novoId(),
        leadId: corpo.leadId,
        titulo,
        corpo: corpoTexto.slice(0, 30000),
        valor: corpo.valor === "" || corpo.valor === null || corpo.valor === undefined ? null : Number(corpo.valor),
        status: "rascunho",
        criado: `${hoje()} ${horaAgora()}`,
        assinado: null,
        assinante: null
      };
      contratos.push(contrato);
      salvarJSON(ARQ_CONTRATOS, contratos);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, contrato }));
    }

    if (req.method === "GET" && req.url.startsWith("/api/contratos/")) {
      const id = req.url.split("/")[3];
      const contratos = lerContratos();
      const contrato = contratos.find(c => c.id === id);
      if (!contrato) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Contrato não encontrado." }));
      }
      const leads = lerLeads();
      const lead = leads.find(l => l.id === contrato.leadId) || null;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ contrato, lead }));
    }

    if (req.method === "POST" && req.url.startsWith("/api/contratos/") && req.url.endsWith("/assinar")) {
      const id = req.url.split("/")[3];
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const contratos = lerContratos();
      const contrato = contratos.find(c => c.id === id);
      if (!contrato) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Contrato não encontrado." }));
      }
      const nome = limparTexto(corpo.nome);
      const cpf = limparTexto(corpo.cpf);
      if (!nome || !cpf) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Nome e CPF são obrigatórios para assinar." }));
      }
      contrato.status = "assinado";
      contrato.assinado = `${hoje()} ${horaAgora()}`;
      contrato.assinante = { nome, cpf };
      salvarJSON(ARQ_CONTRATOS, contratos);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, contrato }));
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/contratos")) {
      if (!precisaAuth(req, res)) return;
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      let contratos = lerContratos();
      contratos = contratos.filter(c => c.id !== id);
      salvarJSON(ARQ_CONTRATOS, contratos);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === "GET" && req.url === "/api/cobrancas") {
      if (!precisaAuth(req, res)) return;
      const leads = lerLeads();
      const cobrancas = lerCobrancas().sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
      const comNome = cobrancas.map(c => ({ ...c, leadNome: leads.find(l => l.id === c.leadId)?.nome || "Lead removido" }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ cobrancas: comNome }));
    }

    if (req.method === "POST" && req.url === "/api/cobrancas") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const valor = Number(corpo.valor);
      if (!corpo.leadId || !(valor > 0)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Lead e valor são obrigatórios." }));
      }
      const empresa = lerEmpresa();
      if (!empresa.pix_chave) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Configure a chave PIX em Configurações primeiro." }));
      }
      const descricao = limparTexto(corpo.descricao) || "Cobrança";
      const brcode = gerarBrcodePix({
        chave: empresa.pix_chave,
        nome: empresa.pix_nome || empresa.nome,
        cidade: empresa.pix_cidade || "BRASIL",
        valor
      });
      const cobrancas = lerCobrancas();
      const cobranca = {
        id: novoId(),
        leadId: corpo.leadId,
        descricao,
        valor,
        brcode,
        criado: `${hoje()} ${horaAgora()}`,
        pago: false,
        pagoEm: null
      };
      cobrancas.push(cobranca);
      salvarJSON(ARQ_COBRANCAS, cobrancas);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, cobranca }));
    }

    if (req.method === "POST" && req.url.startsWith("/api/cobrancas/") && req.url.endsWith("/pagar")) {
      if (!precisaAuth(req, res)) return;
      const id = req.url.split("/")[3];
      const cobrancas = lerCobrancas();
      const cobranca = cobrancas.find(c => c.id === id);
      if (!cobranca) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Cobrança não encontrada." }));
      }
      cobranca.pago = true;
      cobranca.pagoEm = `${hoje()} ${horaAgora()}`;
      salvarJSON(ARQ_COBRANCAS, cobrancas);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, cobranca }));
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/cobrancas")) {
      if (!precisaAuth(req, res)) return;
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      let cobrancas = lerCobrancas();
      cobrancas = cobrancas.filter(c => c.id !== id);
      salvarJSON(ARQ_COBRANCAS, cobrancas);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === "GET" && req.url === "/api/financeiro") {
      if (!precisaAuth(req, res)) return;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(calcularResumoFinanceiro()));
    }

    if (req.method === "POST" && req.url === "/api/financeiro/lancar") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      if (!["entrada", "saida"].includes(corpo.tipo) || !(Number(corpo.valor) > 0)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "tipo (entrada/saida) e valor são obrigatórios." }));
      }
      const lista = lerFinanceiro();
      lista.push({
        id: novoId(),
        tipo: corpo.tipo,
        categoria: limparTexto(corpo.categoria) || "geral",
        descricao: limparTexto(corpo.descricao),
        valor: Number(corpo.valor),
        data: corpo.data || hoje(),
        criado: `${hoje()} ${horaAgora()}`
      });
      salvarFinanceiro(lista);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, resumo: calcularResumoFinanceiro() }));
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/financeiro")) {
      if (!precisaAuth(req, res)) return;
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      let lista = lerFinanceiro();
      lista = lista.filter(l => l.id !== id);
      salvarFinanceiro(lista);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, resumo: calcularResumoFinanceiro() }));
    }

    if (req.method === "POST" && req.url === "/api/ceo") {
      if (!precisaAuth(req, res)) return;
      const corpo = JSON.parse((await lerCorpo(req)) || "{}");
      const pergunta = String(corpo.pergunta || "").trim();
      if (!pergunta) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "Pergunta vazia." }));
      }
      const melhor = provedores[0];
      if (!melhor) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ aviso: "Nenhuma IA configurada." }));
      }
      try {
        const contexto = contextoFinanceiroParaIA();
        const instrucao = `Você é o CEO IA, consultor de negócios de uma empresa brasileira.
Use SOMENTE os dados financeiros fornecidos para responder, com números reais.
Se não tiver o dado, diga claramente que não tem. Não prometa resultados garantidos.
Responda em português do Brasil, direto ao ponto, como um consultor experiente.
Quando relevante, aponte o que está bom, o que preocupa e 1-2 ações concretas.${contexto}`;
        const resposta = await melhor.perguntarComInstrucao(instrucao, pergunta);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ resposta, modelo: melhor.nome, resumo: calcularResumoFinanceiro() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }

    const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const arquivo = path.join(PUBLIC, path.normalize(url));
    if (!arquivo.startsWith(PUBLIC) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Página não encontrada.");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(arquivo)] || "application/octet-stream" });
    fs.createReadStream(arquivo).pipe(res);
  } catch (e) {
    if (res.headersSent) {
      return res.end();
    }
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ erro: e.message }));
  }
});

const porta = Number(process.env.PORT) || Number(config.porta) || 3000;
server.listen(porta, "0.0.0.0", () => {
  const ativos = provedores.map(p => p.nome).join(", ") || "nenhum (edite o config.json)";
  console.log("==============================================");
  console.log("  Multi PH rodando!");
  console.log(`  Abra no navegador: http://localhost:${porta}`);
  console.log(`  IAs conectadas: ${ativos}`);
  console.log(`  Resumo diário automático: às ${Number(config.hora_diario) || 6}:00`);
  console.log("==============================================");
});
agendarRotinaDiaria();
