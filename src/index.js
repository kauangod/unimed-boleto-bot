import 'dotenv/config';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fetchBoleto } from './scraper.js';
import { createClient, waitForReady, sendBoletoToGroup } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Remove arquivos de lock do Chromium que ficam presos quando o processo é encerrado abruptamente
const lockFiles = [
  '.wwebjs_auth/session/SingletonLock',
  '.wwebjs_auth/session/SingletonCookie',
];
for (const lockFile of lockFiles) {
  try {
    fs.unlinkSync(lockFile);
    console.log(`[main] Lock removido: ${lockFile}`);
  } catch {
    // Arquivo não existe — tudo certo
  }
}

// Valida variáveis obrigatórias
const required = ['UNIMED_CPF', 'UNIMED_PASSWORD', 'WHATSAPP_GROUP_NAME'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`[config] Variáveis de ambiente obrigatórias não definidas: ${missing.join(', ')}`);
  console.error('[config] Copie .env.example para .env e preencha os valores.');
  process.exit(1);
}

const config = {
  cpf: process.env.UNIMED_CPF,
  password: process.env.UNIMED_PASSWORD,
  groupName: process.env.WHATSAPP_GROUP_NAME,
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR || './downloads'),
  cronSchedule: process.env.CRON_SCHEDULE || '0 0 8 5 * *',
};

/**
 * Executa o fluxo completo: scraping → envio WhatsApp.
 */
let running = false;
async function run(client) {
  if (running) {
    console.log('[main] Execução já em andamento, ignorando gatilho duplicado.');
    return;
  }
  running = true;

  console.log('\n========================================');
  console.log('[main] Iniciando busca do boleto Unimed...');
  console.log('========================================\n');

  try {
    const boletoData = await fetchBoleto({
      cpf: config.cpf,
      password: config.password,
      downloadDir: config.downloadDir,
    });
    console.log('[main] Boleto obtido:', {
      barcode: boletoData.barcode,
      dueDate: boletoData.dueDate,
      amount: boletoData.amount,
      pdfPath: boletoData.pdfPath,
    });

    await sendBoletoToGroup(client, {
      groupName: config.groupName,
      barcode: boletoData.barcode,
      dueDate: boletoData.dueDate,
      amount: boletoData.amount,
      pdfPath: boletoData.pdfPath,
    });
  } catch (err) {
    console.error('[main] Erro durante a execução:', err.message);
  } finally {
    running = false;
  }
}

async function main() {
  const client = createClient();

  console.log('[main] Inicializando WhatsApp...');
  client.initialize();

  await waitForReady(client, 120000);

  // Dispara execução imediata ao receber SIGUSR1 (usado pelo script "npm run now")
  process.on('SIGUSR2', () => {
    console.log('[main] Sinal SIGUSR2 recebido. Executando agora...');
    run(client);
  });

  console.log(`\n[main] Agendado para: ${config.cronSchedule}`);
  console.log(`[main] PID do processo: ${process.pid}`);
  console.log('[main] Aguardando próxima execução...\n');

  cron.schedule(config.cronSchedule, () => run(client), {
    timezone: 'America/Sao_Paulo',
  });
}

main().catch((err) => {
  console.error('[main] Erro fatal:', err);
  process.exit(1);
});

