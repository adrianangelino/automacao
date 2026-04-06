/**
 * Utilitários para simular comportamento humano
 */

let speedMultiplier = 0.3; // fast por padrão

export function setSpeed(speed) {
  if (speed === 'fast') speedMultiplier = 0.25;
  else if (speed === 'slow') speedMultiplier = 1.2;
  else if (speed === 'human') speedMultiplier = 1.35;
  else speedMultiplier = 0.5; // normal
}

/**
 * Delay aleatório entre min e max (em ms)
 */
export function randomDelay(min = 1000, max = 3000) {
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  const delay = Math.max(50, Math.floor(base * speedMultiplier));
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Delay curto para micro-pausas (digitação, cliques)
 */
export function shortDelay() {
  return randomDelay(100, 300);
}

/**
 * Delay médio - "lendo" algo na tela
 */
export function readingDelay() {
  return randomDelay(400, 800);
}

/**
 * Delay longo - "pensando" ou navegando
 */
export function longDelay() {
  return randomDelay(800, 1500);
}

/**
 * Move o mouse em curva suave até o elemento (simula humano)
 */
export async function humanMouseMove(page, selector) {
  const element = await page.$(selector);
  if (!element) return false;

  const box = await element.boundingBox();
  if (!box) return false;

  // Ponto de destino com pequena variação (não clicar exatamente no centro)
  const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 20;
  const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 20;

  // Movimento em etapas (curva de Bézier simulada)
  const steps = 5 + Math.floor(Math.random() * 5);
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // Easing suave
    const eased = progress < 0.5 
      ? 2 * progress * progress 
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    
    await page.mouse.move(
      box.x + (targetX - box.x) * eased + (Math.random() - 0.5) * 5,
      box.y + (targetY - box.y) * eased + (Math.random() - 0.5) * 5,
      { steps: 2 }
    );
    await randomDelay(30, 80);
  }

  await page.mouse.move(targetX, targetY, { steps: 1 });
  await shortDelay();
  return true;
}

/**
 * Scroll suave e gradual
 */
export async function humanScroll(page, direction = 'down', amount = 300) {
  const scrollAmount = amount + (Math.random() - 0.5) * 100;
  const steps = 3 + Math.floor(Math.random() * 3);
  const stepSize = (direction === 'down' ? scrollAmount : -scrollAmount) / steps;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepSize);
    await randomDelay(100, 300);
  }
}

/**
 * Digita texto como humano (com variação de velocidade)
 */
export async function humanType(page, selector, text) {
  await page.click(selector);
  await shortDelay();

  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    if (Math.random() < 0.1) await randomDelay(100, 400); // Pausa ocasional
  }
}
