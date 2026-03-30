/**
 * LinkedIn Easy Apply - Automação humanizada
 * Candidatura automática em vagas simplificadas para dev senior/pleno
 * 
 * AVISO: Use por sua conta e risco. LinkedIn proíbe automação nos ToS.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
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

/** Rola o modal até o final para revelar botões Avançar/Enviar */
async function scrollModalToBottom(page) {
  for (let i = 0; i < 3; i++) {
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
      for (let i = 0; i < 5; i++) {
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
    const clickedGoogle = await tryClickGoogleLogin(page);
    if (clickedGoogle) {
      await shortDelay();
      // Popup pode demorar; tenta trazer qualquer janela nova que já exista
      for (const p of ctx.pages()) {
        if (p !== page) await bringPopupToFront(p);
      }
    }

    console.log('');
    console.log('   👤 Faça o login manualmente no navegador (e na janela do Google, se abrir).');
    console.log('   ⏳ Quando terminar, o script continuará automaticamente...');
    console.log('');

    await page.waitForURL(/linkedin\.com\/(feed|jobs|mynetwork|in\/)/, { timeout: 300000 }); // 5 min
    console.log('   ✅ Login detectado!');
  } finally {
    ctx.off('page', bringPopupToFront);
  }
}

function hasPoliticsContent(text) {
  const kw = config.politicsBlacklist || ['política', 'eleição', 'presidente', 'voto', 'partido', 'candidato'];
  const t = (text || '').toLowerCase();
  return kw.some(k => t.includes(k.toLowerCase()));
}

/** Curtir alguns posts no feed (evita política) */
async function interactWithFeed(page) {
  const count = config.feedLikesCount ?? 5;
  if (count <= 0) return;
  console.log('');
  console.log('📱 Indo para o feed...');
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
  if (liked > 0) console.log(`   ✅ ${liked} curtidas no feed.`);
}

/** Busca recrutadores e envia conexões */
async function connectWithRecruiters(page) {
  const maxConn = config.maxConnectionsToRecruiters ?? 10;
  const terms = config.recruiterSearchTerms ?? ['tech recruiter', 'recrutador tech'];
  if (maxConn <= 0) return;
  console.log('');
  console.log('🔍 Buscando recrutadores tech...');
  let totalConnected = 0;
  const sendModalSel = 'button:has-text("Enviar sem nota"), button:has-text("Send without note"), button:has-text("Enviar"), button:has-text("Send"), button[aria-label*="Enviar"], button[aria-label*="Send invitation"]';
  for (const term of terms) {
    if (totalConnected >= maxConn) break;
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(term)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await longDelay();
    await page.waitForSelector('ul.reusable-search__entity-result-list, li.reusable-search__result-container, [class*="entity-result"]', { timeout: 15000 }).catch(() => null);
    await randomDelay(5000, 7000);
    await humanScroll(page, 'down', 500);
    await randomDelay(2000, 4000);
    for (let n = 0; n < maxConn - totalConnected; n++) {
      const result = await page.evaluate((doDebug) => {
        const tryClick = (el) => {
          if (!el || el.offsetParent === null) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        };
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          const txt = (b.textContent || '').trim();
          const aria = (b.getAttribute('aria-label') || '').trim();
          const lower = (txt + ' ' + aria).toLowerCase();
          if (!/conectar|connect|invite|convidar/.test(lower)) continue;
          if (/pendente|pending|conectado|connected|mensagem|message|seguir|follow/.test(lower)) continue;
          if (tryClick(b)) return { clicked: true };
        }
        const spans = document.querySelectorAll('span');
        for (const s of spans) {
          const txt = (s.textContent || '').trim();
          if (!/^(\+?\s*)?(conectar|connect)$/i.test(txt)) continue;
          const clickable = s.closest('button') || s.closest('[role="button"]') || s.closest('a') || s.parentElement?.parentElement || s.parentElement;
          if (clickable && tryClick(clickable)) return { clicked: true };
        }
        return { clicked: false, debug: doDebug ? { total: btns.length + spans.length } : null };
      }, config.debugConnect ?? false);
      if (!result.clicked) {
        const shouldDebug = config.debugConnect || (totalConnected === 0 && n === 0);
        if (shouldDebug && result.debug) {
          console.log('   🐛 Debug:', result.debug.total, 'elementos verificados');
          await page.screenshot({ path: 'debug-connect.png' }).catch(() => null);
          console.log('   🐛 Screenshot salvo: debug-connect.png');
        }
        break;
      }
      await randomDelay(3000, 5000);
      const sendBtn = page.locator(sendModalSel).first();
      if (await sendBtn.count() > 0) {
        await sendBtn.click({ timeout: 4000 }).catch(() => null);
        totalConnected++;
        console.log(`   🤝 Conexão ${totalConnected}/${maxConn} enviada`);
      } else {
        await page.keyboard.press('Escape').catch(() => null);
      }
      await randomDelay(3000, 6000);
    }
  }
  if (totalConnected > 0) console.log(`   ✅ ${totalConnected} conexões enviadas a recrutadores.`);
  else console.log('   ⚠️ Nenhuma conexão enviada (botão não encontrado ou já conectados).');
}

/** Garante que estamos na página de vagas (jobs) */
async function ensureJobsPage(page) {
  const url = page.url();
  if (!url.includes('linkedin.com/jobs')) {
    const params = new URLSearchParams({ keywords: config.searchKeywords, location: 'Brasil', f_AL: 'true' });
    await page.goto(`https://www.linkedin.com/jobs/search/?${params}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await longDelay();
  }
}

async function goToJobs(page) {
  console.log('📋 Navegando para vagas...');

  // URL direta com busca + Easy Apply - apenas vagas do Brasil
  const params = new URLSearchParams({
    keywords: config.searchKeywords,
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
      '.jobs-box__html-content',
      '.jobs-details__main-content',
      '[data-test-id="job-description"]',
      '.job-details-jobs-unified-top-card',
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

/** Verifica se a vaga é backend + Node/Nest/TS/JS e, se configurado, nível sênior */
function jobMatchesKeywords(description, _legacy) {
  const desc = (description || '').toLowerCase();
  const backendKw = config.backendKeywords || ['backend', 'back-end', 'back end'];
  const techKw = config.techKeywords || ['node', 'nest', 'typescript', 'javascript'];
  const hasBackend = backendKw.some(kw => desc.includes(kw.toLowerCase()));
  const hasTech = techKw.some(kw => desc.includes(kw.toLowerCase()));
  if (!hasTech || !hasBackend) return false;
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
    const maxAttempts = 15;

    while (!applied && attempts < maxAttempts) {
      await runStep(`APPLY_MODAL_STEP_${attempts + 1}`, async () => {
        await fillFormFields(page, jobTitle);
        await shortDelay();
        await scrollModalToBottom(page);
      });

      const modalScope = page.locator('[data-test-modal-id="easy-apply-modal"]').first();

      // Limite diário apareceu no meio do fluxo?
      if (await isDailyLimitReached(page)) {
        const closeLoc = modalScope.locator('button[aria-label="Dismiss"], button[aria-label="Fechar"], button[aria-label="Close"]').first();
        if (await closeLoc.count() > 0) await closeLoc.click({ timeout: 3000, force: true }).catch(() => null);
        return 'daily_limit';
      }

      // Botão "Enviar candidatura" (último passo) - dentro do modal
      const submitLoc = modalScope.locator('button:has-text("Enviar candidatura"), button:has-text("Submit application"), button:has-text("Enviar")').first();
      if (await submitLoc.count() > 0) {
        await runStep('APPLY_CLICK_ENVIAR', async () => {
          await submitLoc.scrollIntoViewIfNeeded().catch(() => null);
          await submitLoc.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
          await submitLoc.click({ timeout: 8000, force: true });
        });
        await randomDelay(2000, 4000);
        applied = true;
        // Aguarda modal de sucesso "Candidatura enviada" aparecer
        await page.waitForSelector('button:has-text("Concluído"), button:has-text("Done")', { timeout: 5000 }).catch(() => null);
        break;
      }

      // Botão "Avançar" (próximo passo) - dentro do modal
      const nextLoc = modalScope.locator('button:has-text("Avançar"), button:has-text("Next"), button:has-text("Revisar")').first();
      if (await nextLoc.count() > 0) {
        await runStep('APPLY_CLICK_AVANCAR', async () => {
          await nextLoc.scrollIntoViewIfNeeded().catch(() => null);
          await nextLoc.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
          await shortDelay();
          await nextLoc.click({ timeout: 8000, force: true });
        });
        await readingDelay();
      } else {
        // Sem Avançar nem Enviar - fecha e pula
        const closeLoc = modalScope.locator('button[aria-label="Dismiss"], button[aria-label="Fechar"], button[aria-label="Close"]').first();
        if (await closeLoc.count() > 0) await closeLoc.click({ timeout: 3000, force: true }).catch(() => null);
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
  console.log('🚀 Iniciando automação LinkedIn Easy Apply');
  console.log(`   Máximo de candidaturas: ${config.maxApplications}`);
  console.log(`   Velocidade: ${config.speed || 'fast'}`);
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
      viewport: VIEWPORT,
      userAgent: useFirefox
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      geolocation: { 
        latitude: config.geoLatitude ?? -23.5505, 
        longitude: config.geoLongitude ?? -46.6333 
      }, // São Paulo
      permissions: ['geolocation'],
    });
  }

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

    const maxToApply = config.maxApplications || 0;
    const hasLimit = maxToApply > 0;
    let scrollRound = 0;
    let noNewCardsCount = 0;
    let dailyLimitReached = false;

    const filtros = (config.seniorOnly ? 'senior + ' : '') + 'backend + Node/Nest/TS/JS';
    console.log(`📌 Processando vagas (${filtros})${hasLimit ? ` — máx ${maxToApply}` : ' — sem limite'}`);
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
          await longDelay();
        } catch (e) {
          if (/not attached|detached/i.test(e?.message || '')) {
            continue; // Card removido do DOM, pula para o próximo
          }
          throw e;
        }

        const description = await getJobDescription(page);
        if (!jobMatchesKeywords(description)) {
          const req = (config.seniorOnly ? 'senior + ' : '') + 'backend + Node/Nest/TS/JS';
          console.log(`   ⏭️ Vaga ignorada (precisa ser ${req})`);
          continue;
        }

        const applied = await applyToJob(page);
        if (applied === 'daily_limit') {
          dailyLimitReached = true;
          console.log('   ⚠️ Limite diário atingido — indo para feed e recrutadores.');
          break;
        }
        if (applied) {
          applicationsCount++;
          console.log(`   ✅ Candidatura ${applicationsCount}${hasLimit ? `/${maxToApply}` : ''} enviada!`);
        }

        await randomDelay(2000, 5000);
      }

      if (stopRequested || dailyLimitReached || (hasLimit && applicationsCount >= maxToApply)) break;
      if (!hadNewCard) {
        noNewCardsCount = (noNewCardsCount || 0) + 1;
        if (noNewCardsCount >= 3) break; // 3 rodadas sem vagas novas = acabou
      } else {
        noNewCardsCount = 0;
      }

      // Rola para carregar mais vagas (LinkedIn usa lazy loading)
      console.log('   📜 Carregando mais vagas...');
      await humanScroll(page, 'down', 800);
      await randomDelay(2000, 4000);
      // Reaplica filtro Easy Apply se foi removido acidentalmente
      if (!page.url().includes('f_AL=true')) {
        const params = new URLSearchParams({ keywords: config.searchKeywords, location: 'Brasil', f_AL: 'true' });
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
    const cooldown = (config.loopCooldownMinutes ?? 5) * 60 * 1000;
    console.log('');
    console.log(`⏸️  Pausa de ${config.loopCooldownMinutes ?? 5} min até o próximo ciclo...`);
    for (let s = 0; s < cooldown && !stopRequested; s += 1000) await new Promise(r => setTimeout(r, 1000));
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
