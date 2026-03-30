# LinkedIn Easy Apply - Automação

Automação humanizada para candidaturas em vagas com **Candidatura simplificada** no LinkedIn, com filtro por stack (Node/Nest/TS/JS) e opção **só vagas sênior** (`seniorOnly` no `config.js`).

## ⚠️ Aviso

O LinkedIn proíbe automação nos Termos de Serviço. Use por sua conta e risco. Recomenda-se:

- Máximo 10–15 candidaturas por dia  
- Não rodar em loop 24/7  
- Usar `headless: false` para acompanhar o que o navegador faz  

---

## Instalação

Na pasta do projeto:

```bash
npm install
```

Se o terminal disser que **`npm` não existe** (comum no PowerShell sem Node no PATH):

1. Feche e reabra o terminal (ou o Cursor) depois de instalar o [Node.js LTS](https://nodejs.org).  
2. Ou, nesta sessão:  
   ` $env:Path = "C:\Program Files\nodejs;" + $env:Path `  
3. Ou use os atalhos abaixo (eles acham o `node`/`npm` sozinhos).

---

## Configuração

1. Copie o exemplo:  
   `copy config.example.js config.js` (CMD) ou equivalente.  
2. Edite **`config.js`**:
   - **email** / **password** — login LinkedIn  
   - **searchKeywords** — busca na URL de vagas (ex.: termos + `senior`)  
   - **maxApplications** — limite por execução (`0` = sem limite)  
   - **seniorOnly** — `true` = só candidata se título/descrição tiver termos de **seniorKeywords**  
   - **useExistingChrome** — veja [Como executar](#como-executar)  

---

## Como executar

### Resumo rápido

| Onde roda | `useExistingChrome` | Como subir |
|-----------|---------------------|------------|
| **Windows** (PowerShell/CMD, pasta do projeto) | **`false`** (recomendado) | `cmd /c start.cmd` ou `npm start` (se `npm` estiver no PATH) |
| **WSL** (bash) | **`true`** | Chrome no Windows com CDP + `npm start` no WSL (ver abaixo) |

---

### Windows nativo (recomendado)

1. No **`config.js`**: **`useExistingChrome: false`** — o Playwright abre o Chrome sozinho.  
2. Na pasta do projeto, use **um** destes:

| Comando | Observação |
|---------|------------|
| `npm start` | Precisa de `npm` no PATH. |
| `cmd /c start.cmd` | Coloca Node no PATH só para o CMD e roda o bot. |
| `.\run-bot.cmd` | Igual ao `start.cmd`; use se `.\start.cmd` der erro no PowerShell. |
| `npm run start:win` | Mesmo efeito que `cmd /c start.cmd`. |
| `powershell -ExecutionPolicy Bypass -File .\start.ps1` | Se política de script bloquear o `.ps1`. |

Instalar dependências sem PATH ok:

```bat
cmd /c install.cmd
```

**Política de scripts (PowerShell):** para permitir `.ps1` no seu usuário:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

---

### WSL (Linux dentro do Windows)

O Chromium “do Linux” costuma ter **janela ruim ou invisível**. O fluxo estável é:

1. **`config.js`**: `useExistingChrome: true`, `chromeDebugHost: 'auto'`.  
2. **No Windows**, uma vez como **administrador** (PowerShell), redirecionamento + firewall na **9222**:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9222 connectaddress=127.0.0.1 connectport=9222
New-NetFirewallRule -DisplayName "Chrome DevTools" -Direction Inbound -Protocol TCP -LocalPort 9222 -Action Allow
```

3. **Feche o Chrome no Windows**, depois no WSL (pasta do projeto):

```bash
npm run chrome
```

(Isso abre o Chrome **do Windows** com `--remote-debugging-port=9222` e `--remote-allow-origins=*`.)

4. Teste a porta a partir do WSL:

```bash
npm run chrome:ping
```

5. Inicie o bot:

```bash
npm start
```

**Alternativa:** rode tudo no **Windows** (`useExistingChrome: false` + `cmd /c start.cmd`) e evite WSL para este projeto.

---

### Usar Chrome já aberto (sessão / login guardado)

Útil no Windows ou após abrir o Chrome com CDP:

1. Feche todas as janelas do Chrome.  
2. Abra com depuração, por exemplo:

```bat
chrome-debug.cmd
```

ou:

```text
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=*
```

3. **`config.js`**: `useExistingChrome: true`.  
4. `npm start` (ou `cmd /c start.cmd` no Windows).

---

### Comandos npm úteis

| Script | Função |
|--------|--------|
| `npm start` | Roda a automação (`node index.js`). |
| `npm run chrome` | Abre o Chrome do Windows com CDP (porta 9222). |
| `npm run chrome:ping` | Testa se a porta 9222 responde (útil no WSL). |
| `npm run start:win` | No Windows, equivalente a `cmd /c start.cmd`. |

---

## O que o script faz

1. Abre o LinkedIn (login manual se necessário).  
2. Vai em **Vagas** com a URL de busca (`searchKeywords` + Brasil + Easy Apply).  
3. Ignora vagas que não batem com **backend + tech** e, se `seniorOnly`, com **seniorKeywords**.  
4. Para cada vaga elegível, tenta **Candidatura simplificada** e preenche campos configuráveis.  

---

## Comportamento “humanizado”

- Atrasos aleatórios  
- Movimento de mouse em curva  
- Scroll gradual  
- Pausas simulando leitura  
- Navegador visível por padrão (`headless: false`)  

---

## Se der problema

| Sintoma | O que tentar |
|---------|----------------|
| **`npm` não reconhecido** | `cmd /c start.cmd`, `.\run-bot.cmd`, ou ajustar PATH do Node. |
| **`.\start.cmd` não reconhecido no PowerShell** | `cmd /c start.cmd` ou `.\run-bot.cmd`. |
| **Chrome não abre / WSL** | `useExistingChrome: true` + `npm run chrome` no WSL + `portproxy` no Windows; ou rode no Windows com `useExistingChrome: false`. |
| **Não conecta na 9222** | `npm run chrome:ping`; confira firewall e se o Chrome foi aberto com as flags corretas. |
| **Login Google em janela minúscula** | O script tenta ampliar popups; use **Alt+Tab** se a janela ficar atrás. |

O LinkedIn muda a interface com frequência. Se algo quebrar: login, seletores ou vagas com formulários extras podem exigir ajuste manual ou atualização dos seletores em `index.js`.
