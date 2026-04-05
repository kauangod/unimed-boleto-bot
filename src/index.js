import 'dotenv/config';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fetchBoleto } from './scraper.js';
import { createClient, waitForReady, sendBoletoToGroup } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Controle de envio mensal: evita enviar o boleto mais de uma vez por mês
const sentFlagFile = path.resolve('./downloads/.sent_flag');

function getSentMonth() {
  try {
    return fs.readFileSync(sentFlagFile, 'utf8').trim();
  } catch {
    return null;
  }
}

function markAsSent() {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  fs.mkdirSync(path.dirname(sentFlagFile), { recursive: true });
  fs.writeFileSync(sentFlagFile, key, 'utf8');
}

function alreadySentThisMonth() {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return getSentMonth() === key;
}

// Retorna true se hoje é dia 5 ou dia 6 (fallback caso o processo não estava rodando no dia 5)
function isSendDay() {
  const day = new Date().getDate();
  return day === 5 || day === 6;
}

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
  // Roda a cada hora nos dias 5 e 6; o controle de mês evita envios duplicados
  cronSchedule: process.env.CRON_SCHEDULE || '0 0 * 5,6 * *',
};

/**
 * Executa o fluxo completo: scraping → envio WhatsApp.
 */
let running = false;
async function run(client, { force = false } = {}) {
  if (running) {
    console.log('[main] Execução já em andamento, ignorando gatilho duplicado.');
    return;
  }
  if (!force && alreadySentThisMonth()) {
    console.log('[main] Boleto já enviado este mês. Pulando.');
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
    markAsSent();
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

  // Dispara execução imediata ao receber SIGUSR2 (usado pelo script "npm run now")
  process.on('SIGUSR2', () => {
    console.log('[main] Sinal SIGUSR2 recebido. Executando agora...');
    run(client, { force: true });
  });

  // Verifica ao iniciar: se hoje é dia 5 ou 6 e ainda não enviou este mês, envia agora
  if (isSendDay() && !alreadySentThisMonth()) {
    console.log(`[main] Hoje é dia ${new Date().getDate()} e o boleto ainda não foi enviado este mês. Executando agora...`);
    run(client);
  }

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

