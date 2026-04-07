/**
 * LinkedIn Easy Apply - Automação humanizada
 * Candidatura automática em vagas simplificadas para dev senior/pleno
 * 
 * AVISO: Use por sua conta e risco. LinkedIn proíbe automação nos ToS.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { chromium, firefox } from 'playwright';
import { config } from './config.js';
import {
  randomDelay,
  shortDelay,
  readingDelay,
  longDelay,
  humanMouseMove,
  humanScroll,
  humanType,
  setSpeed,
} from './utils.js';

// Selectors do LinkedIn (podem mudar - atualize se quebrar)
const SELECTORS = {
  // Login - múltiplos fallbacks
  emailInput: '#username, input[name="session_key"], input[autocomplete="username"]',
  passwordInput: '#password, input[name="session_password"], input[type="password"]',
  loginButton: 'button[type="submit"], button:has-text("Entrar"), button:has-text("Sign in")',
  
  // Jobs
  jobsLink: 'a[href="/jobs/"]',
  searchInput: 'input[placeholder*="Pesquisar"]',
  searchButton: 'button[type="submit"]',
  easyApplyFilter: 'button:has-text("Candidatura simplificada")',
  jobCard: '.job-card-container, .jobs-search-results__list-item',
  easyApplyButton: 'button:has-text("Candidatura simplificada"), button:has-text("Easy Apply")',
  nextButton: 'button:has-text("Avançar"), button:has-text("Next")',
  submitButton: 'button:has-text("Enviar candidatura"), button:has-text("Submit application")',
  dismissButton: 'button[aria-label="Dismiss"]',
  closeModal: 'button[aria-label="Fechar"]',
};

let applicationsCount = 0;
let stopRequested = false;
/** Índice na lista searchKeywordsList (rotação após cada lote de candidaturas). */
let searchKeywordsRotationIndex = 0;
process.on('SIGINT', () => {
  console.log('\n\n⏹️  Parando... (aguarde encerrar o ciclo atual)');
  stopRequested = true;
});
const STEP_TIMEOUT = config.stepTimeoutLog ?? 45000;
const STEP_TIMEOUT_LONG = config.stepTimeoutLong ?? 90000;

/** Viewport padrão; popups OAuth (Google) vêm com janela minúscula — setViewportSize corrige no Windows */
const VIEWPORT = { width: 1280, height: 800 };

/** WSL: Node roda no Linux, mas a interface gráfica é do Windows — Chromium “do Linux” costuma dar janela invisível/zoada */
function isWsl() {
  if (process.platform !== 'linux') return false;
  if (existsSync('/mnt/c/Windows')) return true;
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    return v.includes('microsoft') || v.includes('wsl');
  } catch {
    return false;
  }
}

/**
 * WSL2 → Chrome com --remote-debugging-port escuta no Windows (127.0.0.1).
 * O IP do Windows para o Linux é o nameserver do resolv.conf — NÃO use primeiro o "default via" do ip route
 * (ex.: 172.26.0.1), que muitas vezes não encaminha a porta 9222.
 */
function buildChromeDebugHostsToTry(configuredHost, wsl) {
  if (configuredHost !== 'auto') {
    return configuredHost === 'localhost' ? ['localhost'] : [configuredHost, 'localhost'];
  }
  if (process.platform !== 'linux') return ['localhost'];
  const list = [];
  const add = (h) => {
    if (h && !list.includes(h)) list.push(h);
  };
  if (wsl) {
    try {
      const resolv = readFileSync('/etc/resolv.conf', 'utf8');
      for (const m of resolv.matchAll(/^nameserver\s+(\S+)/gm)) add(m[1]);
    } catch {}
  }
  add('127.0.0.1');
  add('localhost');
  if (wsl) {
    try {
      const out = execSync('ip route show default 2>/dev/null || true', { encoding: 'utf8', shell: true });
      const m = out.match(/default\s+via\s+(\S+)/);
      if (m) add(m[1]);
    } catch {}
  }
  return list.length ? list : ['localhost'];
}

/**
 * Executa uma operação e, se demorar mais que o timeout, loga onde travou
 * @param {string} stepId - Identificador da etapa (ex: "LOGIN_EMAIL")
 * @param {Function} fn - Função async a executar
 * @param {number} [customTimeout] - Timeout em ms (opcional, usa STEP_TIMEOUT_LONG para etapas lentas)
 */
async function runStep(stepId, fn, customTimeout) {
  const ms = customTimeout ?? STEP_TIMEOUT;
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`TRAVOU_EM:${stepId}`)), ms);
  });
  return Promise.race([fn(), timeout]);
}

/** Rola o modal Easy Apply com mais passadas (formulários longos). */
async function scrollModalToBottom(page) {
  const passes = config.easyApplyModalScrollPasses ?? 6;
  for (let i = 0; i < passes; i++) {
    await page.evaluate(() => {
      const selectors = [
        '[data-test-modal-id="easy-apply-modal"]',
        '.jobs-easy-apply-content',
        '.artdeco-modal__content',
        '.artdeco-modal',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      }
    }).catch(() => null);
    await shortDelay();
  }
  // Fallback: scroll com wheel no centro do modal
  const modal = page.locator('[data-test-modal-id="easy-apply-modal"], .artdeco-modal').first();
  if (await modal.count() > 0) {
    const box = await modal.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 400);
        await shortDelay();
      }
    }
  }
}

/** Detecta se o LinkedIn mostrou limite diário de candidaturas */
async function isDailyLimitReached(page) {
  try {
    const text = await page.locator('body').textContent();
    const t = (text || '').toLowerCase();
    const limitPhrases = [
      'limitamos o número de envios diários',
      'limit the number of daily',
      'prevenir bots',
      'prevent bots',
      'salve esta vaga e candidate-se amanhã',
      'save this job and apply tomorrow',
    ];
    return limitPhrases.some(p => t.includes(p.toLowerCase()));
  } catch {
    return false;
  }
}

/** Preenche e-mail e senha na página de login do LinkedIn (fluxo em uma ou duas etapas). */
async function tryEmailPasswordLogin(page) {
  if (config.loginWithEmailPassword === false) return false;
  if (!config.email || !config.password) return false;

  const emailSel = '#username, input[name="session_key"], input[autocomplete="username"]';
  const passSel =
    '#password, input[name="session_password"], input[autocomplete="current-password"], input[type="password"]';

  try {
    await page.locator(emailSel).first().waitFor({ state: 'visible', timeout: 15000 });
    const emailInput = page.locator(emailSel).first();
    if (await emailInput.isEditable().catch(() => true)) {
      await emailInput.click({ timeout: 3000 }).catch(() => null);
      await emailInput.fill('');
      await emailInput.fill(config.email);
    }
    await shortDelay();

    let passLoc = page.locator(passSel).first();
    const passVisible = await passLoc.isVisible().catch(() => false);
    if (!passVisible) {
      const submitEmail = page
        .locator('button[type="submit"], input[type="submit"], button:has-text("Continuar"), button:has-text("Continue")')
        .first();
      if ((await submitEmail.count()) > 0) {
        await submitEmail.click({ timeout: 6000 }).catch(() => null);
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null);
        await randomDelay(1200, 2200);
      }
      passLoc = page.locator(passSel).first();
    }

    await passLoc.waitFor({ state: 'visible', timeout: 12000 });
    await passLoc.click({ timeout: 3000 }).catch(() => null);
    await passLoc.fill(config.password);
    await shortDelay();

    const signIn = page
      .locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Sign in"), input[type="submit"]')
      .first();
    await signIn.click({ timeout: 10000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => null);
    await randomDelay(2000, 4000);
    console.log('   🔑 E-mail e senha enviados (login automático).');
    return true;
  } catch (e) {
    console.log('   ⚠️ Login automático e-mail/senha:', e?.message || e);
    return false;
  }
}

function isLinkedInLoggedInUrl(url) {
  if (!url || !url.includes('linkedin.com')) return false;
  if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/uas/')) return false;
  return /linkedin\.com\/(feed|jobs|mynetwork)/.test(url) || /linkedin\.com\/in\//.test(url);
}

/** Tenta clicar em "Continue with Google" / "Entrar com Google" (evita Apple) */
async function tryClickGoogleLogin(page) {
  if (!config.loginWithGoogle) return false;
  const googleSelectors = [
    'button:has-text("Continue with Google")',
    'button:has-text("Entrar com Google")',
    'button:has-text("Sign in with Google")',
    'a:has-text("Continue with Google")',
    'a:has-text("Entrar com Google")',
    '[data-provider="google"]',
    'button[aria-label*="Google"]',
    'a[href*="google"]',
  ];
  for (const sel of googleSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded();
        await shortDelay();
        await btn.click({ timeout: 5000 });
        console.log('   📱 Clicou em "Entrar com Google"');
        return true;
      }
    } catch {}
  }
  return false;
}

async function waitForManualLogin(page) {
  console.log('🔐 Indo para a tela de login do LinkedIn...');

  // OAuth "Entrar com Google" abre outra janela; no Windows ela costuma ficar ATRÁS do Chrome do Playwright
  const ctx = page.context();
  const bringPopupToFront = async (popup) => {
    if (popup === page) return;
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null);
      // LinkedIn/Google abrem OAuth com width/height minúsculos → janela “carimbo”; isto redimensiona a janela real
      await popup.setViewportSize(VIEWPORT).catch(() => null);
      await popup.bringToFront();
      console.log('   📑 Janela extra (Google / verificação) ampliada e trazida para frente.');
    } catch {}
  };
  ctx.on('page', bringPopupToFront);

  try {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const url = page.url();
    if (!url.includes('/login') && !url.includes('/uas/') && !url.includes('/checkpoint/')) {
      console.log('   ✅ Já logado.');
      return;
    }

    await shortDelay();

    if (config.loginWithEmailPassword !== false && config.email && config.password) {
      await tryEmailPasswordLogin(page);
      await randomDelay(1500, 3000);
      if (isLinkedInLoggedInUrl(page.url())) {
        console.log('   ✅ Sessão iniciada com e-mail e senha do config.');
        return;
      }
    }

    const clickedGoogle = await tryClickGoogleLogin(page);
    if (clickedGoogle) {
      await shortDelay();
      for (const p of ctx.pages()) {
        if (p !== page) await bringPopupToFront(p);
      }
    }

    console.log('');
    console.log(
      '   👤 Se ainda aparecer verificação em duas etapas, CAPTCHA ou Google, conclua manualmente no navegador.'
    );
    console.log('   ⏳ Quando estiver logado, o script continuará automaticamente...');
    console.log('');

    const loginWaitMs = config.loginWaitTimeoutMs ?? 300_000;
    const deadline = Date.now() + loginWaitMs;
    const loggedRe = /linkedin\.com\/(feed|jobs|mynetwork|in\/)/;
    while (Date.now() < deadline && !stopRequested) {
      try {
        if (page.isClosed()) break;
        const u = page.url();
        if (loggedRe.test(u) && !u.includes('/login')) {
          console.log('   ✅ Login detectado!');
          return;
        }
      } catch {
        /* navegação / frame em transição */
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (!stopRequested) {
      throw new Error('Tempo esgotado aguardando login (5 min). Verifique e-mail, senha ou 2FA.');
    }
  } finally {
    ctx.off('page', bringPopupToFront);
  }
}

function hasPoliticsContent(text) {
  const kw = config.politicsBlacklist || ['política', 'eleição', 'presidente', 'voto', 'partido', 'candidato'];
  const t = (text || '').toLowerCase();
  return kw.some(k => t.includes(k.toLowerCase()));
}

/**
 * Curtir posts no feed (evita política).
 * @param {{ maxLikes?: number, quiet?: boolean }} [opts] — quiet: menos logs (uso na pausa entre ciclos)
 */
async function interactWithFeed(page, opts = {}) {
  const count = opts.maxLikes ?? config.feedLikesCount ?? 5;
  if (count <= 0) return;
  if (!opts.quiet) {
    console.log('');
    console.log('📱 Indo para o feed...');
  }
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await longDelay();
  let liked = 0;
  for (let i = 0; i < count * 4 && liked < count; i++) {
    const likeBtns = await page.$$('button[aria-label*="Curtir"], button[aria-label*="Like"], button[aria-label*="Reagir"]');
    for (const btn of likeBtns) {
      if (liked >= count) break;
      try {
        const pressed = await btn.getAttribute('aria-pressed');
        if (pressed === 'true') continue;
        const parent = await btn.evaluate(el => el.closest('.feed-shared-update-v2, [data-urn]')?.textContent || '');
        if (hasPoliticsContent(parent)) continue;
        await btn.scrollIntoViewIfNeeded();
        await shortDelay();
        await btn.click();
        liked++;
        console.log(`   👍 Curtiu ${liked}/${count}`);
        await randomDelay(2000, 4000);
      } catch {}
    }
    await humanScroll(page, 'down', 400);
    await randomDelay(1500, 3000);
  }
  if (liked > 0 && !opts.quiet) console.log(`   ✅ ${liked} curtidas no feed.`);
  else if (liked > 0 && opts.quiet) console.log(`   👍 (pausa) ${liked} curtida(s) no feed.`);
}

/** Busca pessoas por termo e abre alguns perfis /in/… (rolagem, “leitura”) — uso na pausa entre ciclos */
async function browseDeveloperProfilesRound(page) {
  const terms =
    config.cyclePauseProfileSearchTerms?.length > 0
      ? config.cyclePauseProfileSearchTerms
      : [
          'desenvolvedor node',
          'desenvolvedor backend',
          'typescript',
          'engenheiro de software',
        ];
  const term = terms[Math.floor(Math.random() * terms.length)];
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(term)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
  await longDelay();
  await humanScroll(page, 'down', 280);
  await randomDelay(1200, 2800);

  const maxProfiles = Math.max(1, config.cyclePauseProfilesPerRound ?? 3);
  const visited = new Set();

  for (let n = 0; n < maxProfiles && !stopRequested; n++) {
    const anchors = await page.locator('a[href*="/in/"]').all();
    let opened = false;
    for (const a of anchors) {
      const href = await a.getAttribute('href').catch(() => '');
      if (!href || /\/(company|school|showcase|feed|groups)\//i.test(href)) continue;
      const match = href.match(/\/in\/([^/?#]+)/i);
      if (!match) continue;
      const slug = decodeURIComponent(match[1]);
      if (!slug || slug.toLowerCase() === 'me' || visited.has(slug)) continue;
      visited.add(slug);

      const visible = await a.isVisible().catch(() => false);
      if (!visible) continue;

      await a.scrollIntoViewIfNeeded().catch(() => null);
      await shortDelay();
      await a.click({ timeout: 8000 }).catch(() => null);
      await page.waitForURL(/linkedin\.com\/in\//i, { timeout: 15000 }).catch(() => null);
      await longDelay();
      const scrolls = 2 + Math.floor(Math.random() * 5);
      for (let s = 0; s < scrolls; s++) {
        await humanScroll(page, 'down', 260 + Math.random() * 220);
        await readingDelay();
      }
      await randomDelay(4000, 11000);
      console.log(`   📇 Perfil visitado: /in/${slug.slice(0, 40)}${slug.length > 40 ? '…' : ''}`);
      opened = true;

      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(async () => {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => null);
      });
      await longDelay();
      break;
    }
    if (!opened) {
      console.log('   ⏭️ (pausa) Nenhum link de perfil clicável na página de busca.');
      break;
    }
  }
}

/**
 * Preenche o tempo entre ciclos com feed + visitas a perfis (em vez de só dormir).
 */
async function runCoolDownWithBrowsing(page, totalMs) {
  const useFeed = config.cyclePauseBrowseFeed !== false;
  const useProfiles = config.cyclePauseBrowseProfiles !== false;
  if (!useFeed && !useProfiles) {
    await pauseMsWithStopCheck(totalMs, null);
    return;
  }

  const deadline = Date.now() + totalMs;
  console.log('   Rotina entre ciclos: alternando feed e perfis de dev até a próxima rodada.');

  while (Date.now() < deadline && !stopRequested) {
    const remaining = deadline - Date.now();
    if (remaining <= 12_000) {
      await pauseMsWithStopCheck(remaining, null);
      break;
    }

    const roll = Math.random();
    if (useFeed && useProfiles) {
      if (roll < 0.5) {
        console.log('   📱 (entre ciclos) Feed...');
        try {
          await interactWithFeed(page, {
            maxLikes: Math.max(1, config.cyclePauseFeedLikesPerRound ?? 2),
            quiet: true,
          });
        } catch (e) {
          console.log('   ⚠️ Feed (pausa):', e?.message || e);
        }
      } else {
        console.log('   👤 (entre ciclos) Buscando e olhando perfis...');
        try {
          await browseDeveloperProfilesRound(page);
        } catch (e) {
          console.log('   ⚠️ Perfis (pausa):', e?.message || e);
        }
      }
    } else if (useFeed) {
      console.log('   📱 (entre ciclos) Feed...');
      try {
        await interactWithFeed(page, {
          maxLikes: Math.max(1, config.cyclePauseFeedLikesPerRound ?? 2),
          quiet: true,
        });
      } catch (e) {
        console.log('   ⚠️ Feed (pausa):', e?.message || e);
      }
    } else {
      try {
        await browseDeveloperProfilesRound(page);
      } catch (e) {
        console.log('   ⚠️ Perfis (pausa):', e?.message || e);
      }
    }

    const still = deadline - Date.now();
    if (still <= 0) break;
    const chunk = Math.min(still, 45_000 + Math.floor(Math.random() * 135_000));
    await pauseMsWithStopCheck(chunk, null);
  }
}

const SEND_INVITE_MODAL_SEL =
  'button:has-text("Enviar sem nota"), button:has-text("Send without a note"), button:has-text("Send without note"), button:has-text("Enviar convite"), button:has-text("Send invitation"), button:has-text("Enviar"), button:has-text("Send"), button[aria-label*="Enviar"], button[aria-label*="Send invitation"]';

/** Cancela qualquer download (currículo, PDF da vaga, etc.) — candidatura só com CV do perfil. */
function attachBlockAllDownloads(context) {
  const onDownload = (download) => {
    download.cancel().catch(() => {});
  };
  const hookPage = (p) => {
    try {
      p.on('download', onDownload);
    } catch {}
  };
  try {
    context.on('page', hookPage);
  } catch {}
  for (const p of context.pages()) hookPage(p);
}

/**
 * Clica em Conectar dentro de um card da busca de pessoas (várias UIs do LinkedIn).
 */
async function tryClickConnectInSearchResult(item, page) {
  const skipIf = item.locator(
    'button:has-text("Pendente"), button:has-text("Pending"), button:has-text("Mensagem"), button:has-text("Message"), button:has-text("Seguir"), button:has-text("Follow")'
  );
  if ((await skipIf.count().catch(() => 0)) > 0) {
    const vis = await skipIf.first().isVisible().catch(() => false);
    if (vis) return false;
  }
  if ((await item.locator('span:has-text("1º grau"), span:has-text("1st"), span:has-text("2º grau"), span:has-text("2nd")').count()) > 0) {
    return false;
  }

  let btn = item.locator('button:has(span.artdeco-button__text:has-text("Conectar"))').first();
  if ((await btn.count()) === 0) {
    btn = item.locator('button:has(span.artdeco-button__text:has-text("Connect"))').first();
  }
  if ((await btn.count()) === 0) {
    btn = item
      .locator(
        'button:has-text("Conectar"), button:has-text("Connect"), button[aria-label*="Conectar"], button[aria-label*="Connect"], button[aria-label*="Convidar"], button[aria-label*="Invite to connect"], a[aria-label*="Conectar"]'
      )
      .first();
  }
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ timeout: 8000 }).catch(() => null);
    await randomDelay(900, 1800);
    return true;
  }

  const more = item
    .locator(
      'button[aria-label*="More actions"], button[aria-label*="Mais ações"], button[aria-label*="Expand"], button[aria-label*="Exibir mais ações"]'
    )
    .first();
  if ((await more.count()) > 0 && (await more.isVisible().catch(() => false))) {
    await more.click({ timeout: 5000 }).catch(() => null);
    await randomDelay(500, 1000);
    const menuBtn = page
      .locator(
        '[role="menu"] button, [role="menuitem"], .artdeco-dropdown__content-inner button, div[role="presentation"] button'
      )
      .filter({ hasText: /^(Conectar|Connect|Convidar)$/i })
      .first();
    if ((await menuBtn.count()) > 0) {
      await menuBtn.click({ timeout: 5000 }).catch(() => null);
      await randomDelay(800, 1500);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => null);
  }
  return false;
}

/**
 * @param {{ maxConn?: number, quiet?: boolean, deadline?: number }} [opts]
 * @returns {Promise<number>} quantas conexões foram enviadas nesta chamada
 */
async function connectWithRecruiters(page, opts = {}) {
  const maxConn = opts.maxConn ?? config.maxConnectionsToRecruiters ?? 10;
  const quiet = opts.quiet ?? false;
  const deadline = opts.deadline ?? null;
  const terms = getRecruiterPeopleSearchQueries();
  const cardMatchTokens =
    config.recruiterMatchCardToJobKeywords === true ? tokenizeJobKeywordsForRecruiterMatch(getCurrentSearchKeywords()) : [];
  if (maxConn <= 0) return 0;
  if (deadline != null && Date.now() >= deadline) return 0;

  if (!quiet) {
    console.log('');
    console.log('🔍 Buscando recrutadores (vagas: termo atual + filtro “contratando agora” quando existir)...');
    if (config.recruiterSearchAlignWithJobKeywords !== false && getCurrentSearchKeywords().trim()) {
      console.log(`   📌 Alinhado ao termo de vagas: "${getCurrentSearchKeywords().slice(0, 120)}${getCurrentSearchKeywords().length > 120 ? '…' : ''}"`);
    }
  } else {
    console.log('   🤝 Buscando recrutadores (intervalo da pausa)...');
  }
  let totalConnected = 0;

  for (const term of terms) {
    if (totalConnected >= maxConn) break;
    if (deadline != null && Date.now() >= deadline) break;

    const searchUrl = buildLinkedInPeopleSearchUrl(term);
    try {
      await page.goto(searchUrl, { waitUntil: 'load', timeout: 50000 });
    } catch {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });
    }
    if (deadline != null && Date.now() >= deadline) break;
    await longDelay();
    await page
      .waitForSelector(
        'li.reusable-search__result-container, li[data-chameleon-result-urn], ul.reusable-search__entity-result-list li',
        { timeout: 20000 }
      )
      .catch(() => null);
    await randomDelay(1500, 3200);
    await tryApplyActivelyHiringPeopleFilter(page);
    await randomDelay(2000, 4500);
    await humanScroll(page, 'down', 400);
    await randomDelay(1500, 3000);

    const items = page.locator(
      'li.reusable-search__result-container, li[data-chameleon-result-urn], .reusable-search__entity-result-list .reusable-search__entity-result'
    );
    const nItems = await items.count().catch(() => 0);
    const maxScan = Math.min(nItems, 35);

    for (let i = 0; i < maxScan && totalConnected < maxConn; i++) {
      if (deadline != null && Date.now() >= deadline) break;

      const item = items.nth(i);
      await item.scrollIntoViewIfNeeded().catch(() => null);
      await randomDelay(450, 1200);

      if (cardMatchTokens.length > 0) {
        const okCard = await searchResultCardMatchesJobInterest(item, cardMatchTokens);
        if (!okCard) continue;
      }

      const clicked = await tryClickConnectInSearchResult(item, page);
      if (!clicked) continue;

      const sendBtn = page.locator(SEND_INVITE_MODAL_SEL).first();
      await randomDelay(600, 1400);
      if ((await sendBtn.count().catch(() => 0)) > 0 && (await sendBtn.isVisible().catch(() => false))) {
        await sendBtn.click({ timeout: 6000 }).catch(() => null);
        totalConnected++;
        if (!quiet) console.log(`   🤝 Conexão ${totalConnected}/${maxConn} enviada`);
        else console.log(`   🤝 Conexão ${totalConnected}/${maxConn} (pausa)`);
      } else {
        await page.keyboard.press('Escape').catch(() => null);
      }
      await randomDelay(2200, 4800);
    }

    if (totalConnected === 0 && (config.debugConnect ?? false) && !quiet) {
      await page.screenshot({ path: 'debug-connect.png' }).catch(() => null);
      console.log('   🐛 Screenshot: debug-connect.png (debugConnect: true)');
    }
  }
  if (!quiet) {
    if (totalConnected > 0) console.log(`   ✅ ${totalConnected} conexões enviadas a recrutadores.`);
    else
      console.log(
        '   ⚠️ Nenhuma conexão enviada (UI diferente, já conectados, Premium/filtro “contratando agora”, ou limite). debugConnect: true; ajuste recruiterSearchTerms / recruiterSearchAlignWithJobKeywords.'
      );
  } else if (totalConnected > 0) {
    console.log(`   ✅ ${totalConnected} conexão(ões) na pausa.`);
  }
  return totalConnected;
}

/** Garante que estamos na página de vagas (jobs) */
async function ensureJobsPage(page) {
  const url = page.url();
  if (!url.includes('linkedin.com/jobs')) {
    const params = new URLSearchParams({
      keywords: getCurrentSearchKeywords(),
      location: 'Brasil',
      f_AL: 'true',
    });
    await page.goto(`https://www.linkedin.com/jobs/search/?${params}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await longDelay();
  }
}

async function goToJobs(page) {
  const kw = getCurrentSearchKeywords();
  console.log('📋 Navegando para vagas...');
  console.log(`   🔎 Termo atual: ${kw || '(vazio)'}`);

  // URL direta com busca + Easy Apply - apenas vagas do Brasil
  const params = new URLSearchParams({
    keywords: kw,
    location: 'Brasil',
    f_AL: 'true', // Candidatura simplificada
  });

  const jobsUrl = `https://www.linkedin.com/jobs/search/?${params.toString()}`;
  await page.goto(jobsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await longDelay();
}

async function searchJobs(page) {
  // Busca já feita via URL em goToJobs - só aguarda a lista carregar
  console.log('🔍 Aguardando lista de vagas...');
  await page.waitForSelector('.job-card-container, .jobs-search-results__list-item, [data-job-id]', {
    timeout: 15000,
    state: 'visible',
  }).catch(() => null);
  await longDelay();
}

/**
 * Avança para a próxima página de resultados de vagas (botão de paginação ou parâmetro start= na URL).
 */
async function goToNextJobsResultsPage(page) {
  const step = config.jobsResultsPageStep ?? 25;
  const nextBtn = page
    .locator(
      'button.jobs-search-pagination__button--next, button[data-test-pagination-next], button[aria-label*="Next"], button[aria-label*="Próxima"], button[aria-label*="próxima"]'
    )
    .first();

  try {
    if ((await nextBtn.count()) > 0) {
      const disabled = await nextBtn.getAttribute('disabled');
      const ariaDis = await nextBtn.getAttribute('aria-disabled');
      const cls = (await nextBtn.getAttribute('class')) || '';
      if (!disabled && ariaDis !== 'true' && !cls.includes('disabled')) {
        console.log('   📄 Próxima página de vagas (paginação)...');
        await nextBtn.scrollIntoViewIfNeeded().catch(() => null);
        await randomDelay(400, 900);
        await nextBtn.click({ timeout: 10000 }).catch(() => null);
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null);
        await longDelay();
        await page
          .waitForSelector('.job-card-container, .jobs-search-results__list-item, [data-job-id]', {
            timeout: 12000,
          })
          .catch(() => null);
        await randomDelay(1200, 2500);
        const cards = await page.$$('.job-card-container, .jobs-search-results__list-item, [data-job-id]');
        return cards.length > 0;
      }
    }
  } catch {}

  try {
    const url = new URL(page.url());
    if (!url.hostname.includes('linkedin.com') || !url.pathname.includes('/jobs/search')) return false;
    const start = parseInt(url.searchParams.get('start') || '0', 10) + step;
    url.searchParams.set('start', String(start));
    if (!url.searchParams.has('keywords')) url.searchParams.set('keywords', getCurrentSearchKeywords() || '');
    if (!url.searchParams.has('location')) url.searchParams.set('location', 'Brasil');
    if (!url.searchParams.has('f_AL')) url.searchParams.set('f_AL', 'true');
    console.log(`   📄 Próxima página de vagas (start=${start})...`);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 50000 }).catch(() => null);
    await longDelay();
    await page
      .waitForSelector('.job-card-container, .jobs-search-results__list-item, [data-job-id]', {
        timeout: 12000,
      })
      .catch(() => null);
    await randomDelay(1200, 2500);
    const cards = await page.$$('.job-card-container, .jobs-search-results__list-item, [data-job-id]');
    if (cards.length === 0) {
      console.log('   ⏭️ Sem vagas nesta página (fim da busca ou start inválido).');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function getJobTitle(page) {
  try {
    const titleEl = await page.$('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1');
    return titleEl ? (await titleEl.textContent()).toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Retorna o texto da descrição da vaga (título + descrição) */
async function getJobDescription(page) {
  try {
    const selectors = [
      '.jobs-description__content',
      '.jobs-description-content__text',
      '.jobs-box__html-content',
      '.jobs-details__main-content',
      '.jobs-search__job-details',
      '[data-test-id="job-description"]',
      '.job-details-jobs-unified-top-card',
      '.jobs-unified-top-card__primary-description',
      'article.jobs-search-ui__job-card',
    ];
    let text = '';
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        text += (await el.textContent()) || '';
      }
    }
    return text.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Espera o painel da direita ter texto suficiente (LinkedIn carrega async após o clique no card).
 */
async function waitForJobDetailContent(page) {
  const timeoutMs = config.jobDetailWaitMs ?? 16000;
  try {
    await page.waitForFunction(
      () => {
        const blocks = [
          document.querySelector('.jobs-description__content'),
          document.querySelector('.jobs-description-content__text'),
          document.querySelector('.jobs-details__main-content'),
          document.querySelector('.jobs-search__job-details'),
          document.querySelector('.job-details-jobs-unified-top-card'),
        ];
        let n = 0;
        for (const el of blocks) {
          if (el) n += (el.innerText || el.textContent || '').trim().length;
        }
        return n >= 70;
      },
      { timeout: timeoutMs }
    );
  } catch {
    // segue: às vezes o layout é mínimo ou timeout curto
  }
  await randomDelay(400, 1100);
}

/** Título + descrição + bloco do painel (melhor cobertura para o filtro de keywords). */
async function getAggregatedJobText(page) {
  let text = '';
  try {
    text += (await getJobTitle(page)) + ' ';
  } catch {}
  try {
    text += (await getJobDescription(page)) + ' ';
  } catch {}
  try {
    const extra = await page.evaluate(() => {
      const roots = [
        document.querySelector('.jobs-search__job-details'),
        document.querySelector('.jobs-details__body'),
        document.querySelector('[class*="jobs-details"]'),
      ];
      let s = '';
      for (const r of roots) {
        if (r) s += (r.innerText || '') + '\n';
      }
      return s.slice(0, 20000);
    });
    text += (extra || '').toLowerCase();
  } catch {}
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const DAILY_APPLY_STATE_FILE = '.linkedin-easy-apply-daily.json';

function todayKeyForDailyLimit() {
  const tz = config.timezoneId || 'America/Sao_Paulo';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function readDailyApplyState() {
  try {
    if (!existsSync(DAILY_APPLY_STATE_FILE)) {
      return { date: todayKeyForDailyLimit(), count: 0 };
    }
    const raw = JSON.parse(readFileSync(DAILY_APPLY_STATE_FILE, 'utf8'));
    const today = todayKeyForDailyLimit();
    if (raw.date !== today) return { date: today, count: 0 };
    return { date: today, count: Number(raw.count) || 0 };
  } catch {
    return { date: todayKeyForDailyLimit(), count: 0 };
  }
}

function incrementDailyApplyCount() {
  if (!(config.maxApplicationsPerDay > 0)) return;
  const today = todayKeyForDailyLimit();
  let count = 0;
  try {
    if (existsSync(DAILY_APPLY_STATE_FILE)) {
      const raw = JSON.parse(readFileSync(DAILY_APPLY_STATE_FILE, 'utf8'));
      count = raw.date === today ? Number(raw.count) || 0 : 0;
    }
  } catch {}
  count += 1;
  writeFileSync(DAILY_APPLY_STATE_FILE, JSON.stringify({ date: today, count }, null, 0), 'utf8');
}

function getSearchKeywordsList() {
  if (Array.isArray(config.searchKeywordsList) && config.searchKeywordsList.length > 0) {
    return config.searchKeywordsList.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof config.searchKeywords === 'string' && config.searchKeywords.trim()) {
    return [config.searchKeywords.trim()];
  }
  return [''];
}

/** Termo de busca atual na URL de vagas (respeita rotação). */
function getCurrentSearchKeywords() {
  const list = getSearchKeywordsList();
  if (list.length === 0) return '';
  return list[searchKeywordsRotationIndex % list.length];
}

function advanceSearchKeywordRotation() {
  const list = getSearchKeywordsList();
  if (list.length <= 1) return;
  searchKeywordsRotationIndex = (searchKeywordsRotationIndex + 1) % list.length;
}

/** Tokens do termo de vagas para cruzar com o texto do card (opcional). */
function tokenizeJobKeywordsForRecruiterMatch(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const stop = new Set([
    'the',
    'and',
    'or',
    'for',
    'with',
    'from',
    'com',
    'para',
    'uma',
    'dos',
    'das',
    'por',
    'que',
    'remoto',
    'remote',
  ]);
  const parts = raw.split(/\s+OR\s+|\s+or\s+|\||,/i).map((p) => p.trim()).filter(Boolean);
  const tokens = new Set();
  for (const part of parts) {
    for (const w of part.split(/\s+/)) {
      const t = w.replace(/^[^\p{L}\p{N}.+#]+|[^\p{L}\p{N}.+#]+$/gu, '').toLowerCase();
      if (t.length >= 3 && !stop.has(t)) tokens.add(t);
    }
  }
  return [...tokens].slice(0, 18);
}

/**
 * Consultas para busca de pessoas: mescla interesse de vagas (termo atual) com recrutador/talent.
 */
function getRecruiterPeopleSearchQueries() {
  const recTerms = (config.recruiterSearchTerms ?? ['tech recruiter', 'recrutador tech']).map((t) => String(t).trim()).filter(Boolean);
  const align = config.recruiterSearchAlignWithJobKeywords !== false;
  const jobKw = getCurrentSearchKeywords().trim();
  if (!align || !jobKw) return recTerms;
  return recTerms.map((t) => {
    const j = jobKw.slice(0, 280);
    if (t.toLowerCase().includes(j.slice(0, Math.min(24, j.length)).toLowerCase())) return t;
    return `${j} ${t}`.trim();
  });
}

function buildLinkedInPeopleSearchUrl(keywords) {
  const params = new URLSearchParams();
  params.set('keywords', keywords);
  if (config.recruiterActivelyHiringFilter !== false) {
    params.set('activelyHiring', 'true');
  }
  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

/** Liga o filtro "Contratando agora" / Actively hiring na busca de pessoas (UI; Premium pode ser exigido). */
async function tryApplyActivelyHiringPeopleFilter(page) {
  if (config.recruiterActivelyHiringFilter === false) return false;
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {}
  await randomDelay(400, 900);

  const namePatterns = [
    /actively\s*hiring/i,
    /contratando\s*agora/i,
    /estão\s*contratando/i,
    /estao\s*contratando/i,
    /open\s*to\s*hiring/i,
    /recrutando\s*agora/i,
  ];
  for (const re of namePatterns) {
    const btn = page.getByRole('button', { name: re }).first();
    if ((await btn.count().catch(() => 0)) === 0) continue;
    const vis = await btn.isVisible().catch(() => false);
    if (!vis) continue;
    const pressed = await btn.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') return true;
    await btn.click({ timeout: 6000 }).catch(() => null);
    await randomDelay(2200, 4200);
    return true;
  }

  const pill = page
    .locator(
      'button.artdeco-pill, button[class*="filter-pill"], button.search-reusables__filter-pill-button, .search-reusables__filter-pill button'
    )
    .filter({ hasText: /Actively hiring|Contratando agora|Estão contratando|Open to hiring|Recrutando agora/i })
    .first();
  if ((await pill.count().catch(() => 0)) > 0 && (await pill.isVisible().catch(() => false))) {
    const pressed = await pill.getAttribute('aria-pressed').catch(() => null);
    if (pressed !== 'true') await pill.click({ timeout: 6000 }).catch(() => null);
    await randomDelay(2200, 4200);
    return true;
  }

  const allFilters = page
    .locator('button:has-text("All filters"), button:has-text("Todos os filtros")')
    .first();
  if ((await allFilters.count().catch(() => 0)) > 0 && (await allFilters.isVisible().catch(() => false))) {
    await allFilters.click({ timeout: 5000 }).catch(() => null);
    await randomDelay(800, 1600);
    const row = page
      .locator('label, fieldset, div')
      .filter({ hasText: /Actively hiring|Contratando agora|Estão contratando|Open to hiring/i })
      .first();
    if ((await row.count().catch(() => 0)) > 0) {
      const cb = row.locator('input[type="checkbox"]').first();
      if ((await cb.count().catch(() => 0)) > 0) await cb.click({ timeout: 4000 }).catch(() => null);
      else await row.click({ timeout: 3000 }).catch(() => null);
      await randomDelay(400, 800);
    }
    const showResults = page.locator('button:has-text("Show results"), button:has-text("Mostrar resultados")').first();
    if ((await showResults.count().catch(() => 0)) > 0) {
      await showResults.click({ timeout: 5000 }).catch(() => null);
      await randomDelay(2000, 4000);
    } else {
      await page.keyboard.press('Escape').catch(() => null);
    }
    return true;
  }

  return false;
}

async function searchResultCardMatchesJobInterest(item, tokens) {
  if (!tokens.length) return true;
  const text = (await item.innerText().catch(() => '')).toLowerCase();
  return tokens.some((t) => text.includes(t));
}

/** Após um lote de candidaturas: ficar no feed rolando por um tempo aleatório. */
async function browseFeedAfterJobBatch(page) {
  const min = config.feedBreakAfterBatchMinMs ?? 180_000;
  const max = config.feedBreakAfterBatchMaxMs ?? Math.max(min, 480_000);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const duration = lo + Math.floor(Math.random() * (hi - lo + 1));
  console.log(`📱 Pausa no feed ~${Math.round(duration / 60000)} min (duração alternada)...`);
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await longDelay();
  const end = Date.now() + duration;
  let liked = 0;
  const maxLikes = config.feedBreakMaxLikes ?? 12;
  while (Date.now() < end && !stopRequested) {
    const likeBtns = await page.$$('button[aria-label*="Curtir"], button[aria-label*="Like"], button[aria-label*="Reagir"]');
    for (const btn of likeBtns) {
      if (liked >= maxLikes || Date.now() >= end) break;
      try {
        const pressed = await btn.getAttribute('aria-pressed');
        if (pressed === 'true') continue;
        const parent = await btn.evaluate(
          (el) => el.closest('.feed-shared-update-v2, [data-urn]')?.textContent || ''
        );
        if (hasPoliticsContent(parent)) continue;
        if (Math.random() < 0.4) continue;
        await btn.scrollIntoViewIfNeeded();
        await shortDelay();
        await btn.click();
        liked++;
        console.log(`   👍 Feed (lote): curtida ${liked}`);
        await randomDelay(2500, 5000);
      } catch {}
    }
    await humanScroll(page, 'down', 360 + Math.random() * 220);
    await randomDelay(2000, 6000);
  }
  console.log(`   ✅ Feed: fim da pausa (${liked} curtidas).`);
}

/**
 * Teto efetivo do ciclo: min(maxApplications, restante do dia em maxApplicationsPerDay).
 */
function computeSessionApplicationCap() {
  const perCycle = config.maxApplications > 0 ? config.maxApplications : Infinity;
  const dailyCap = config.maxApplicationsPerDay > 0 ? config.maxApplicationsPerDay : Infinity;
  const { count } = readDailyApplyState();
  const remainingToday = Number.isFinite(dailyCap) ? Math.max(0, dailyCap - count) : Infinity;
  const cap = Math.min(perCycle, remainingToday);
  if (!Number.isFinite(cap)) return { maxToApply: Infinity, hasLimit: false, remainingToday, todayCount: count };
  return { maxToApply: cap, hasLimit: true, remainingToday, todayCount: count };
}

function getLoopCooldownMs() {
  const fallback = config.loopCooldownMinutes ?? 5;
  const minM = config.loopCooldownMinutesMin ?? fallback;
  const maxM = config.loopCooldownMinutesMax ?? fallback;
  const lo = Math.min(minM, maxM);
  const hi = Math.max(minM, maxM);
  const minutes = lo + Math.random() * (hi - lo);
  return Math.round(minutes * 60 * 1000);
}

async function pauseMsWithStopCheck(ms, label) {
  const total = Math.max(0, ms);
  if (label) console.log(label);
  for (let t = 0; t < total && !stopRequested; t += 1000) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Volta à lista de vagas após navegar para pessoas/feed durante uma pausa. */
async function restoreJobsSearchList(page) {
  const u = page.url();
  try {
    const parsed = new URL(u);
    if (parsed.pathname.includes('/jobs/search')) {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
      await longDelay();
      return;
    }
  } catch {}
  const params = new URLSearchParams({
    keywords: getCurrentSearchKeywords(),
    location: 'Brasil',
    f_AL: 'true',
  });
  await page.goto(`https://www.linkedin.com/jobs/search/?${params}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  await longDelay();
}

async function pauseAfterApply(page, doConnectGlobal) {
  const min = config.afterApplyDelayMinMs ?? 60_000;
  const max = config.afterApplyDelayMaxMs ?? Math.max(min, 180_000);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  const deadline = Date.now() + ms;
  const useRecruiters =
    (config.recruitersDuringApplyPause !== false) &&
    (doConnectGlobal !== false) &&
    (config.maxConnectionsToRecruiters ?? 10) > 0;

  console.log(
    `   ☕ Pausa pós-candidatura ~${Math.round(ms / 60000)} min${useRecruiters ? ' — incluindo conexões com recrutadores.' : ''}`
  );

  if (!useRecruiters || !page) {
    await pauseMsWithStopCheck(ms, null);
    return;
  }

  const jobsListUrl =
    page.url().includes('linkedin.com/jobs/search') ? page.url() : null;

  const perRound = Math.max(1, config.pauseAfterApplyRecruiterConnections ?? 4);
  while (Date.now() < deadline && !stopRequested) {
    const left = deadline - Date.now();
    if (left < 25_000) {
      await pauseMsWithStopCheck(left, null);
      break;
    }
    await connectWithRecruiters(page, {
      maxConn: perRound,
      quiet: true,
      deadline,
    });
    const after = deadline - Date.now();
    if (after <= 0) break;
    const idle = Math.min(after, 20_000 + Math.floor(Math.random() * 55_000));
    await pauseMsWithStopCheck(idle, null);
  }

  if (jobsListUrl) {
    await page.goto(jobsListUrl, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => restoreJobsSearchList(page));
  } else {
    await restoreJobsSearchList(page);
  }
  await page
    .waitForSelector('.job-card-container, .jobs-search-results__list-item, [data-job-id]', { timeout: 12000 })
    .catch(() => null);
}

async function pauseAfterBrowseOnly() {
  const min = config.afterBrowseDelayMinMs ?? 8_000;
  const max = config.afterBrowseDelayMaxMs ?? 28_000;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  await pauseMsWithStopCheck(ms, null);
}

/** Rola a descrição como leitura humana antes de candidatar ou no modo “só navegar”. */
async function simulateReadingJobDetail(page, descriptionText) {
  const panelSelectors = [
    '.jobs-description__content',
    '.jobs-box__html-content',
    '.jobs-details__main-content',
  ];
  for (const sel of panelSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.scrollIntoViewIfNeeded().catch(() => null);
      break;
    }
  }
  const len = (descriptionText || '').length;
  const scrolls = Math.min(10, Math.max(2, Math.floor(len / 600)));
  for (let s = 0; s < scrolls; s++) {
    await humanScroll(page, 'down', 120 + Math.random() * 180);
    await readingDelay();
    await randomDelay(200, 900);
    if (Math.random() < 0.12) await longDelay();
  }
}

const DEFAULT_BACKEND_KEYWORDS = [
  'backend',
  'back-end',
  'back end',
  'desenvolvedor backend',
  'engenheiro de software',
  'software engineer',
  'desenvolvimento de software',
];
const DEFAULT_TECH_KEYWORDS = [
  'node',
  'node.js',
  'nodejs',
  'nest',
  'nest.js',
  'nestjs',
  'typescript',
  'javascript',
];

function buildJobKeywordList(userList, defaults) {
  const merge = config.mergeDefaultJobKeywords !== false;
  if (!merge) return userList?.length ? userList : defaults;
  const u = Array.isArray(userList) ? userList : [];
  return [...new Set([...defaults, ...u])];
}

/** Verifica se a vaga é backend + Node/Nest/TS/JS e, se configurado, nível sênior */
function jobMatchesKeywords(description, _legacy) {
  const desc = (description || '').toLowerCase();
  const backendKw = buildJobKeywordList(config.backendKeywords, DEFAULT_BACKEND_KEYWORDS);
  const techKw = buildJobKeywordList(config.techKeywords, DEFAULT_TECH_KEYWORDS);
  const hasBackend = backendKw.some((kw) => desc.includes(String(kw).toLowerCase()));
  const hasTech = techKw.some((kw) => desc.includes(String(kw).toLowerCase()));
  const mode = config.jobKeywordMatchMode || 'and';
  const kwOk = mode === 'or' ? hasBackend || hasTech : hasBackend && hasTech;
  if (!kwOk) return false;
  if (config.seniorOnly) {
    const seniorKw = config.seniorKeywords || ['senior', 'sênior', 'sr.', 'staff'];
    const ok = seniorKw.some(kw => desc.includes(String(kw).toLowerCase()));
    if (!ok) return false;
  }
  return true;
}

async function fillFormFields(page, jobTitle) {
  const isSenior = jobTitle.includes('senior') || jobTitle.includes('sênior');
  const salary = isSenior ? (config.salarySenior ?? 15000) : (config.salaryPleno ?? 10000);
  const experience = config.experienceYears ?? 5;
  const modalScope = page.locator('[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-content, .artdeco-modal');

  // Inputs DENTRO do modal Easy Apply
  const modalInputs = modalScope.locator('input');
  const allInputs = await modalInputs.all();

  // 1. Contato: e-mail e celular (popup "Informações de contato")
  for (const input of allInputs) {
    try {
      const context = await input.evaluate(el => {
        const parent = el.closest('div')?.textContent || '';
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
        return (parent + label).toLowerCase();
      });
      if ((context.includes('e-mail') || context.includes('email')) && config.email) {
        const val = await input.inputValue();
        if (!val) {
          await input.fill(config.email);
          await shortDelay();
        }
      }
      if ((context.includes('celular') || context.includes('telefone') || context.includes('phone') || context.includes('número')) && config.phone) {
        const val = await input.inputValue();
        if (!val) {
          await input.fill(config.phone);
          await shortDelay();
        }
      }
    } catch {}
  }

  // 2. Tempo/experiência/conhecimento - sempre 5 anos
  const experienceKeywords = [
    'experiência', 'experience', 'anos', 'years', 'tempo', 'time',
    'conhecimento', 'knowledge', 'há quanto tempo', 'how long',
    'quanto tempo', 'quanto tempo possui', 'anos de', 'years of',
  ];
  for (const input of allInputs) {
    try {
      const context = await input.evaluate(el => {
        const parent = el.closest('div')?.textContent || '';
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
        return (parent + label).toLowerCase();
      });
      const isExperienceField = experienceKeywords.some(kw => context.includes(kw));
      if (isExperienceField) {
        const val = await input.inputValue();
        if (!val) {
          await input.fill(String(experience));
          await shortDelay();
        }
      }
    } catch {}
  }

  // 3. Qualquer campo de remuneração/salário - pretensão, PJ, CLT, etc.
  const salaryKeywords = [
    'salário', 'salary', 'pretensão', 'pretenção', 'remuneração', 'compensation',
    'pretensão salarial', 'pretenção salarial', 'pretensão salarial pj', 'pretenção salarial pj',
    'salarial pj', 'salário pj', 'faixa salarial', 'salary expectation', 'valor pretendido',
  ];
  const salaryFormatted = Number(salary).toFixed(2);
  for (const input of allInputs) {
    try {
      const context = await input.evaluate(el => {
        const parent = el.closest('div')?.textContent || '';
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
        const section = el.closest('.jobs-easy-apply-form-section')?.textContent || '';
        const formGroup = el.closest('[class*="form"]')?.textContent || '';
        return (parent + label + section + formGroup).toLowerCase();
      });
      const isSalaryField = salaryKeywords.some(kw => context.includes(kw));
      if (isSalaryField) {
        const val = await input.inputValue();
        const numVal = parseFloat(val?.replace(',', '.'));
        if (!val || isNaN(numVal) || numVal <= 0) {
          await input.fill(salaryFormatted);
          await shortDelay();
        }
      }
    } catch {}
  }

  // 4. Todo select/dropdown que tem Sim ou Yes - sempre marcar Sim/Yes
  // Select nativo: se tem opção Sim ou Yes, sempre seleciona
  const selects = await modalScope.locator('select').all();
  for (const sel of selects) {
    try {
      const opts = await sel.locator('option').all();
      let simYesOpt = null;
      for (const opt of opts) {
        const t = (await opt.textContent())?.trim().toLowerCase() || '';
        if (t === 'sim' || t === 'yes') {
          simYesOpt = opt;
          break;
        }
      }
      if (simYesOpt) {
        const val = await simYesOpt.getAttribute('value');
        const label = (await simYesOpt.textContent())?.trim();
        const currentText = (await sel.locator('option:checked').first().textContent().catch(() => ''))?.trim().toLowerCase() || '';
        if (!currentText.includes('sim') && !currentText.includes('yes')) {
          if (val) await sel.selectOption(val).catch(() => {});
          else if (label) await sel.selectOption({ label }).catch(() => {});
          await shortDelay();
        }
      }
    } catch {}
  }

  // Dropdown customizado (botão): abre e seleciona Sim/Yes quando disponível
  const dropdownTriggers = await modalScope.locator('button:has-text("Selecionar"), button:has-text("Select")').all();
  for (const btn of dropdownTriggers) {
    try {
      const text = (await btn.textContent())?.trim() || '';
      if (text.includes('Selecionar') || text.includes('Select option')) {
        await btn.click({ force: true });
        await shortDelay();
        const simOption = page.locator('li:has-text("Sim"), li:has-text("Yes"), [role="option"]:has-text("Sim"), [role="option"]:has-text("Yes")').first();
        if (await simOption.count() > 0) {
          await simOption.click({ force: true });
          await shortDelay();
        } else {
          await page.keyboard.press('Escape');
        }
      }
    } catch {}
  }

  // 5. Radio buttons Sim/Não - sempre marcar Sim (locomotiva, híbrido, disponibilidade, etc)
  const radioContainers = await modalScope.locator('.artdeco-radio, [role="radiogroup"] label, .fb-radio').all();
  for (const container of radioContainers) {
    try {
      const text = (await container.textContent())?.trim().toLowerCase() || '';
      if (text === 'sim' || text === 'yes') {
        const isChecked = await container.evaluate(el => {
          const input = el.querySelector('input[type="radio"]');
          return input?.checked ?? el.getAttribute('aria-checked') === 'true';
        }).catch(() => false);
        if (!isChecked) {
          await container.click({ force: true });
          await shortDelay();
        }
      }
    } catch {}
  }
  // Fallback: labels/divs com "Sim" ou "Yes" exato
  const allLabels = await modalScope.locator('label, .artdeco-radio__label, [role="radio"]').all();
  for (const el of allLabels) {
    try {
      const text = (await el.textContent())?.trim() || '';
      if (text === 'Sim' || text === 'Yes') {
        const checked = await el.evaluate(e => e.querySelector('input')?.checked ?? e.getAttribute('aria-checked') === 'true').catch(() => false);
        if (!checked) {
          await el.click({ force: true });
          await shortDelay();
        }
      }
    } catch {}
  }

  // 6. Checkboxes (aceito termos, li e concordo, etc.)
  const checkboxes = await modalScope.locator('input[type="checkbox"]').all();
  for (const box of checkboxes) {
    try {
      const checked = await box.isChecked().catch(() => true);
      if (checked) continue;
      const ctx =
        (await box
          .evaluate((el) => {
            const l = el.closest('label')?.textContent || '';
            const p = el.closest('div')?.textContent || '';
            return (l + p).toLowerCase();
          })
          .catch(() => '')) || '';
      if (
        /aceito|concordo|autorizo|li e|i agree|i have read|termos|privacy|política|confirmo/i.test(ctx)
      ) {
        await box.click({ force: true }).catch(() => null);
        await shortDelay();
      }
    } catch {}
  }

  // 7. Textareas (carta, motivação, comentário adicional)
  const defaultNote =
    config.easyApplyDefaultMessage ||
    'Tenho interesse na vaga e experiência alinhada ao que foi descrito.';
  const textareaHints =
    /carta|apresentação|cover|mensagem|motivo|why|additional|comentário|descreva|explain|tell us|por que|porque/i;
  const textareas = await modalScope.locator('textarea').all();
  for (const ta of textareas) {
    try {
      const ctx = await ta
        .evaluate((el) => {
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const p = el.closest('div')?.textContent || '';
          return ph + aria + p.toLowerCase();
        })
        .catch(() => '');
      const val = await ta.inputValue().catch(() => '');
      if (!val && textareaHints.test(ctx)) {
        await ta.fill(defaultNote);
        await shortDelay();
      }
    } catch {}
  }

  // 8. Demais textareas vazias (perguntas abertas do empregador)
  if (config.easyApplyFillAllEmptyTextareas !== false) {
    const tas2 = await modalScope.locator('textarea').all();
    for (const ta of tas2) {
      try {
        const v = await ta.inputValue().catch(() => '');
        if (!v) {
          await ta.fill(defaultNote);
          await shortDelay();
        }
      } catch {}
    }
  }

  // 9. Radiogroup sem escolha → Sim/Yes ou primeira opção que não seja “upload”
  const radiogroups = await modalScope.locator('[role="radiogroup"], fieldset').all();
  for (const rg of radiogroups) {
    try {
      const checked = await rg.locator('input[type="radio"]:checked').count();
      if (checked > 0) continue;
      const simLbl = rg.locator('label:has-text("Sim"), label:has-text("Yes"), label:has-text("Sí")').first();
      if ((await simLbl.count()) > 0) {
        await simLbl.click({ force: true }).catch(() => null);
        await shortDelay();
        continue;
      }
      const first = rg.locator('input[type="radio"]').first();
      if ((await first.count()) > 0) {
        const lt = await first.evaluate((el) => (el.closest('label')?.innerText || '').toLowerCase()).catch(() => '');
        if (!/upload|carregar|choose file|enviar arquivo/i.test(lt)) {
          await first.click({ force: true }).catch(() => null);
          await shortDelay();
        }
      }
    } catch {}
  }

  // 10. Blocos de formulário do LinkedIn (.fb-form-element) sem rádio marcado
  const fbBlocks = await modalScope.locator('.fb-form-element, .jobs-easy-apply-form-element').all();
  for (const block of fbBlocks) {
    try {
      if ((await block.locator('input[type="radio"]:checked').count()) > 0) continue;
      const y = block.locator('label:has-text("Sim"), label:has-text("Yes")').first();
      if ((await y.count()) > 0) {
        await y.click({ force: true }).catch(() => null);
        await shortDelay();
      }
    } catch {}
  }

  // 11. Select ainda em “Selecionar…” → Brasil ou primeira opção válida
  for (const sel of selects) {
    try {
      const cur = ((await sel.locator('option:checked').first().textContent().catch(() => '')) || '').trim().toLowerCase();
      if (cur && !cur.includes('selecionar') && !cur.includes('select an') && cur !== '') {
        continue;
      }
      const opts = await sel.locator('option').all();
      let done = false;
      for (const opt of opts) {
        const t = ((await opt.textContent()) || '').trim();
        const tl = t.toLowerCase();
        if (!t || tl.includes('selecionar') || tl.includes('select an')) continue;
        if (/brasil|brazil/.test(tl)) {
          const v = await opt.getAttribute('value');
          if (v !== null && v !== '') await sel.selectOption({ value: v }).catch(() => {});
          else await sel.selectOption({ label: t }).catch(() => {});
          done = true;
          break;
        }
      }
      if (!done) {
        for (const opt of opts) {
          const t = ((await opt.textContent()) || '').trim();
          const tl = t.toLowerCase();
          if (!t || tl.includes('selecionar') || tl.includes('select an')) continue;
          const v = await opt.getAttribute('value');
          if (v !== null && v !== '') await sel.selectOption({ value: v }).catch(() => {});
          else await sel.selectOption({ label: t }).catch(() => {});
          break;
        }
      }
      await shortDelay();
    } catch {}
  }

  // 12. Dropdowns artdeco (lista suspensa customizada)
  const ddTriggers = await modalScope
    .locator('button.artdeco-dropdown__trigger, .jobs-easy-apply-form-element__dropdown-button')
    .all();
  for (const btn of ddTriggers) {
    try {
      if (!(await btn.isVisible().catch(() => false))) continue;
      const tx = ((await btn.textContent()) || '').toLowerCase();
      if (!/selecionar|select an option|select option/i.test(tx)) continue;
      await btn.click({ force: true }).catch(() => null);
      await shortDelay();
      const simOpt = page
        .locator('[role="listbox"] [role="option"], .artdeco-dropdown__item, li[role="option"]')
        .filter({ hasText: /^(Sim|Yes|Sí)$/i })
        .first();
      if ((await simOpt.count()) > 0 && (await simOpt.isVisible().catch(() => false))) {
        await simOpt.click({ force: true }).catch(() => null);
      } else {
        const firstOpt = page.locator('[role="listbox"] [role="option"], .artdeco-dropdown__item').first();
        if ((await firstOpt.count()) > 0) await firstOpt.click({ force: true }).catch(() => null);
      }
      await shortDelay();
      await page.keyboard.press('Escape').catch(() => null);
    } catch {}
  }

  // 13. Inputs texto/número vazios (anos de experiência, URL, etc.)
  const genInputs = await modalScope.locator('input[type="text"], input[type="number"]').all();
  for (const input of genInputs) {
    try {
      const val = await input.inputValue().catch(() => '');
      if (val) continue;
      const ctx = await input
        .evaluate((el) => {
          const id = el.id;
          let lb = '';
          try {
            if (id) lb = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '';
          } catch {}
          const p = el.closest('.jobs-easy-apply-form-element')?.textContent || el.closest('div')?.textContent || '';
          return ((lb || '') + ' ' + p).toLowerCase();
        })
        .catch(() => '');
      if (/ano|year|experiência|experience|how many|quantos anos/i.test(ctx)) {
        await input.fill(String(experience)).catch(() => null);
        await shortDelay();
      } else if (/(linkedin|github|portfolio|website|url|site)/i.test(ctx) && config.portfolioUrl) {
        await input.fill(String(config.portfolioUrl)).catch(() => null);
        await shortDelay();
      }
    } catch {}
  }
}

/**
 * Tenta usar currículo já salvo no LinkedIn (perfil / candidatura recente) — nunca aciona upload novo.
 */
async function tryUseLinkedInSavedResume(page) {
  if (config.preferLinkedInSavedResume === false) return false;
  const modal = page.locator('[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-content').first();
  let tried = false;

  const clickIfVisible = async (loc) => {
    if ((await loc.count()) === 0) return false;
    const vis = await loc.first().isVisible().catch(() => false);
    if (!vis) return false;
    await loc.first().click({ timeout: 4000, force: true }).catch(() => null);
    await shortDelay();
    return true;
  };

  const textPatterns = [
    modal.locator('label').filter({ hasText: /usar o currículo mais recente|use most recent resume/i }),
    modal.locator('label').filter({ hasText: /currículo salvo|saved resume|resume on file/i }),
    modal.locator('label').filter({ hasText: /do seu perfil|from your profile|perfil do linkedin/i }),
    modal.locator('span, button, div').filter({ hasText: /usar este currículo|use this resume/i }),
    modal.locator('label, span, div').filter({ hasText: /compartilhar perfil|share profile|online resume/i }),
    modal.locator('label, span').filter({ hasText: /currículo do linkedin|linkedin resume/i }),
    modal.locator('button, a').filter({ hasText: /aplicar com o perfil|apply using profile/i }),
  ];
  for (const loc of textPatterns) {
    if (await clickIfVisible(loc)) {
      tried = true;
      break;
    }
  }

  // Não clicar no nome do .pdf (pode abrir preview ou disparar download). Só rádios / rótulos abaixo.

  if (!tried) {
    const radios = await modal.locator('input[type="radio"], [role="radio"]').all();
    for (const r of radios) {
      try {
        const blob =
          `${(await r.getAttribute('aria-label')) || ''} ${(await r.textContent()) || ''} ${await r.evaluate((el) => el.closest('label')?.innerText || el.parentElement?.innerText || '')}`.toLowerCase();
        if (/upload|carregar|enviar arquivo|choose file|selecionar arquivo|novo currículo|new resume|upload a file|attach/i.test(blob)) {
          continue;
        }
        if (/pdf|doc|currículo|resume|recent|salvo|saved|perfil|profile|última|last application|candidatura|online|linkedin/i.test(blob)) {
          await r.click({ force: true, timeout: 3000 }).catch(() => null);
          await shortDelay();
          tried = true;
          break;
        }
      } catch {}
    }
  }

  if (tried) {
    console.log('   📎 Usando currículo / perfil já no LinkedIn (sem enviar arquivo novo).');
  }
  return tried;
}

/** Fecha o modal Easy Apply (várias estratégias — evita ficar preso em campo não mapeado). */
async function dismissEasyApplyModal(page) {
  const modalScope = page.locator('[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-content').first();
  const selectors = [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Fechar"]',
    'button[aria-label="Close"]',
    '[data-test-modal-close-btn]',
    'button.artdeco-modal__dismiss',
    '.artdeco-modal__dismiss',
  ];
  for (const sel of selectors) {
    try {
      const btn = modalScope.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 2500, force: true }).catch(() => null);
        await shortDelay();
        return;
      }
    } catch {}
  }
  await page.keyboard.press('Escape').catch(() => null);
  await shortDelay();
}

async function applyToJob(page) {
  try {
    const jobTitle = await getJobTitle(page);

    const clicked = await runStep('APPLY_CLICK_EASY_APPLY', async () => {
      // APENAS no painel de detalhes da vaga — NUNCA no filtro da barra lateral
      const easyApplySelectors = [
        '.jobs-details__main-content button.jobs-apply-button',
        '.jobs-details__main-content button:has-text("Candidatura simplificada")',
        '.jobs-details__main-content button:has-text("Easy Apply")',
        '.job-details-jobs-unified-top-card__content button.jobs-apply-button',
        '.job-details-jobs-unified-top-card__content button:has-text("Candidatura simplificada")',
        '.job-details-jobs-unified-top-card__content button:has-text("Easy Apply")',
        '.jobs-search__job-details button.jobs-apply-button',
        '.jobs-search__job-details button:has-text("Candidatura simplificada")',
      ];
      let easyApplyLocator = null;
      for (const sel of easyApplySelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0) {
          easyApplyLocator = loc;
          break;
        }
      }
      if (!easyApplyLocator) return false;
      await easyApplyLocator.waitFor({ state: 'visible', timeout: 10000 });
      await easyApplyLocator.scrollIntoViewIfNeeded();
      await shortDelay();
      await easyApplyLocator.click({ timeout: 8000, force: true });
      await readingDelay();
      return true;
    }, STEP_TIMEOUT_LONG).catch((e) => {
      if (e?.message?.startsWith('TRAVOU_EM:')) throw e;
      return false;
    });
    if (!clicked) return false;

    const modalOk = await runStep('APPLY_WAIT_MODAL', async () => {
      const modal = page.locator('[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-content');
      await modal.first().waitFor({ state: 'visible', timeout: 8000 });
      await shortDelay();
      return true;
    }, STEP_TIMEOUT_LONG).catch((e) => {
      if (e?.message?.startsWith('TRAVOU_EM:')) throw e;
      return false;
    });
    if (!modalOk) return false;

    await tryUseLinkedInSavedResume(page);

    // LinkedIn limite diário? Para e vai para feed/recrutadores
    if (await isDailyLimitReached(page)) {
      console.log('   ⚠️ Limite diário do LinkedIn atingido. Parando candidaturas.');
      const modalScope = page.locator('[data-test-modal-id="easy-apply-modal"]').first();
      const closeLoc = modalScope.locator('button[aria-label="Dismiss"], button[aria-label="Fechar"], button[aria-label="Close"]').first();
      if (await closeLoc.count() > 0) await closeLoc.click({ timeout: 3000, force: true }).catch(() => null);
      return 'daily_limit';
    }

    // Fluxo do modal Easy Apply - clica APENAS em botões DENTRO do modal
    let applied = false;
    let attempts = 0;
    const maxAttempts = config.easyApplyMaxModalSteps ?? 24;

    while (!applied && attempts < maxAttempts) {
      const modalRoot = page.locator('[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-content').first();

      // Só pula por arquivo se você marcou skipEasyApplyWithFileUpload: true (forçado).
      // Por padrão tenta usar currículo do perfil (tryUseLinkedInSavedResume em fillFormFields).
      if (config.skipEasyApplyWithFileUpload === true) {
        const fileCount = await modalRoot.locator('input[type="file"]').count().catch(() => 0);
        if (fileCount > 0) {
          console.log('   ⚠️ skipEasyApplyWithFileUpload: true — fechando vaga com campo de arquivo.');
          await dismissEasyApplyModal(page);
          return false;
        }
      }

      if (attempts >= (config.easyApplyStuckDismissAfter ?? 16)) {
        console.log('   ⚠️ Muitas etapas no Easy Apply — fechando para não travar.');
        await dismissEasyApplyModal(page);
        return false;
      }

      await runStep(`APPLY_MODAL_STEP_${attempts + 1}`, async () => {
        await tryUseLinkedInSavedResume(page);
        await fillFormFields(page, jobTitle);
        await shortDelay();
        await scrollModalToBottom(page);
        await tryUseLinkedInSavedResume(page);
      });

      const modalScope = page.locator('[data-test-modal-id="easy-apply-modal"]').first();

      // Limite diário apareceu no meio do fluxo?
      if (await isDailyLimitReached(page)) {
        const closeLoc = modalScope.locator('button[aria-label="Dismiss"], button[aria-label="Fechar"], button[aria-label="Close"]').first();
        if (await closeLoc.count() > 0) await closeLoc.click({ timeout: 3000, force: true }).catch(() => null);
        return 'daily_limit';
      }

      // Botão enviar / aplicar (várias variações de texto)
      const submitLoc = modalScope
        .locator(
          'button:has-text("Enviar candidatura"), button:has-text("Submit application"), button:has-text("Submit"), button:has-text("Enviar inscrição"), button:has-text("Aplicar agora"), button:has-text("Apply now"), button:has-text("Aplicar")'
        )
        .first();
      if ((await submitLoc.count()) > 0) {
        const subEnabled = await submitLoc.isEnabled().catch(() => true);
        if (subEnabled) {
          await runStep('APPLY_CLICK_ENVIAR', async () => {
            await submitLoc.scrollIntoViewIfNeeded().catch(() => null);
            await submitLoc.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
            await submitLoc.click({ timeout: 8000, force: true });
          });
          await randomDelay(2000, 4000);
          applied = true;
          await page.waitForSelector('button:has-text("Concluído"), button:has-text("Done")', { timeout: 5000 }).catch(() => null);
          break;
        }
      }

      const nextLoc = modalScope
        .locator(
          'button:has-text("Avançar"), button:has-text("Next"), button:has-text("Continue"), button:has-text("Continuar"), button:has-text("Revisar"), button:has-text("Review")'
        )
        .first();
      if ((await nextLoc.count()) > 0) {
        const dis = await nextLoc.getAttribute('disabled');
        const ariaD = await nextLoc.getAttribute('aria-disabled');
        let enabled = await nextLoc.isEnabled().catch(() => true);
        if (dis || ariaD === 'true' || !enabled) {
          console.log('   ⏳ Avançar desabilitado — reforçando currículo salvo e campos...');
          await tryUseLinkedInSavedResume(page);
          await fillFormFields(page, jobTitle);
          await scrollModalToBottom(page);
          await tryUseLinkedInSavedResume(page);
          await randomDelay(600, 1400);
          enabled = await nextLoc.isEnabled().catch(() => false);
          const dis2 = await nextLoc.getAttribute('disabled');
          const aria2 = await nextLoc.getAttribute('aria-disabled');
          if (dis2 || aria2 === 'true' || !enabled) {
            console.log('   ⚠️ Ainda não foi possível avançar — fechando esta candidatura.');
            await dismissEasyApplyModal(page);
            return false;
          }
        }
        await runStep('APPLY_CLICK_AVANCAR', async () => {
          await nextLoc.scrollIntoViewIfNeeded().catch(() => null);
          await nextLoc.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
          await shortDelay();
          await nextLoc.click({ timeout: 8000, force: true });
        });
        await readingDelay();
      } else {
        console.log('   ⚠️ Sem Avançar/Enviar reconhecido no modal — fechando.');
        await dismissEasyApplyModal(page);
        break;
      }
      attempts++;
    }

    // Fecha o modal de sucesso ("Candidatura enviada") - botão Concluído ou X
    const closeSelectors = [
      'button:has-text("Concluído")',
      'button:has-text("Done")',
      'button:has-text("Fechar")',
      'button[aria-label="Dismiss"]',
      'button[aria-label="Fechar"]',
      'button[aria-label="Close"]',
    ];
    for (const sel of closeSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0) {
          await btn.waitFor({ state: 'visible', timeout: 2000 });
          await btn.click({ timeout: 3000, force: true });
          await shortDelay();
          break;
        }
      } catch {}
    }
    
    await randomDelay(1000, 2000);
    return applied;
  } catch (err) {
    if (err?.message?.startsWith('TRAVOU_EM:')) throw err;
    console.log('   ⚠️ Erro ao candidatar:', err.message);
    return false;
  }
}

async function run() {
  if (!config.email || !config.password || config.email.includes('exemplo')) {
    console.error('❌ Configure o config.js com suas credenciais!');
    console.log('   Copie config.example.js para config.js e preencha.');
    process.exit(1);
  }

  setSpeed(config.speed || 'fast');
  const dailyCap = config.maxApplicationsPerDay > 0 ? config.maxApplicationsPerDay : null;
  const dailyState = readDailyApplyState();
  console.log('🚀 Iniciando automação LinkedIn Easy Apply');
  console.log(
    `   Máximo por ciclo: ${config.maxApplications > 0 ? config.maxApplications : '∞'} | por dia (arquivo local): ${dailyCap ?? '∞'}${dailyCap ? ` (hoje: ${dailyState.count}/${dailyCap})` : ''}`
  );
  console.log(`   Velocidade: ${config.speed || 'fast'} (use "human" para mais pausa)`);
  if ((config.browseWithoutApplyChance ?? 0) > 0) {
    console.log(`   Chance “só navegar” sem Easy Apply: ${Math.round((config.browseWithoutApplyChance ?? 0) * 100)}%`);
  }
  console.log(
    `   Filtro de vaga: ${config.jobKeywordMatchMode === 'or' ? 'backend OU stack' : 'backend E stack'}${config.mergeDefaultJobKeywords === false ? ' (só suas keywords)' : ' + termos padrão'}`
  );
  const kwList = getSearchKeywordsList();
  if (kwList.length > 1) {
    console.log(`   Rotação de busca: ${kwList.length} termos — após ${config.applicationsBeforeSearchRotate ?? 15} candidaturas → feed + recrutadores + próximo termo.`);
  }
  console.log(`   Log de travamento: apenas durante candidatura (timeout ${STEP_TIMEOUT / 1000}s)`);
  if (config.headless) {
    console.log('👻 headless: true — o navegador roda sem janela. Para ver o Chrome: headless: false no config.js');
  } else {
    console.log('🪟 headless: false — o navegador deve abrir visível. Se não aparecer: Alt+Tab ou ícone na barra de tarefas.');
  }
  console.log('');

  const wsl = isWsl();
  if (wsl && !config.headless && !config.useExistingChrome && config.browser !== 'firefox') {
    console.error('');
    console.error('❌ No WSL, com janela visível, não dá para usar o navegador instalado no Linux.');
    console.error('   (É o Chrome com ícone de pinguim na barra — não é o Chrome do Windows.)');
    console.error('');
    console.error('   Coloque no config.js: useExistingChrome: true');
    console.error('   Depois: PowerShell Admin → portproxy na porta 9222 (README.md)');
    console.error('   Feche todos os Chromes → no WSL: npm run chrome → npm start');
    console.error('   Ou rode npm start no PowerShell do Windows com useExistingChrome: false.');
    console.error('');
    process.exit(1);
  }

  // Firefox tem menos dependências no Linux/WSL - use se Chromium falhar
  const useFirefox = config.browser === 'firefox';
  const useExistingChrome = config.useExistingChrome && !useFirefox;
  const browserType = useFirefox ? firefox : chromium;

  let browser;
  let context;

  if (useExistingChrome) {
    const port = config.chromeDebugPort ?? 9222;
    const configuredHost = config.chromeDebugHost ?? 'localhost';
    const hostsToTry = buildChromeDebugHostsToTry(configuredHost, wsl);
    let lastError;
    for (const h of hostsToTry) {
      const cdpUrl = `http://${h}:${port}`;
      console.log(`   Conectando ao seu Chrome (${h}:${port})...`);
      try {
        browser = await chromium.connectOverCDP(cdpUrl);
        context = browser.contexts()[0];
        if (!context) context = await browser.newContext();
        console.log('   ✅ Conectado ao seu Chrome! Usando sua sessão/cookies.');
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!browser || lastError) {
      const h = hostsToTry[0];
      console.error(`   ❌ Não foi possível conectar ao Chrome em ${h}:${port}.`);
      console.error('');
      if (process.platform === 'win32') {
        console.error('   No Windows você escolhe:');
        console.error('');
        console.error('   A) Mais simples: no config.js use useExistingChrome: false — o script abre o Chrome sozinho.');
        console.error('');
        console.error('   B) Manter useExistingChrome: true: feche o Chrome, rode .\\chrome-debug.cmd, depois start.cmd.');
        console.error('');
      }
      if (process.platform === 'linux') {
        console.error('   Rodando do WSL? Checklist:');
        console.error('');
        console.error('   1) No Windows: feche o Chrome e abra com --remote-debugging-port=' + port + ' (npm run chrome ou chrome-debug.cmd)');
        console.error('   2) Diagnóstico automático (no WSL, nesta pasta): npm run chrome:ping');
        console.error('   3) Manual: cat /etc/resolv.conf → curl -s http://IP_DO_NAMESERVER:' + port + '/json/version');
        console.error('   4) Se falhar: PowerShell Admin — portproxy + firewall (README):');
        console.error('      netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=' + port + ' connectaddress=127.0.0.1 connectport=' + port);
        console.error('      New-NetFirewallRule -DisplayName "Chrome DevTools" -Direction Inbound -Protocol TCP -LocalPort ' + port + ' -Action Allow');
        console.error('');
      }
      console.error('   Linha de comando do Chrome (se abrir manualmente):');
      console.error('   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=' + port + ' --remote-allow-origins=*');
      process.exit(1);
    }
  } else {
    // NUNCA usar viewport: null + --start-maximized no Windows com Playwright: o contexto fica sem
    // windowId interno e a janela pode não aparecer ou ficar “invisível” no monitor.
    const chromeArgs = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=en-US',
      // Posição na área visível do monitor principal (evita janela “perdida” em monitor desligado)
      `--window-size=${VIEWPORT.width + 24},${VIEWPORT.height + 100}`,
      '--window-position=120,80',
    ];
    if (wsl && !config.headless) {
      chromeArgs.push('--disable-dev-shm-usage');
      chromeArgs.push('--disable-gpu');
    }
    const launchOptions = {
      headless: config.headless,
      slowMo: config.speed === 'fast' ? 0 : config.speed === 'slow' ? 80 : 25,
      args: useFirefox
        ? ['-width', String(VIEWPORT.width + 24), '-height', String(VIEWPORT.height + 100)]
        : chromeArgs,
    };
    // No WSL (Linux no Windows) o channel "chrome" é o binário Linux, não o seu Chrome — costuma ser instável; prefira useExistingChrome
    if (!useFirefox && !(process.platform === 'linux' && wsl)) launchOptions.channel = 'chrome';
    try {
      browser = await browserType.launch(launchOptions);
    } catch {
      if (!useFirefox) {
        delete launchOptions.channel;
        browser = await browserType.launch(launchOptions); // Fallback: Chromium
      } else throw new Error('Falha ao iniciar Firefox');
    }
    context = await browser.newContext({
      acceptDownloads: false,
      viewport: VIEWPORT,
      userAgent: useFirefox
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: config.timezoneId || 'America/Sao_Paulo',
      geolocation: { 
        latitude: config.geoLatitude ?? -23.5505, 
        longitude: config.geoLongitude ?? -46.6333 
      }, // São Paulo
      permissions: ['geolocation'],
    });
  }

  attachBlockAllDownloads(context);

  // Esconde que é automação
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  if (!config.headless) {
    try {
      await page.bringToFront();
    } catch {}
  }
  const loopMode = config.loopMode ?? false;
  const processedIds = new Set(); // Persiste entre ciclos para não candidatar 2x

  try {
    await waitForManualLogin(page);
    if (loopMode) console.log('🔄 Modo loop ativo — Ctrl+C para parar');
    let cycleCount = 0;
    let sessionApplyBatchCount = 0;

    const doApply = config.doApply ?? true;
    const doFeed = config.doFeed ?? config.doFeedAndRecruiters ?? true;
    const doConnect = config.doConnect ?? config.doFeedAndRecruiters ?? true;

    do {
      cycleCount++;
      console.log('');
      console.log('═'.repeat(50));
      console.log(`🔄 CICLO ${cycleCount}`);
      console.log('═'.repeat(50));
      applicationsCount = 0;

      if (doApply) {
      await goToJobs(page);
      await ensureJobsPage(page);
      await searchJobs(page);
    // Filtro Easy Apply já vem na URL (f_AL=true) - não clicar no botão para não remover

    // Lista de vagas
    await humanScroll(page, 'down', 400);
    await randomDelay(2000, 4000);

    const { maxToApply, hasLimit, todayCount } = computeSessionApplicationCap();
    let scrollRound = 0;
    let noNewCardsCount = 0;
    let dailyLimitReached = false;
    let jobsPageIndex = 0;
    const maxJobsPages = config.maxJobsSearchPages ?? 30;

    const filtros = (config.seniorOnly ? 'senior + ' : '') + 'backend + Node/Nest/TS/JS';
    const limiteCiclo = Number.isFinite(maxToApply) ? String(maxToApply) : '∞';
    console.log(
      `📌 Processando vagas (${filtros}) — máx neste ciclo: ${limiteCiclo}${config.maxApplicationsPerDay > 0 ? ` | candidaturas hoje: ${todayCount}/${config.maxApplicationsPerDay}` : ''}`
    );
    if (hasLimit && maxToApply <= 0) {
      console.log('   (Nada a enviar neste ciclo: teto diário ou limite por ciclo.)');
    }
    console.log('');

    while (!stopRequested && !dailyLimitReached && (hasLimit ? applicationsCount < maxToApply : true)) {
      const cards = await page.$$('.job-card-container, .jobs-search-results__list-item, [data-job-id]');
      if (cards.length === 0) break;

      let hadNewCard = false;
      for (let i = 0; i < cards.length && (hasLimit ? applicationsCount < maxToApply : true); i++) {
        // Re-busca o card a cada iteração (LinkedIn remove do DOM ao rolar)
        const cardsNow = await page.$$('.job-card-container, .jobs-search-results__list-item, [data-job-id]');
        if (i >= cardsNow.length) break;
        const card = cardsNow[i];

        let jobId;
        try {
          jobId = await card.getAttribute('data-job-id').catch(() => null) || await card.getAttribute('data-occludable-job-id').catch(() => null) || `r${scrollRound}-${i}`;
        } catch {
          continue; // Card desanexado, pula
        }
        if (processedIds.has(jobId)) continue;
        processedIds.add(jobId);
        hadNewCard = true;

        try {
          await card.scrollIntoViewIfNeeded();
          await randomDelay(500, 1500);
          await card.click();
          await waitForJobDetailContent(page);
          await longDelay();
        } catch (e) {
          if (/not attached|detached/i.test(e?.message || '')) {
            continue; // Card removido do DOM, pula para o próximo
          }
          throw e;
        }

        const jobText = await getAggregatedJobText(page);
        if (!jobMatchesKeywords(jobText)) {
          const mode = config.jobKeywordMatchMode || 'and';
          const req =
            mode === 'or'
              ? (config.seniorOnly ? 'senior + ' : '') + '(backend OU stack Node/Nest/TS/JS)'
              : (config.seniorOnly ? 'senior + ' : '') + 'backend E stack Node/Nest/TS/JS';
          if (config.debugJobFilter) {
            const preview = jobText.length ? `${jobText.slice(0, 100)}…` : '(texto vazio — painel pode não ter carregado)';
            console.log(`   ⏭️ Vaga ignorada (${req}) — ${jobText.length} chars — ${preview}`);
          } else {
            console.log(`   ⏭️ Vaga ignorada (precisa ser ${req})`);
          }
          continue;
        }

        const browseChance = Math.min(1, Math.max(0, config.browseWithoutApplyChance ?? 0));
        if (browseChance > 0 && Math.random() < browseChance) {
          console.log('   👀 Só navegando nesta vaga (sem candidatura)');
          await simulateReadingJobDetail(page, jobText);
          await pauseAfterBrowseOnly();
          continue;
        }

        if (config.simulateReadBeforeApply !== false) {
          await simulateReadingJobDetail(page, jobText);
        }

        const applied = await applyToJob(page);
        if (applied === 'daily_limit') {
          dailyLimitReached = true;
          console.log('   ⚠️ Limite diário atingido — indo para feed e recrutadores.');
          break;
        }
        if (applied) {
          applicationsCount++;
          incrementDailyApplyCount();
          const lim =
            Number.isFinite(maxToApply) && maxToApply > 0 ? `/${maxToApply}` : '';
          console.log(`   ✅ Candidatura ${applicationsCount}${lim} enviada!`);
          await pauseAfterApply(page, doConnect);

          const batchN = config.applicationsBeforeSearchRotate ?? 15;
          if (batchN > 0) {
            sessionApplyBatchCount++;
            if (sessionApplyBatchCount >= batchN) {
              sessionApplyBatchCount = 0;
              advanceSearchKeywordRotation();
              console.log('');
              console.log('═'.repeat(42));
              console.log(`🔀 Lote de ${batchN} candidaturas: feed + recrutadores + nova busca`);
              console.log(`   Próximo termo: "${getCurrentSearchKeywords()}"`);
              console.log('═'.repeat(42));
              await browseFeedAfterJobBatch(page);
              if (doConnect) {
                await connectWithRecruiters(page, {
                  maxConn: config.afterBatchRecruiterConnections ?? config.maxConnectionsToRecruiters ?? 10,
                  quiet: false,
                });
              }
              await goToJobs(page);
              await ensureJobsPage(page);
              await searchJobs(page);
              await humanScroll(page, 'down', 400);
              await randomDelay(2000, 4000);
              jobsPageIndex = 0;
              noNewCardsCount = 0;
              scrollRound = 0;
            }
          }
        } else {
          await randomDelay(2000, 5000);
        }
      }

      if (stopRequested || dailyLimitReached || (hasLimit && applicationsCount >= maxToApply)) break;
      if (!hadNewCard) {
        noNewCardsCount = (noNewCardsCount || 0) + 1;
        if (noNewCardsCount >= 3) {
          if (jobsPageIndex < maxJobsPages) {
            const advanced = await goToNextJobsResultsPage(page);
            if (advanced) {
              jobsPageIndex++;
              noNewCardsCount = 0;
              await humanScroll(page, 'up', 120);
              await randomDelay(800, 1600);
              continue;
            }
          }
          break;
        }
      } else {
        noNewCardsCount = 0;
      }

      // Rola para carregar mais vagas (LinkedIn usa lazy loading)
      console.log('   📜 Carregando mais vagas...');
      await humanScroll(page, 'down', 800);
      await randomDelay(2000, 4000);
      // Reaplica filtro Easy Apply se foi removido acidentalmente
      if (!page.url().includes('f_AL=true')) {
        const params = new URLSearchParams({
          keywords: getCurrentSearchKeywords(),
          location: 'Brasil',
          f_AL: 'true',
        });
        await page.goto(`https://www.linkedin.com/jobs/search/?${params}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await randomDelay(2000, 3000);
      }
      scrollRound++;
    }

    console.log('');
    if (dailyLimitReached) {
      console.log(`⚠️ Limite diário do LinkedIn — ${applicationsCount} candidaturas enviadas. Indo para feed e recrutadores.`);
    } else {
      console.log(`🎉 Candidaturas: ${applicationsCount} enviadas.`);
    }
    } else {
      console.log('📌 Candidaturas desativadas (doApply: false)');
    }

    if (doFeed) {
      try {
        await interactWithFeed(page);
      } catch (e) {
        console.log('   ⚠️ Feed:', e?.message || e);
      }
    } else {
      console.log('📌 Feed desativado (doFeed: false)');
    }

    if (doConnect) {
      try {
        await connectWithRecruiters(page);
      } catch (e) {
        console.log('   ⚠️ Conexões:', e?.message || e);
      }
    } else {
      console.log('📌 Conexões desativadas (doConnect: false)');
    }

    if (!loopMode || stopRequested) break;
    const cooldownMs = getLoopCooldownMs();
    const cooldownMinRough = Math.max(1, Math.round(cooldownMs / 60000));
    console.log('');
    console.log(
      `⏸️  ~${cooldownMinRough} min até o próximo ciclo — navegando feed e perfis nesse intervalo.`
    );
    await runCoolDownWithBrowsing(page, cooldownMs);
    } while (true);

    if (stopRequested) console.log('⏹️  Parado pelo usuário.');

    console.log('');
    console.log('✨ Tudo concluído!');
  } catch (err) {
    if (err.message?.startsWith('TRAVOU_EM:')) {
      const step = err.message.replace('TRAVOU_EM:', '');
      console.error('');
      console.error('⏱️  TRAVOU - A operação demorou mais de', STEP_TIMEOUT / 1000, 'segundos');
      console.error('📍 Etapa onde travou:', step);
      console.error('   Dica: verifique seletor ou aumente stepTimeoutLog no config.js');
      console.error('');
    } else {
      console.error('❌ Erro:', err.message);
    }
  } finally {
    await randomDelay(3000, 6000);
    if (!useExistingChrome) await browser.close();
  }
}

run();
