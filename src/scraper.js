import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.unimedourinhos.com.br/portal-pf';

/**
 * Fetch helper com suporte a cookies de sessão.
 */
async function fetchWithCookies(jar, url, options = {}) {
  const cookieHeader = await jar.getCookieString(url);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    ...options.headers,
  };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const res = await fetch(url, { ...options, headers });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    await jar.setCookie(cookie, url).catch(() => {});
  }

  return res;
}

/**
 * Faz login no portal Unimed Ourinhos, busca o boleto mais recente,
 * obtém o código de barras via /boletos/copy-code e baixa o PDF via
 * /boletos/imprimir/:numero/:cpf.
 *
 * @param {object} config
 * @param {string} config.cpf
 * @param {string} config.password
 * @param {string} config.downloadDir
 * @returns {Promise<{barcode: string, dueDate: string, amount: string, pdfPath: string|null}>}
 */
export async function fetchBoleto({ cpf, password, downloadDir }) {
  fs.mkdirSync(downloadDir, { recursive: true });

  const jar = new CookieJar();
  const cpfClean = cpf.replace(/\D/g, '');
  const cpfFormatted = cpfClean.length === 11
    ? `${cpfClean.slice(0,3)}.${cpfClean.slice(3,6)}.${cpfClean.slice(6,9)}-${cpfClean.slice(9)}`
    : cpf;

  // ── 1. Login ────────────────────────────────────────────────────────────────
  console.log('[scraper] Fazendo login no portal Unimed...');

  const loginRes = await fetchWithCookies(jar, `${BASE}/login/acccess`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      'login[document]': cpfFormatted,
      'login[password]': password,
    }).toString(),
  });

  if (!loginRes.ok) {
    throw new Error(`Login falhou com status HTTP ${loginRes.status}`);
  }

  const loginText = await loginRes.text();
  let loginData;
  try {
    loginData = JSON.parse(loginText);
  } catch {
    throw new Error(`Resposta inesperada do login (não é JSON): ${loginText.slice(0, 200)}`);
  }

  if (loginData.status !== 'success') {
    throw new Error(`Credenciais inválidas: ${loginData.message}`);
  }

  console.log('[scraper] Login OK. Buscando lista de boletos...');

  // ── 2. Busca a página de boletos para extrair o número do boleto ─────────────
  const boletosRes = await fetchWithCookies(jar, `${BASE}/boletos`);

  if (!boletosRes.ok) {
    throw new Error(`Erro ao acessar página de boletos: HTTP ${boletosRes.status}`);
  }

  const html = await boletosRes.text();

  if (html.includes('form_login') && !html.includes('boleto')) {
    throw new Error('Sessão não persistiu após o login. Tente novamente.');
  }

  // ── 3. Extrai número do boleto e dados da tabela ─────────────────────────────
  // Busca por: <a href="boletos/billet/498118" ...> dentro de <td>
  const $ = cheerio.load(html);

  let boletoNumber = null;
  let dueDate = '';
  let amount = '';

  $('a[href^="boletos/billet/"]').each((_, el) => {
    if (boletoNumber) return; // pega apenas o primeiro (mais recente)
    const href = $(el).attr('href') || '';
    const match = href.match(/boletos\/billet\/(\d+)/);
    if (match) {
      boletoNumber = match[1];

      // Navega para a linha da tabela que contém esse link para pegar vencimento e valor
      const row = $(el).closest('tr');
      row.find('td').each((i, td) => {
        const text = $(td).text().trim();
        // Detecta data no formato dd/mm/aaaa
        if (!dueDate && /^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
          dueDate = text;
        }
        // Detecta valor monetário
        if (!amount && /^R\$\s?[\d.,]+$/.test(text)) {
          amount = text;
        }
      });
    }
  });

  if (!boletoNumber) {
    console.warn('[scraper] HTML da página de boletos capturado para diagnóstico:');
    console.warn(html.slice(0, 3000));
    throw new Error('Número do boleto não encontrado. Verifique o HTML acima.');
  }

  console.log(`[scraper] Boleto encontrado: #${boletoNumber} | Vencimento: ${dueDate} | Valor: ${amount}`);

  // ── 4. Obtém o código de barras via /boletos/copy-code ───────────────────────
  console.log('[scraper] Obtendo código de barras...');

  const copyCodeRes = await fetchWithCookies(jar, `${BASE}/boletos/copy-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: `number=${boletoNumber}`,
  });

  if (!copyCodeRes.ok) {
    throw new Error(`Falha ao obter código de barras: HTTP ${copyCodeRes.status}`);
  }

  const copyCodeText = await copyCodeRes.text();
  let barcode = '';
  try {
    const copyCodeData = JSON.parse(copyCodeText);
    if (copyCodeData.status !== 'success') {
      throw new Error(`Erro ao obter código de barras: ${copyCodeData.message}`);
    }
    barcode = copyCodeData.message ?? '';
  } catch {
    throw new Error(`Resposta inesperada de /boletos/copy-code: ${copyCodeText.slice(0, 200)}`);
  }

  console.log(`[scraper] Código de barras: ${barcode}`);

  // ── 5. Busca HTML do boleto para extrair vencimento e valor atualizados ────────
  // O endpoint /imprimir retorna HTML com os dados da 2ª via (com juros se atrasado)
  const boletoUrl = `${BASE}/boletos/imprimir/${boletoNumber}/0000${cpfClean}`;
  console.log(`[scraper] Buscando dados atualizados do boleto: ${boletoUrl}`);

  const boletoRes = await fetchWithCookies(jar, boletoUrl);

  let pdfPath = null;

  if (boletoRes.ok) {
    const contentType = boletoRes.headers.get('content-type') ?? '';
    console.log(`[scraper] Content-Type do endpoint /imprimir: ${contentType}`);

    if (contentType.includes('text/html')) {
      // O endpoint retornou HTML — extrai vencimento e valor atualizados
      const boletoHtml = await boletoRes.text();

      // Salva o HTML em disco para inspeção
      const debugPath = path.join(downloadDir, 'debug-imprimir.html');
      fs.writeFileSync(debugPath, boletoHtml);
      console.log(`[scraper] HTML do /imprimir salvo para inspeção: ${debugPath}`);

      const $boleto = cheerio.load(boletoHtml);

      $boleto('*').each((_, el) => {
        const text = $boleto(el).children().length === 0 ? $boleto(el).text().trim() : '';
        if (!text) return;
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) dueDate = text;
        if (/^R\$\s?[\d.,]+$/.test(text)) amount = text;
      });

      console.log(`[scraper] Dados atualizados — Vencimento: ${dueDate} | Valor: ${amount}`);

      // Se o HTML contiver um link para o PDF, baixa o arquivo
      const $boletoPage = cheerio.load(boletoHtml);
      const pdfLink = $boletoPage('a[href$=".pdf"], a[href*="download"]').first().attr('href');
      if (pdfLink) {
        const fullPdfUrl = pdfLink.startsWith('http') ? pdfLink : `${BASE}/${pdfLink.replace(/^\//, '')}`;
        const pdfRes = await fetchWithCookies(jar, fullPdfUrl);
        if (pdfRes.ok) {
          const filename = `boleto-unimed-${new Date().toISOString().slice(0, 10)}.pdf`;
          pdfPath = path.join(downloadDir, filename);
          fs.writeFileSync(pdfPath, Buffer.from(await pdfRes.arrayBuffer()));
          console.log(`[scraper] PDF salvo em: ${pdfPath}`);
        }
      }
    } else {
      // O endpoint retornou o PDF diretamente
      const filename = `boleto-unimed-${new Date().toISOString().slice(0, 10)}.pdf`;
      pdfPath = path.join(downloadDir, filename);
      fs.writeFileSync(pdfPath, Buffer.from(await boletoRes.arrayBuffer()));
      console.log(`[scraper] PDF salvo em: ${pdfPath}`);
    }
  } else {
    console.warn(`[scraper] Falha ao acessar endpoint do boleto: HTTP ${boletoRes.status}`);
  }

  return { barcode, dueDate, amount, pdfPath };
}


