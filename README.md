# LinkedIn Easy Apply - Automação

Automação humanizada para candidaturas em vagas com **Candidatura simplificada** no LinkedIn, focada em vagas de desenvolvedor senior/pleno.

## ⚠️ Aviso

O LinkedIn proíbe automação nos Termos de Serviço. Use por sua conta e risco. Recomenda-se:
- Máximo 10-15 candidaturas por dia
- Não rodar em loop 24/7
- Usar `headless: false` para ver o que está acontecendo

## Instalação

```bash
npm install
```

## Configuração

1. Copie o arquivo de exemplo:
```bash
copy config.example.js config.js
```

2. Edite `config.js` e preencha:
   - **email**: seu email do LinkedIn
   - **password**: sua senha
   - **searchKeywords**: termos de busca (padrão: "desenvolvedor senior OR desenvolvedor pleno")
   - **location**: localização (ex: "Brasil", "São Paulo")
   - **maxApplications**: limite de candidaturas por execução (recomendado: 5-15)

## Uso

### Opção 1: Usar seu Chrome (mais rápido, usa sua sessão)

1. **Feche** o Chrome completamente
2. Abra o Chrome com depuração remota (PowerShell ou CMD):
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```
3. No `config.js`, deixe `useExistingChrome: true`
4. Rode o script:
```bash
npm start
```

O script conecta ao seu Chrome, usa seus cookies/sessão (login pode ser pulado se já estiver logado) e não fecha o navegador ao terminar.

**Rodando do WSL?**
- `npm run chrome` — abre o Chrome do Windows com `--remote-debugging-port=9222`
- Configure o redirecionamento de porta (veja abaixo). Ou rode do **PowerShell do Windows** com `chromeDebugHost: 'localhost'` no config.
- Redirecionamento de porta (PowerShell como Admin):
```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9222 connectaddress=127.0.0.1 connectport=9222
New-NetFirewallRule -DisplayName "Chrome DevTools" -Direction Inbound -Protocol TCP -LocalPort 9222 -Action Allow
```
Depois feche o Chrome, abra com `chrome.exe --remote-debugging-port=9222` e rode `npm start` do WSL.

### Opção 2: Novo Chrome (padrão antigo)

No `config.js`, deixe `useExistingChrome: false`. O script abre um novo Chrome.

---

O script vai:
1. Abrir o LinkedIn e fazer login
2. Ir em Vagas
3. Buscar pelas palavras-chave configuradas
4. Filtrar por "Candidatura simplificada"
5. Clicar em cada vaga e enviar candidatura automaticamente

## Comportamento humanizado

- Delays aleatórios entre ações
- Movimento de mouse em curva
- Scroll gradual
- Pausas simulando "leitura"
- Navegador visível (não headless por padrão)

## Se der problema

Os selectors do LinkedIn mudam com frequência. Se algo quebrar:
- Verifique se o login está funcionando
- O filtro "Candidatura simplificada" pode estar em outro lugar
- Vagas com perguntas extras podem precisar de intervenção manual
# automacao
