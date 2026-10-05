import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';

const { Client, LocalAuth } = pkg;
const chromeCandidates = [
  process.env.CHROME_EXECUTABLE_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

function resolveChromeExecutablePath() {
  return chromeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
}

// Pin da versão do WhatsApp Web: builds novas (ex.: 2.3000.1047086005, set/2026)
// travam no restore de sessão — autenticam mas nunca chegam ao estado 'ready'.
// Bug conhecido do wwebjs, sem fix oficial até o momento.
// Ref: https://github.com/wwebjs/whatsapp-web.js/issues/127084
// A build abaixo é a última conhecida como funcional (24/08–09/09) e já está
// cacheada em ./.wwebjs_cache — nenhum download é necessário.
const WEB_VERSION = process.env.WEB_VERSION || '2.3000.1045862343';

/**
 * Cria e inicializa o cliente WhatsApp com autenticação persistente.
 * Na primeira execução, exibe o QR code para autenticar.
 */
export function createClient() {
  const executablePath = resolveChromeExecutablePath();

  if (!executablePath) {
    console.warn(
      '[whatsapp] Chrome/Chromium não encontrado no sistema. ' +
      'Defina CHROME_EXECUTABLE_PATH ou rode `npx puppeteer browsers install chrome`.',
    );
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    webVersion: WEB_VERSION,
    webVersionCache: { type: 'local', path: './.wwebjs_cache' },
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n[whatsapp] Sessão não encontrada. Escaneie o QR code abaixo com seu WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[whatsapp] Carregando... ${percent}% — ${message}`);
  });

  client.on('authenticated', () => {
    console.log('[whatsapp] Sessão restaurada. Aguardando o cliente ficar pronto...');
  });

  client.on('auth_failure', (msg) => {
    console.error('[whatsapp] Falha na autenticação:', msg);
  });

  client.on('ready', () => {
    console.log('[whatsapp] Cliente pronto.');
  });

  client.on('disconnected', (reason) => {
    console.warn('[whatsapp] Desconectado:', reason);
  });

  return client;
}

/**
 * Aguarda o cliente estar pronto.
 * @param {import('whatsapp-web.js').Client} client
 * @param {number} timeoutMs
 */
export function waitForReady(client, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (client.info) return resolve(); // já está pronto

    const timer = setTimeout(() => reject(new Error('Timeout aguardando WhatsApp ficar pronto')), timeoutMs);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });

    client.once('auth_failure', (msg) => {
      clearTimeout(timer);
      reject(new Error(`Falha de autenticação WhatsApp: ${msg}`));
    });
  });
}

/**
 * Envia o boleto para um grupo do WhatsApp.
 *
 * Erros lançados AQUI depois do lookup do grupo recebem `sendAttempted = true`
 * quando o envio pode ter sido entregue mesmo com erro (timeout do protocolo):
 * o evaluate pode travar no Node depois de a mensagem já ter saído no browser.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {object} params
 * @param {string} params.groupName - Nome exato do grupo
 * @param {string} params.barcode - Linha digitável
 * @param {string} params.dueDate - Data de vencimento
 * @param {string} params.amount - Valor
 */
export async function sendBoletoToGroup(client, { groupName, barcode, dueDate, amount }) {
  // Busca o chat do grupo pelo nome.
  // Workaround: client.getChats() quebra com erro minificado "r: r" desde o update
  // de jul/2026 do WhatsApp Web (rename id._serialized → id.$1 / chat IDs LID).
  // Lemos a coleção direto no contexto da página, ignorando chats inválidos.
  // Ref: https://github.com/wwebjs/whatsapp-web.js/issues/201845
  const groups = await client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    return chats
      .filter((c) => c.id && typeof c.id._serialized === 'string' && c.id._serialized.endsWith('@g.us'))
      .map((c) => ({
        name: c.name || c.formattedTitle || '',
        id: c.id._serialized,
      }));
  });
  const group = groups.find((g) => g.name === groupName);

  if (!group) {
    const available = groups.map((g) => `"${g.name}"`).join(', ');
    throw new Error(`Grupo "${groupName}" não encontrado. Grupos disponíveis: ${available}`);
  }

  // Monta a mensagem
  const today = new Date().toLocaleDateString('pt-BR');
  const message =
    `🏥 *Boleto Unimed Ourinhos - 2ª Via*\n\n` +
    `📋 *Vencimento original:* ${dueDate || 'N/D'}\n` +
    `📅 *Vencimento 2ª via:* ${today}\n` +
    `💰 *Valor:* ${amount || 'N/D'}\n\n` +
    `📌 *Linha Digitável:*\n\`${barcode || 'N/D'}\`\n\n` +
    `_Boleto gerado automaticamente pelo sistema._`;

  console.log(`[whatsapp] Enviando mensagem para o grupo "${groupName}"...`);
  try {
    await client.sendMessage(group.id, message);
  } catch (err) {
    // Timeout do protocolo do Puppeteer: a mensagem pode ter sido entregue no
    // browser mesmo com o evaluate travando no Node. Marca como "tentativa de
    // envio feita" para o chamador decidir (evita duplicar mensagem em retry).
    if (err.message && /timed out|ProtocolError|Target closed/i.test(err.message)) {
      err.sendAttempted = true;
    }
    throw err;
  }

  console.log('[whatsapp] Mensagem enviada com sucesso!');
}
