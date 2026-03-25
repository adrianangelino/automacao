/**
 * Copie este arquivo para config.js e preencha suas credenciais
 * NUNCA commite o config.js no git!
 */

export const config = {
  // Suas credenciais do LinkedIn
  email: 'seu-email@exemplo.com',
  password: 'sua-senha',
  loginWithGoogle: true,  // Preferir Google em vez de Apple (login/verificação)
  
  // Termos de busca para as vagas
  searchKeywords: 'desenvolvedor backend senior',

  // Filtro: vaga DEVE ser backend e exigir Node/Nest/TS/JS
  backendKeywords: ['backend', 'back-end', 'back end'],
  techKeywords: ['node', 'node.js', 'nest', 'nest.js', 'typescript', 'javascript'],
  
  // Localização: apenas vagas do Brasil (fixo)
  // Geolocalização do navegador (São Paulo - evita alertas de segurança)
  geoLatitude: -23.5505,
  geoLongitude: -46.6333,
  
  // Limite de candidaturas por execução (recomendado: 5-15)
  maxApplications: 50,  // 0 = sem limite

  doApply: true,    // candidaturas Easy Apply
  doFeed: true,     // curtir posts no feed
  doConnect: true,  // conexões com recrutadores tech
  debugConnect: false, // true = screenshot quando não encontra botão Conectar
  feedLikesCount: 5,
  politicsBlacklist: ['política', 'eleição', 'presidente', 'voto', 'partido', 'candidato'],
  recruiterSearchTerms: ['tech recruiter', 'recrutador tech'],
  maxConnectionsToRecruiters: 10,
  
  // Modo headless: false = abre o navegador visível (mais seguro)
  headless: false,

  // Velocidade: 'fast' (rápido) | 'normal' | 'slow' (mais humano)
  speed: 'fast',

  // Navegador: 'chromium' (padrão) ou 'firefox' (menos deps no Linux/WSL)
  browser: 'chromium',

  // Usar SEU Chrome já aberto (mais rápido, usa sua sessão/cookies)
  // Abra o Chrome com: chrome --remote-debugging-port=9222
  useExistingChrome: false,
  chromeDebugPort: 9222,
  chromeDebugHost: 'auto', // 'auto' = detecta IP do Windows quando rodando do WSL
  
  // Valores padrão para formulários Easy Apply
  experienceYears: 5,
  salarySenior: 15000,   // 15k para vagas senior
  salaryPleno: 10000,   // 10k para vagas pleno
  phone: '',            // Celular (ex: 15996715767) - preenche no popup de contato
  
  // Timeout para log de travamento (ms)
  stepTimeoutLog: 45000,      // etapas rápidas (cliques, etc)
  stepTimeoutLong: 90000,     // etapas lentas (login, navegação, carregar página)

  // Delay entre execuções (em horas) - evite rodar várias vezes seguidas
  loopMode: true,
  loopCooldownMinutes: 5,   // pausa entre ciclos
};
