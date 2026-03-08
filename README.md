# 🏥 Automação de 2ª Via de Boleto - Unimed Ourinhos

Busca automaticamente o boleto mensal do plano na Unimed Ourinhos e envia o código de barras, vencimento, valor e o PDF para um grupo do WhatsApp.

---

## ⚙️ Como funciona

1. **Requisições HTTP** fazem login no [portal da Unimed Ourinhos](https://www.unimedourinhos.com.br/portal-pf/boletos) usando a API interna do portal (`POST /portal-pf/login/acccess`) com cookies de sessão
2. Um GET em `/portal-pf/boletos` retorna o HTML da lista, que o **cheerio** analisa para encontrar o número do boleto (ex.: `999999`) no padrão `<a href="boletos/billet/999999">`
3. Um POST em `/portal-pf/boletos/copy-code` com `number=999999` (form-encoded) retorna a linha digitável no campo `message` do JSON
4. O PDF é baixado via GET em `/portal-pf/boletos/imprimir/999999/0000SEU_CPF`
5. O **whatsapp-web.js** envia a mensagem com vencimento original, vencimento da 2ª via (data de envio), valor e linha digitável — seguida do PDF em anexo
6. Um **cron job** dispara automaticamente todo mês (padrão: dia 5 às 08:00, horário de Brasília)

> **Sobre o vencimento:** o portal não atualiza o vencimento no HTML da listagem quando o pagamento atrasa. Por isso a mensagem mostra o **vencimento original** (extraído da listagem) e o **vencimento da 2ª via** (data em que o boleto foi gerado/enviado).

---

## 🚀 Configuração

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar credenciais

```bash
cp .env.example .env
```

Edite o arquivo `.env`:

```env
UNIMED_CPF=000.000.000-00          # Seu CPF (com ou sem pontuação)
UNIMED_PASSWORD=sua_senha           # Senha do portal Unimed
WHATSAPP_GROUP_NAME=Nome do Grupo  # Nome EXATO do grupo no WhatsApp
CRON_SCHEDULE=0 0 8 5 * *         # Dia 5 de cada mês às 08:00
DOWNLOAD_DIR=./downloads           # Pasta para salvar o PDF
```

> **Sobre o nome do grupo:** deve ser idêntico ao que aparece no WhatsApp, incluindo acentos e espaços. Veja a seção de solução de problemas para listar seus grupos.

### 3. ⚠️ Autenticar o WhatsApp (obrigatório, apenas na primeira vez)

O serviço roda em background sem terminal, por isso **você precisa autenticar o WhatsApp antes de iniciar o serviço** — caso contrário o QR code não terá como ser exibido.

```bash
npm run setup-whatsapp
```

Escaneie o QR code com seu WhatsApp (Configurações → Aparelhos conectados → Conectar aparelho) e aguarde a mensagem `✅ WhatsApp autenticado com sucesso!`.

A sessão fica salva em `.wwebjs_auth/` e é restaurada automaticamente em toda inicialização. **Você só precisará repetir este passo se a sessão expirar ou se deletar a pasta `.wwebjs_auth/`.**

### 4. Iniciar o serviço com systemd

Crie o arquivo `/etc/systemd/system/unimed-boleto.service`:

```ini
[Unit]
Description=Automação de Boleto Unimed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=SEU_USUARIO
WorkingDirectory=/home/SEU_USUARIO/Documents/unimed-duplicate-invoice
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Em seguida:

```bash
sudo systemctl enable unimed-boleto   # ativa no boot
sudo systemctl start unimed-boleto    # inicia agora
```

A partir daí o serviço **inicia automaticamente toda vez que o computador ligar** e aguarda o horário do cron para executar. Você não precisa fazer mais nada.

---

## ▶️ Execução manual

Para forçar o envio imediato sem esperar o cron (útil para testar ou para quando o mês já começou):

```bash
npm run now
```

Este comando **não inicia um novo processo** — ele envia um sinal (`SIGUSR2`) para o serviço que já está rodando em background, que então executa o envio imediatamente. O serviço continua ativo normalmente após o envio.

> ⚠️ Não use `npm start` manualmente se o serviço systemd já estiver ativo — isso criaria duas instâncias conflitando pelo mesmo Chrome.

Para acompanhar o que está acontecendo em tempo real:

```bash
journalctl -u unimed-boleto -f
```

---

## 🐛 Solução de problemas

### "Grupo não encontrado"

O nome do grupo precisa ser **exatamente igual** ao que aparece no WhatsApp. Execute o comando abaixo para listar todos os grupos disponíveis:

```bash
node --input-type=module <<'EOF'
import 'dotenv/config';
import { createClient, waitForReady } from './src/whatsapp.js';
const c = createClient(); c.initialize();
await waitForReady(c);
const chats = await c.getChats();
chats.filter(ch => ch.isGroup).forEach(g => console.log(g.name));
await c.destroy(); process.exit(0);
EOF
```

### "Número do boleto não encontrado"

O HTML da página de boletos será impresso no terminal para diagnóstico. Verifique se o padrão `<a href="boletos/billet/NUMERO">` está presente e, se necessário, ajuste o seletor no arquivo `src/scraper.js`.

### "Código de barras não encontrado"

O endpoint `/boletos/copy-code` retorna `{"status":"success","message":"CODIGO"}`. Se a estrutura mudar, a resposta completa será impressa no terminal — atualize a leitura de `copyCodeData.message` em `src/scraper.js`.

### Serviço travando ao iniciar

Provavelmente arquivos de lock do Chrome ficaram presos de uma execução anterior. O próprio script os remove automaticamente ao iniciar, mas se persistir:

```bash
rm .wwebjs_auth/session/SingletonLock .wwebjs_auth/session/SingletonCookie
sudo systemctl restart unimed-boleto
```

---

## 👤 Contribuições

**Kauan** — idealizador e engenharia reversa do portal:

- Identificou a necessidade da automação (boleto mensal sem envio automático)
- Descobriu o padrão HTML `<a href="boletos/billet/498118">` para extrair o número do boleto
- Identificou o endpoint `/boletos/copy-code`, seu formato correto (`application/x-www-form-urlencoded`) e que o código de barras vem no campo `message` do JSON de resposta
- Identificou o endpoint `/boletos/imprimir/:numero/0000:cpf` para download do PDF, incluindo o prefixo `0000` antes do CPF
- Apontou que o vencimento da listagem é sempre o original, levando à exibição separada de "vencimento original" e "vencimento 2ª via"
- Diagnosticou o conflito entre `SIGUSR1` e o debugger interno do Node.js, que levou ao uso de `SIGUSR2`
- Configurou e validou o serviço systemd em produção

```
unimed-duplicate-invoice/
├── src/
│   ├── index.js          # Ponto de entrada + agendador cron + listener SIGUSR2
│   ├── scraper.js        # Scraper HTTP do portal Unimed
│   ├── whatsapp.js       # Cliente whatsapp-web.js + envio
│   └── setup-whatsapp.js # Autenticação inicial via QR code (executar uma vez)
├── downloads/            # PDFs dos boletos baixados (no .gitignore)
├── .wwebjs_auth/         # Sessão do WhatsApp (no .gitignore)
├── .env                  # Suas credenciais (no .gitignore)
├── .env.example          # Modelo de configuração
└── package.json
```
