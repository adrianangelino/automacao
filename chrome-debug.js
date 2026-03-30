#!/usr/bin/env node
/**
 * Abre o Chrome do Windows com depuração remota (CDP).
 * Chrome 111+ exige --remote-allow-origins=* para conexões (Playwright / WSL).
 *
 * Se não abrir nada: no Windows, encerre todos os "Google Chrome" no Gerenciador de tarefas e rode de novo.
 * Opcional: CHROME_DEBUG_USER_DATA=C:\temp\chrome-cdp-profile (perfil separado; sessão nova)
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

const port = String(process.env.CHROME_DEBUG_PORT || 9222);
const isWSL = process.platform === 'linux' && existsSync('/mnt/c/Windows');

function cdpArgs() {
  const a = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
  const ud = process.env.CHROME_DEBUG_USER_DATA;
  if (ud) a.push(`--user-data-dir=${ud}`);
  return a;
}

function winChromePathsWin32() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
}

function winChromePathsWsl() {
  return [
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
}

function wslToWinBackslashes(wslPath) {
  const m = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!m) return wslPath;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

function pickChrome() {
  const list = process.platform === 'win32' ? winChromePathsWin32() : winChromePathsWsl();
  return list.find((p) => existsSync(p)) || null;
}

function runDetached(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    console.error('Erro ao iniciar:', err.message);
    process.exitCode = 1;
  });
  child.unref();
}

function main() {
  const args = cdpArgs();
  const chrome = pickChrome();

  if (!chrome) {
    console.error('❌ chrome.exe não encontrado. Instale o Google Chrome no Windows.');
    console.error('   Caminhos testados:', (process.platform === 'win32' ? winChromePathsWin32() : winChromePathsWsl()).join(' | '));
    process.exit(1);
  }

  console.log('Abrindo Chrome com CDP (porta ' + port + ')...');
  console.log('   ', chrome);

  if (process.platform === 'win32') {
    runDetached(chrome, args);
    console.log('');
    console.log('✅ Comando enviado. A janela deve abrir no Windows.');
    console.log('   Se não abrir: Ctrl+Shift+Esc → finalize todos os "Google Chrome" → rode npm run chrome de novo.');
    return;
  }

  if (isWSL) {
    runDetached(chrome, args);
    console.log('');
    console.log('✅ Comando enviado para o Windows (a partir do WSL).');
    console.log('   Se não aparecer janela: abra o Gerenciador de tarefas NO WINDOWS, encerre Chrome, rode de novo.');
    console.log('   Teste: npm run chrome:ping   depois: npm start');
    return;
  }

  console.error('Use este script no Windows ou no WSL (com Chrome instalado no Windows).');
  process.exit(1);
}

main();
