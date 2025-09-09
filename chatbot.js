// npm i whatsapp-web.js qrcode-terminal puppeteer

const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

// ====== Caminhos usando ENV (Railway) ======
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '.wwebjs_auth');
const LEADS_FILE  = process.env.LEADS_PATH  || path.join(__dirname, 'leads.csv');

// ====== Cliente com sessão persistente e Chromium do container ======
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH // /usr/bin/chromium no Dockerfile
  }
});

const delay = (ms) => new Promise((res) => setTimeout(res, ms));
async function typing(chat, ms = 3000) { await chat.sendStateTyping(); await delay(ms); }

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('Tudo certo! WhatsApp conectado.'));
client.initialize();

// ------------------------ Mensagens ------------------------
const msgs = {
  saudacao(momento) {
    const mapa = { manha: 'Bom Dia', tarde: 'Boa Tarde', noite: 'Boa Noite' };
    return `${mapa[momento]}!\n\nPara agilizar seu atendimento,\nsobre qual assunto deseja falar?\n\n` +
      `1 Abertura de empresa\n` +
      `2 Consultoria tributária\n` +
      `3 Declaração de imposto de renda\n` +
      `4 Serviços de contabilidade mensal\n` +
      `5 Outro assunto`;
  },
  pedirNome: `Perfeito!\nPara retornarmos o contato, preciso de algumas informações:\n\nDigite para mim o seu *nome*.`,
  pedirEmail: `Agora, me diga o seu *e-mail*.`,
  pedirWhats: `Por fim, me fale o seu *WhatsApp* (com DDD).`,
  revisarDados({ nome, email, whatsapp }) {
    return `Você digitou:\n\n` +
           `Nome: ${nome}\n` +
           `E-mail: ${email}\n` +
           `WhatsApp: ${whatsapp}\n\n` +
           `Está correto?\n\n` +
           `*Sim* / *Não*`;
  },
  confirmarOk: `Obrigado pelas informações! ✅\nNossa equipe vai entrar em contato em breve.`,
  confirmarNao: `Sem problemas! Vamos corrigir os dados.`
};

// ------------------------ Utils ------------------------
function momentoDoDia(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'manha';
  if (h >= 12 && h < 18) return 'tarde';
  return 'noite';
}
function normalize(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
}
function isYes(s) { return /\b(sim|confere|correto|ok)\b/i.test(s); }
function isNo(s) { return /\b(nao|não|errado|corrigir)\b/i.test(s); }
function isEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function cleanPhone(s){
  const digits = (s||'').replace(/\D/g,'');
  return digits.length >= 10 ? digits : ''; // aceita 10 ou 11 dígitos com DDD
}

// Cria diretório do arquivo se não existir
function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ------------------------ Salvar lead em CSV ------------------------
function salvarLeadCSV(lead) {
  ensureDirFor(LEADS_FILE);

  const linha = [
    `"${lead.assunto}"`,
    `"${lead.nome}"`,
    `"${lead.email}"`,
    `"${lead.whatsapp}"`,
    `"${lead.origem}"`,
    `"${lead.quando}"`
  ].join(',') + '\n';

  if (!fs.existsSync(LEADS_FILE)) {
    const cabecalho = 'Assunto,Nome,Email,WhatsApp,Origem,Quando\n';
    fs.writeFileSync(LEADS_FILE, cabecalho, { encoding: 'utf8' });
  }
  fs.appendFileSync(LEADS_FILE, linha, { encoding: 'utf8' });
}

// ------------------------ Estado ------------------------
const S = {
  MENU: 'MENU',
  ESCOLHA_ASSUNTO: 'ESCOLHA_ASSUNTO',
  COLETA_NOME: 'COLETA_NOME',
  COLETA_EMAIL: 'COLETA_EMAIL',
  COLETA_WHATS: 'COLETA_WHATS',
  CONFIRMACAO: 'CONFIRMACAO',
  FINAL: 'FINAL',
};

const sessions = new Map(); // key = msg.from -> { state, dados, assunto }

function resetSession(id) {
  sessions.set(id, { state: S.MENU, dados: { nome:'', email:'', whatsapp:'' }, assunto: '' });
}

// ------------------------ Router ------------------------
client.on('message', async (msg) => {
  if (!msg.from.endsWith('@c.us')) return;

  const chat = await msg.getChat();
  const body = (msg.body || '').trim();

  // cria sessão se não existir
  if (!sessions.has(msg.from)) resetSession(msg.from);
  const sess = sessions.get(msg.from);

  // Se o estado for FINAL, responde com mensagem de espera
  if (sess.state === S.FINAL) {
    await typing(chat, 3000);
    await client.sendMessage(msg.from, "Agradecemos pelo contato. Nossa equipe já está analisando suas informações e logo falará com você. Aguarde um momento, por favor.");
    return;
  }

  // 0) MENU -> saudação e vai para escolha do assunto
  if (sess.state === S.MENU) {
    await typing(chat, 3000);
    await client.sendMessage(msg.from, msgs.saudacao(momentoDoDia()));
    sess.state = S.ESCOLHA_ASSUNTO;
    return;
  }

  // 1) Escolha do assunto
  if (sess.state === S.ESCOLHA_ASSUNTO) {
    const n = normalize(body);
    const mapa = {
      '1': 'Abertura de empresa',
      '2': 'Consultoria tributária',
      '3': 'Declaração de imposto de renda',
      '4': 'Serviços de contabilidade mensal',
      '5': 'Outro assunto'
    };
    let assuntoEscolhido = mapa[body] || null;

    if (!assuntoEscolhido) {
      if (/abertura/.test(n) && /empresa/.test(n)) assuntoEscolhido = mapa['1'];
      else if (/consultoria|tributaria|tributária/.test(n)) assuntoEscolhido = mapa['2'];
      else if (/imposto de renda|declarac?a?o|^ir\b/.test(n)) assuntoEscolhido = mapa['3'];
      else if (/contabilidade|mensal/.test(n)) assuntoEscolhido = mapa['4'];
      else if (/outro|duvida|d[uú]vida/.test(n)) assuntoEscolhido = mapa['5'];
    }

    if (!assuntoEscolhido) {
      await typing(chat, 3000);
      return client.sendMessage(msg.from, `Não entendi. Por favor, escolha *1 a 5*.\n\n${msgs.saudacao(momentoDoDia())}`);
    }

    sess.assunto = assuntoEscolhido;
    sess.state = S.COLETA_NOME;
    await typing(chat, 3000);
    return client.sendMessage(msg.from, msgs.pedirNome);
  }

  // 2) Nome
  if (sess.state === S.COLETA_NOME) {
    const nome = body.replace(/\s+/g,' ').trim();
    if (nome.length < 2) {
      await typing(chat, 3000);
      return client.sendMessage(msg.from, `Consegui entender só parcialmente. Pode enviar seu *nome completo*?`);
    }
    sess.dados.nome = nome;
    sess.state = S.COLETA_EMAIL;
    await typing(chat, 3000);
    return client.sendMessage(msg.from, msgs.pedirEmail);
  }

  // 3) E-mail
  if (sess.state === S.COLETA_EMAIL) {
    if (!isEmail(body)) {
      await typing(chat, 3000);
      return client.sendMessage(msg.from, `Hmm, esse e-mail parece inválido. Tente no formato *nome@dominio.com*.`);
    }
    sess.dados.email = body.trim();
    sess.state = S.COLETA_WHATS;
    await typing(chat, 3000);
    return client.sendMessage(msg.from, msgs.pedirWhats);
  }

  // 4) WhatsApp
  if (sess.state === S.COLETA_WHATS) {
    const fone = cleanPhone(body);
    if (!fone) {
      await typing(chat, 3000);
      return client.sendMessage(msg.from, `Não reconheci o número. Envie com *DDD* (ex.: 83996438245).`);
    }
    sess.dados.whatsapp = fone;
    sess.state = S.CONFIRMACAO;
    await typing(chat, 3000);
    return client.sendMessage(msg.from, msgs.revisarDados(sess.dados));
  }

  // 5) Confirmação
  if (sess.state === S.CONFIRMACAO) {
    if (isYes(body)) {
      sess.state = S.FINAL;

      const lead = {
        assunto: sess.assunto,
        nome: sess.dados.nome,
        email: sess.dados.email,
        whatsapp: sess.dados.whatsapp,
        origem: 'WhatsApp',
        quando: new Date().toISOString(),
      };

      // Salva no CSV
      salvarLeadCSV(lead);

      await typing(chat, 3000);
      await client.sendMessage(msg.from, msgs.confirmarOk);
      // NÃO reseta a sessão: o bot fica em "aguarde" até o atendimento humano
      return;
    }

    if (isNo(body)) {
      // Mantém o assunto, mas refaz SOMENTE a coleta dos dados
      sess.dados = { nome: '', email: '', whatsapp: '' };
      sess.state = S.COLETA_NOME;

      await typing(chat, 3000);
      await client.sendMessage(msg.from, msgs.confirmarNao);
      await typing(chat, 3000);
      return client.sendMessage(msg.from, msgs.pedirNome);
    }

    await typing(chat, 3000);
    return client.sendMessage(msg.from, `Por favor, responda *Sim* ou *Não*.\n\n${msgs.revisarDados(sess.dados)}`);
  }

  // Segurança: se cair em estado inesperado e NÃO for FINAL, reinicia
  if (sess.state !== S.FINAL) {
    resetSession(msg.from);
    await typing(chat, 3000);
    await client.sendMessage(msg.from, `Vamos recomeçar.\n\n${msgs.saudacao(momentoDoDia())}`);
  }
});
