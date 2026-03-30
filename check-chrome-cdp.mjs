#!/usr/bin/env node
/**
 * Diagnóstico: o Chrome no Windows está ouvindo na 9222 para o WSL alcançar?
 * Rode no WSL (ou no Windows): npm run chrome:ping
 * Antes: no Windows, abra o Chrome com --remote-debugging-port=9222 (npm run chrome / chrome-debug.cmd).
 */
import { readFileSync } from 'fs';
import http from 'http';

const port = Number(process.env.CHROME_DEBUG_PORT || 9222);

function get(url, ms = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(ms, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function nameserversFromResolv() {
  const out = [];
  try {
    const r = readFileSync('/etc/resolv.conf', 'utf8');
    for (const m of r.matchAll(/^nameserver\s+(\S+)/gm)) out.push(m[1]);
  } catch {}
  return out;
}

async function main() {
  const hosts = [];
  if (process.platform === 'win32') {
    hosts.push('127.0.0.1', 'localhost');
  } else {
    hosts.push(...nameserversFromResolv());
    hosts.push('127.0.0.1', 'localhost');
  }
  const uniq = [...new Set(hosts.filter(Boolean))];

  console.log(`Porta ${port}. Testando hosts: ${uniq.join(', ')}\n`);

  for (const h of uniq) {
    const url = `http://${h}:${port}/json/version`;
    process.stdout.write(`  ${url} → `);
    try {
      const data = await get(url);
      console.log('OK\n');
      const preview = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      console.log(preview.slice(0, 600));
      console.log('\n✅ CDP acessível. Rode o bot de novo (npm start).');
      return;
    } catch (e) {
      console.log(`falhou (${e.message})`);
    }
  }

  console.log('\n❌ Nenhum host respondeu na porta ' + port + '.');
  if (process.platform !== 'win32') {
    console.log('');
    console.log('No Windows (fora do WSL):');
    console.log('  1) Feche todas as janelas do Chrome.');
    console.log('  2) Abra: chrome com --remote-debugging-port=' + port + ' --remote-allow-origins=* (npm run chrome)');
    console.log('     ou dê duplo clique em chrome-debug.cmd');
    console.log('');
    console.log('Se ainda falhar no WSL, no PowerShell Admin:');
    console.log('  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=' + port + ' connectaddress=127.0.0.1 connectport=' + port);
    console.log('  New-NetFirewallRule -DisplayName "Chrome DevTools" -Direction Inbound -Protocol TCP -LocalPort ' + port + ' -Action Allow');
  } else {
    console.log('Abra o Chrome com --remote-debugging-port=' + port + ' e rode npm run chrome:ping de novo.');
  }
  process.exit(1);
}

main();
