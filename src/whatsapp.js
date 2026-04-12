import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

const { Client, LocalAuth, MessageMedia } = pkg;

/**
 * Cria e inicializa o cliente WhatsApp com autenticação persistente.
 * Na primeira execução, exibe o QR code para autenticar.
 */
export function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
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
 * @param {import('whatsapp-web.js').Client} client
 * @param {object} params
 * @param {string} params.groupName - Nome exato do grupo
 * @param {string} params.barcode - Linha digitável
 * @param {string} params.dueDate - Data de vencimento
 * @param {string} params.amount - Valor
 * @param {string|null} params.pdfPath - Caminho para o PDF do boleto
 */
export async function sendBoletoToGroup(client, { groupName, barcode, dueDate, amount, pdfPath }) {
  // Busca o chat do grupo pelo nome
  const chats = await client.getChats();
  const group = chats.find((chat) => chat.isGroup && chat.name === groupName);

  if (!group) {
    const available = chats.filter((c) => c.isGroup).map((c) => `"${c.name}"`).join(', ');
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
  await group.sendMessage(message);

  // Envia o PDF como anexo, se disponível
  if (pdfPath && fs.existsSync(pdfPath)) {
    console.log('[whatsapp] Enviando PDF do boleto...');
    const media = MessageMedia.fromFilePath(pdfPath);
    await group.sendMessage(media, { caption: '📄 Boleto Unimed Ourinhos (PDF)' });
  } else if (pdfPath) {
    console.warn(`[whatsapp] PDF não encontrado em: ${pdfPath}`);
  }

  console.log('[whatsapp] Mensagem enviada com sucesso!');
}
