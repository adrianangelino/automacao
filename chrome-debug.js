#!/usr/bin/env node
/**
 * Abre o Chrome com depuração remota (porta 9222).
 * Funciona no Windows e no WSL.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const port = process.env.CHROME_DEBUG_PORT || 9222;
const isWSL = process.platform === 'linux' && existsSync('/mnt/c/Windows');

const chromePath = isWSL
  ? '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const args = ['--remote-debugging-port=' + port];

console.log('Abrindo Chrome com depuração remota (porta ' + port + ')...');
const proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
proc.unref();
console.log('Chrome iniciado. Rode "npm start" para conectar.');
