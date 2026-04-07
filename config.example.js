/**
 * Copie este arquivo para config.js e preencha suas credenciais
 * NUNCA commite o config.js no git!
 */

export const config = {
  // Suas credenciais do LinkedIn
  email: 'seu-email@exemplo.com',
  password: 'SUA_SENHA',
  // true = preenche e-mail e senha na tela de login (recomendado). false = não tenta automático
  loginWithEmailPassword: true,
  // true = oferece “Entrar com Google” se ainda precisar (após e-mail/senha ou sem senha no config)
  loginWithGoogle: false,

  // Busca no LinkedIn — use searchKeywordsList para vários “tubos” (rotação automática)
  searchKeywords: 'desenvolvedor backend senior OR node senior',
  searchKeywordsList: [
    'desenvolvedor backend senior OR node senior',
    'nestjs OR nest.js desenvolvedor',
    'typescript developer OR desenvolvedor typescript',
    'node.js backend remoto',
    'engenheiro de software backend',
  ],

  // Filtro: backend + Node/Nest/TS/JS
  backendKeywords: ['backend', 'back-end', 'back end'],
  techKeywords: ['node', 'node.js', 'nest', 'nest.js', 'typescript', 'javascript'],

  // 'and' = exige palavra de backend E de stack | 'or' = basta uma das listas (mais vagas passam)
  jobKeywordMatchMode: 'or',

  // Une às suas listas termos padrão PT/EN (recomendado). false = só o que está em backendKeywords/techKeywords
  mergeDefaultJobKeywords: true,

  // Espera o painel da vaga carregar após clique no card (ms)
  jobDetailWaitMs: 16000,

  // true = ao ignorar vaga, loga tamanho do texto e trecho (diagnóstico de filtro/painel vazio)
  debugJobFilter: false,

  // true = ignora vaga que não cite sênior (título/descrição)
  seniorOnly: false,
  seniorKeywords: ['senior', 'sênior', 'sr.', 'staff', 'principal engineer', 'lead developer', 'tech lead'],

  // Localização: apenas vagas do Brasil (fixo)
  // Geolocalização do navegador (São Paulo - evita alertas de segurança)
  geoLatitude: -23.5505,
  geoLongitude: -46.6333,

  // Limite por ciclo (macro). 0 = sem limite — busca contínua até acabar a lista / você parar
  maxApplications: 0,

  // 0 = sem teto diário local (não grava .linkedin-easy-apply-daily.json). >0 = ativa o limite
  maxApplicationsPerDay: 0,

  // A cada N candidaturas enviadas: pausa no feed (tempo aleatório) + recrutadores + próximo termo em searchKeywordsList
  applicationsBeforeSearchRotate: 15,
  feedBreakAfterBatchMinMs: 180_000, // ~3 min
  feedBreakAfterBatchMaxMs: 600_000, // ~10 min
  feedBreakMaxLikes: 12,
  afterBatchRecruiterConnections: 10,

  // 0–1: abre a vaga compatível, “lê” e pula sem Easy Apply (parece navegação humana)
  browseWithoutApplyChance: 0.22,

  // Antes de clicar em Easy Apply, rola a descrição (recomendado). false = vai direto ao botão
  simulateReadBeforeApply: true,

  // Pausa após cada candidatura enviada com sucesso (ms)
  afterApplyDelayMinMs: 90_000,
  afterApplyDelayMaxMs: 240_000,

  // Na pausa pós-candidatura: buscar recrutadores e conectar (até o tempo da pausa acabar)
  recruitersDuringApplyPause: true,
  pauseAfterApplyRecruiterConnections: 4, // máx. conexões por ida à busca de pessoas nessa pausa

  // Busca de pessoas: mistura o termo de vagas atual (searchKeywordsList/rotação) com cada item de recruiterSearchTerms
  recruiterSearchAlignWithJobKeywords: true,
  // URL + clique na UI para “Actively hiring” / “Contratando agora” (LinkedIn pode exigir Premium)
  recruiterActivelyHiringFilter: true,
  // true = só Conectar se o card citar alguma palavra do termo de vagas (mais restrito)
  recruiterMatchCardToJobKeywords: false,

  // Paginação da lista de vagas (quando não há cards novos após rolar)
  jobsResultsPageStep: 25,
  maxJobsSearchPages: 30,

  // true = pula vaga se houver input de arquivo (use só se quiser ignorar todas com upload)
  skipEasyApplyWithFileUpload: false,
  preferLinkedInSavedResume: true,
  easyApplyFillAllEmptyTextareas: true,
  easyApplyModalScrollPasses: 6,
  easyApplyMaxModalSteps: 24,
  easyApplyStuckDismissAfter: 16,
  portfolioUrl: '',
  // Texto curto para textareas (carta / motivação) quando o campo aparecer
  easyApplyDefaultMessage:
    'Tenho interesse na vaga e experiência alinhada ao que foi descrito.',

  // Pausa após visitar vaga no modo “só navegar” (ms)
  afterBrowseDelayMinMs: 8_000,
  afterBrowseDelayMaxMs: 28_000,

  doApply: true,    // candidaturas Easy Apply
  doFeed: true,     // curtir posts no feed
  doConnect: true,  // conexões com recrutadores tech
  debugConnect: false, // true = screenshot quando não encontra botão Conectar
  feedLikesCount: 5,
  politicsBlacklist: ['política', 'eleição', 'presidente', 'voto', 'partido', 'candidato'],
  // Sufixos após o termo de vagas (ex.: "node senior tech recruiter"). Se align=false, usados sozinhos.
  recruiterSearchTerms: [
    'recrutador tech',
    'tech recruiter',
    'recrutamento ti',
    'talent acquisition',
  ],
  maxConnectionsToRecruiters: 10,

  // Modo headless: false = abre o navegador visível (mais seguro)
  headless: false,

  // Velocidade: 'fast' | 'normal' | 'slow' | 'human' (último = mais pausa entre micro-ações)
  speed: 'normal',

  // Navegador: 'chromium' (padrão) ou 'firefox' (menos deps no Linux/WSL)
  browser: 'chromium',

  // Windows nativo: false ok. WSL com janela: true obrigatório (senão abre o Chrome do Linux, ícone com pinguim).
  useExistingChrome: false,
  chromeDebugPort: 9222,
  chromeDebugHost: 'auto', // WSL: 'auto' = IP do Windows (nameserver do resolv.conf); Windows nativo: 'localhost'

  // Mesmo fuso usado no Playwright e para o “dia” do contador maxApplicationsPerDay
  timezoneId: 'America/Sao_Paulo',

  // Valores padrão para formulários Easy Apply
  experienceYears: 10,
  salarySenior: 15000,   // 15k para vagas senior
  salaryPleno: 10000,   // 10k para vagas pleno
  phone: '',            // Celular (ex: 15996715767) - preenche no popup de contato

  // Timeout para log de travamento (ms)
  stepTimeoutLog: 45000,      // etapas rápidas (cliques, etc)
  stepTimeoutLong: 90000,     // etapas lentas (login, navegação, carregar página)

  loopMode: true,

  // Durante a pausa entre ciclos: manter sessão “humana” (feed + busca de perfis dev), não só timer
  cyclePauseBrowseFeed: true,
  cyclePauseBrowseProfiles: true,
  cyclePauseFeedLikesPerRound: 2, // curtidas por ida ao feed na pausa
  cyclePauseProfilesPerRound: 3, // quantos perfis abrir por rodada de busca na pausa
  cyclePauseProfileSearchTerms: [
    'desenvolvedor node',
    'desenvolvedor backend',
    'typescript developer',
    'engenheiro de software',
  ],

  // Pausa entre ciclos (minutos), com jitter — mais natural que valor fixo
  loopCooldownMinutesMin: 25,
  loopCooldownMinutesMax: 75,
  // Legado: se só isto existir e min/max forem omitidos, ambos usam este valor
  loopCooldownMinutes: 5,
};
