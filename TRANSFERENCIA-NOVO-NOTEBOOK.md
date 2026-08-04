# Transferindo o Multi PH para outro notebook

O Multi PH **não precisa de instalação de bibliotecas** — só o Node.js e as chaves.

## Passo 1 — Instalar o Node.js no novo notebook
1. Acesse https://nodejs.org e baixe a versão LTS (botão verde).
2. Instale clicando em "Avançar" até o fim (padrão).
3. Confira: abra o PowerShell e digite `node --version` — deve mostrar um número.

## Passo 2 — Copiar a pasta
1. Copie a pasta **Sistema-Multi-IA** inteira para o novo notebook
   (ex: Documentos).
2. Confira que dentro dela estão:
   - `server.js` e `config.json` (chaves + porta)
   - `public/` — `index.html`, `negocio.html`, `atendimento.html`, `contrato.html`
   - `dados-diarios/` — histórico dos resumos diários
   - `dados-empresa/` — `empresa.json` (PIX, WhatsApp, regras), `leads.json`, `contratos.json`, `cobrancas.json`, `conhecimento.json`

## Passo 3 — Rodar
1. Abra o PowerShell **dentro da pasta Sistema-Multi-IA**
   (na pasta, clique com o botão direito → "Abrir no Terminal" ou digite `cd` no caminho).
2. Digite e aperte Enter:
```
node server.js
```
3. Abra o navegador em `http://localhost:80` (ou `http://multi-ph` se configurar o hosts, passos abaixo).

## Passo 4 (opcional) — Endereço bonito http://multi-ph
1. Abra o Bloco de Notas **como administrador**.
2. Abra o arquivo: `C:\Windows\System32\drivers\etc\hosts`
3. No final, adicione a linha:
```
127.0.0.1 multi-ph
```
4. Salve e rode o servidor de novo.

## Passo 5 — Conferir as chaves
Abra o `config.json` e veja se as 3 chaves estão lá:
- `gemini_key` (começa com AIza...)
- `groq_key` (começa com gsk_...)
- `openrouter_key` (começa com sk-or-v1-...)

Se alguma faltar, copie do config.json deste notebook.

## Dicas
- **Meu Negócio** (gestão da empresa): `http://multi-ph/negocio.html` — leads, conversas, contratos, PIX, base de conhecimento e configurações.
- **Página de atendimento** (para o cliente): `http://multi-ph/atendimento.html` — chat 24h com a IA usando a base de conhecimento.
- **Assinatura de contrato** (pública, enviada ao cliente): `http://multi-ph/contrato.html?id=...`
- O resumo diário automático roda às 6h (configurável em `config.json` → `hora_diario`), mas **só enquanto o notebook estiver ligado** com o servidor aberto.
- Para parar o servidor: feche a janela ou pressione Ctrl+C.
- Os resumos antigos ficam na pasta `dados-diarios/` (histórico).
- Chave PIX e dados da empresa ficam em `dados-empresa/empresa.json` — já vêm configurados.
