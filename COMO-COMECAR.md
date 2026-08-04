# Sistema Multi-IA — Como começar (passo a passo)

Um sistema que envia sua pergunta para **várias IAs ao mesmo tempo**, mostra as respostas lado a lado e ainda pode juntar tudo num resumo único.

**Custo: R$ 0.** Todas as chaves abaixo são gratuitas, sem cartão de crédito.

---

## Passo 0 — O que você precisa
- Node.js já instalado (você tem).
- 5 minutos para criar as chaves gratuitas.

---

## Passo 1 — Criar as chaves grátis (faça pelo menos 1, quanto mais melhor)

### Chave do Google Gemini (recomendada — 1.500 perguntas/dia)
1. Acesse https://aistudio.google.com e entre com sua conta Google.
2. Clique em **"Get API key"** (no menu lateral).
3. Clique em **"Create API key"** e copie o texto (começa com `AIza...`).
4. Cole no arquivo `config.json`, no campo `gemini_key`.

### Chave do Groq (muito rápida — Llama, 14.400 perguntas/dia)
1. Acesse https://console.groq.com e entre com conta Google/GitHub.
2. No menu, clique em **API Keys** → **Create API Key**.
3. Copie o texto (começa com `gsk_...`) e cole no campo `groq_key` do `config.json`.

### Chave do OpenRouter (acesso a dezenas de modelos grátis)
1. Acesse https://openrouter.ai e crie conta gratuita.
2. No topo, clique em **Keys** (ícone de chave) → **Create Key**.
3. Copie a chave e cole no campo `openrouter_key` do `config.json`.

---

## Passo 2 — Colocar as chaves no config.json

Abra o arquivo `config.json` (na pasta Sistema-Multi-IA) e substitua cada `coloque_aqui_sua_chave_...` pela chave correspondente.

**Exemplo final:**
```json
{
  "porta": 3000,
  "gemini_key": "AIzaSyBx...abc123",
  "groq_key": "gsk_xYz...789",
  "openrouter_key": "sk-or-v1-...xyz"
}
```

> Atenção: nunca compartilhe esse arquivo com ninguém. Se for usar Git, não suba o config.json.

---

## Passo 3 — Rodar o sistema

1. Abra o **PowerShell** dentro da pasta Sistema-Multi-IA.
2. Digite e aperte Enter:
```
node server.js
```
3. Você verá:
```
Sistema Multi-IA rodando!
Abra no navegador: http://localhost:3000
IAs conectadas: Google Gemini, Groq (Llama), OpenRouter
```
4. Abra `http://localhost:3000` no navegador (Chrome/Edge).
5. Digite uma pergunta e clique em **"Perguntar para todas as IAs"**.

Para parar: feche a janela do PowerShell ou pressione Ctrl+C.

---

## Dicas
- **Só uma chave configurada?** Tudo bem — o sistema funciona com quantas você colocar.
- **Erro em uma IA não derruba as outras** — as que funcionam respondem normal.
- A opção **"Combinar respostas"** junta as respostas das IAs num resumo único (usando a primeira IA configurada).
- Limite diário grátis: Gemini 1.500/dia, Groq 14.400/dia. Se atingir, continua no dia seguinte.

---

## Se aparecer erro
| Erro | Causa provável | Solução |
|---|---|---|
| `Nenhuma chave configurada` | config.json sem chaves | Faça o Passo 1 e 2 |
| `API key not valid` | Chave colada errada/incompleta | Copie a chave de novo do site |
| Porta ocupada | Outro programa na porta 3000 | Mude `"porta": 3000` para `3001` no config.json |
| `quota exceeded` | Limite grátis do dia atingido | Use outra IA ou volte amanhã |
