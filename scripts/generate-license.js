#!/usr/bin/env node
'use strict';
// Usage: node scripts/generate-license.js
// Interactive CLI — generates an AES-256-CBC encrypted NocVault license key.

const { createCipheriv, createHash, randomBytes } = require('crypto');
const readline = require('readline');

const LICENSE_SECRET = 'NocVault-License-Secret-2026-X9K'; // must match lib/license.ts
const ALL_MODULES = ['netvault', 'logvault', 'ddivault', 'spanvault'];

function encrypt(payload) {
  const iv = randomBytes(16);
  const secretKey = createHash('sha256').update(LICENSE_SECRET).digest();
  const cipher = createCipheriv('aes-256-cbc', secretKey, iv);
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const combined = `${iv.toString('hex')}:${encrypted}`;
  return Buffer.from(combined).toString('base64');
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n═══════════════════════════════════════════════');
  console.log('  NocVault License Key Generator');
  console.log('═══════════════════════════════════════════════\n');

  // --- Server ID ---
  const serverId = await ask(rl, "Server ID (from customer's Settings → License): ");
  if (!serverId.startsWith('NCV-') || serverId.length < 10) {
    console.error('\nError: Invalid Server ID — must start with NCV-');
    rl.close(); process.exit(1);
  }

  // --- Customer name ---
  const customer = await ask(rl, 'Customer name: ');
  if (!customer) { console.error('\nError: Customer name required'); rl.close(); process.exit(1); }

  // --- Expiry ---
  const expiryInput = await ask(rl, 'Expiry date (YYYY-MM-DD, e.g. 2027-06-01): ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryInput)) {
    console.error('\nError: Invalid date format — use YYYY-MM-DD');
    rl.close(); process.exit(1);
  }
  if (new Date(expiryInput) <= new Date()) {
    console.error('\nError: Expiry date must be in the future');
    rl.close(); process.exit(1);
  }

  // --- Modules ---
  const modulesInput = await ask(rl, `Modules (comma-separated or "all") [${ALL_MODULES.join(', ')}]: `);
  const modules = modulesInput.toLowerCase() === 'all'
    ? ALL_MODULES
    : modulesInput.split(',').map(m => m.trim().toLowerCase()).filter(m => ALL_MODULES.includes(m));
  if (modules.length === 0) {
    console.error('\nError: At least one valid module required');
    rl.close(); process.exit(1);
  }

  // --- Max devices ---
  const maxDevicesInput = await ask(rl, 'Max devices (0 for unlimited): ');
  const maxDevices = Math.max(0, parseInt(maxDevicesInput, 10) || 0);

  rl.close();

  const payload = {
    customer,
    serverId,
    expiry: expiryInput,
    modules,
    maxDevices,
    issuedAt: new Date().toISOString().split('T')[0],
  };

  const licenseKey = encrypt(payload);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  License Key Generated Successfully');
  console.log('═══════════════════════════════════════════════');
  console.log('\n  Customer  :', customer);
  console.log('  Server ID :', serverId);
  console.log('  Expiry    :', expiryInput);
  console.log('  Modules   :', modules.join(', '));
  console.log('  Max devices:', maxDevices === 0 ? 'Unlimited' : maxDevices);
  console.log('  Issued    :', payload.issuedAt);
  console.log('\n─── LICENSE KEY (copy and send to customer) ────\n');
  console.log(licenseKey);
  console.log('\n────────────────────────────────────────────────\n');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
