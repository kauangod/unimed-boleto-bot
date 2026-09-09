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

// Janela de envio: dias do mês em que o boleto pode ser enviado (5 = principal,
// 6 e 7 = fallback). O heartbeat abaixo re-checa a condição várias vezes ao dia,
// então funciona mesmo se o computador estava suspenso no horário exato.
const sendDays = (process.env.SEND_DAYS || '5,6,7')
  .split(',')
  .map((d) => parseInt(d.trim(), 10))
  .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);

// Retorna true se hoje está dentro da janela de envio
function isSendDay() {
  return sendDays.includes(new Date().getDate());
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
  // Heartbeat frequente em vez de cron de horário fixo: o node-cron perde
  // disparos que caem enquanto o sistema está suspenso (hrtime congela e o
  // scheduler não recupera o momento perdido). Com checagem a cada 20 min,
  // basta o computador acordar uma vez na janela de envio para o boleto sair.
  heartbeatSchedule: process.env.HEARTBEAT_SCHEDULE || '*/20 * * * *',
};

/**
 * Reinicializa o cliente WhatsApp (destroy + initialize + waitForReady).
 * Necessário quando o Puppeteer perde o frame mas o cliente não detecta.
 */
async function reinitClient(client) {
  console.log('[main] Destruindo sessão Puppeteer...');
  await client.destroy().catch((e) =>
    console.warn('[main] Erro ao destruir cliente (ignorado):', e.message),
  );
  // destroy() não limpa client.info — sem isso, waitForReady retorna
  // imediatamente achando que o cliente já está pronto
  client.info = undefined;
  console.log('[main] Reinicializando cliente WhatsApp...');
  try {
    await client.initialize();
  } catch (err) {
    // destroy() às vezes não encerra o Chrome a tempo, e o Puppeteer recusa
    // subir de novo sobre o mesmo userDataDir ("browser is already running").
    // Nesse caso, matamos os processos Chrome órfãos da sessão e tentamos mais uma vez.
    if (err.message && err.message.includes('already running')) {
      console.warn('[main] Chrome órfão segurando a sessão. Encerrando e tentando de novo...');
      const { execSync } = await import('child_process');
      try {
        execSync("pkill -f '.wwebjs_auth/session' || true");
        await new Promise((r) => setTimeout(r, 3000));
      } catch {
        // pkill sem match não é problema
      }
      await client.initialize();
    } else {
      throw err;
    }
  }
  await waitForReady(client, 120000);
  console.log('[main] Cliente WhatsApp reconectado com sucesso.');
}

/**
 * Executa o fluxo completo: scraping → envio WhatsApp.
 * Se o envio falhar por frame desanexado do Puppeteer, reinicializa o
 * cliente e tenta novamente (até 2 retentativas).
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

    const sendParams = {
      groupName: config.groupName,
      barcode: boletoData.barcode,
      dueDate: boletoData.dueDate,
      amount: boletoData.amount,
      pdfPath: boletoData.pdfPath,
    };

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await sendBoletoToGroup(client, sendParams);
        break;
      } catch (err) {
        const isDetachedFrame = err.message && err.message.includes('detached Frame');
        if (!isDetachedFrame || attempt >= maxRetries) throw err;

        console.warn(
          `[main] Frame do Puppeteer desanexado (tentativa ${attempt}/${maxRetries}). ` +
          `Reinicializando cliente WhatsApp...`,
        );
        await reinitClient(client);
      }
    }

    markAsSent();
  } catch (err) {
    console.error('[main] Erro durante a execução:', err);
  } finally {
    running = false;
  }
}

async function main() {
  const client = createClient();

  console.log('[main] Inicializando WhatsApp...');
  client.initialize();

  // 15 min: após encerramentos abruptos repetidos, a sincronização de mensagens
  // do WhatsApp Web recomeça do zero a cada kill — matar cedo demais cria um
  // loop em que o sync nunca completa (página fica em ~99% para sempre).
  await waitForReady(client, 900000);

  // Dispara execução imediata ao receber SIGUSR2 (usado pelo script "npm run now")
  process.on('SIGUSR2', () => {
    console.log('[main] Sinal SIGUSR2 recebido. Executando agora...');
    run(client, { force: true });
  });

  // Verifica ao iniciar: se hoje está na janela de envio e ainda não enviou este mês, envia agora
  if (isSendDay() && !alreadySentThisMonth()) {
    console.log(`[main] Hoje é dia ${new Date().getDate()} (janela de envio) e o boleto ainda não foi enviado este mês. Executando agora...`);
    run(client);
  }

  console.log(`\n[main] Heartbeat agendado para: ${config.heartbeatSchedule}`);
  console.log(`[main] Janela de envio: dias ${sendDays.join(', ')}`);
  console.log(`[main] PID do processo: ${process.pid}`);
  console.log('[main] Aguardando próxima execução...\n');

  // Heartbeat: a cada ciclo, checa se está na janela de envio com boleto pendente.
  // O controle via .sent_flag evita duplicados; o `running` evita sobreposição.
  cron.schedule(config.heartbeatSchedule, () => {
    if (isSendDay() && !alreadySentThisMonth()) {
      console.log('[main] Heartbeat: dentro da janela de envio e boleto pendente. Executando...');
      run(client);
    }
  }, {
    timezone: 'America/Sao_Paulo',
  });
}

main().catch((err) => {
  console.error('[main] Erro fatal:', err);
  process.exit(1);
});

