/**
 * Copie este arquivo para config.js e preencha suas credenciais
 * NUNCA commite o config.js no git!
 */

export const config = {
  // Suas credenciais do LinkedIn
  email: 'seu-email@exemplo.com',
  password: 'sua-senha',
  loginWithGoogle: true,  // Preferir Google em vez de Apple (login/verificação)
  
  // Busca no LinkedIn (inclua "senior" na string se quiser vagas mais alinhadas)
  searchKeywords: 'desenvolvedor backend senior OR node senior',

  // Filtro: backend + Node/Nest/TS/JS
  backendKeywords: ['backend', 'back-end', 'back end'],
  techKeywords: ['node', 'node.js', 'nest', 'nest.js', 'typescript', 'javascript'],

  // true = ignora vaga que não cite sênior (título/descrição)
  seniorOnly: false,
  seniorKeywords: ['senior', 'sênior', 'sr.', 'staff', 'principal engineer', 'lead developer', 'tech lead'],
  
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

  // Windows nativo: false ok. WSL com janela: true obrigatório (senão abre o Chrome do Linux, ícone com pinguim).
  useExistingChrome: false,
  chromeDebugPort: 9222,
  chromeDebugHost: 'auto', // WSL: 'auto' = IP do Windows (nameserver do resolv.conf); Windows nativo: 'localhost'
  
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
