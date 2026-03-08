/**
 * Script auxiliar para autenticar o WhatsApp separadamente.
 * Execute uma vez: npm run setup-whatsapp
 * Escaneie o QR code e aguarde "Cliente pronto." antes de fechar.
 */
import { createClient, waitForReady } from './whatsapp.js';

const client = createClient();
console.log('[setup] Inicializando WhatsApp...');
console.log('[setup] Escaneie o QR code quando aparecer.\n');

client.initialize();

waitForReady(client, 180000)
  .then(async () => {
    const info = client.info;
    console.log(`\n[setup] ✅ WhatsApp autenticado com sucesso!`);
    console.log(`[setup] Número: ${info?.wid?.user}`);
    console.log(`[setup] Nome: ${info?.pushname}`);
    console.log('\n[setup] Sessão salva em .wwebjs_auth/. Agora você pode rodar: npm start');
    await client.destroy();
    process.exit(0);
  })
  .catch((err) => {
    console.error('[setup] Falha:', err.message);
    process.exit(1);
  });
