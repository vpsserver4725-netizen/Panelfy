#!/usr/bin/env node
// Usage:
//   npm run createuser
//   npm run createuser -- --username steve --email steve@x.com --password secret123 --admin
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../db.cjs');

function ask(rl, q) { return new Promise(resolve => rl.question(q, resolve)); }

function parseFlags() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username') out.username = args[++i];
    else if (args[i] === '--email') out.email = args[++i];
    else if (args[i] === '--password') out.password = args[++i];
    else if (args[i] === '--admin') out.admin = true;
    else if (args[i] === '--role') out.role = args[++i];
  }
  return out;
}

async function main() {
  const flags = parseFlags();
  let { username, email, password, admin, role } = flags;

  if (!username || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!username) username = await ask(rl, 'Username: ');
    if (!email) email = await ask(rl, 'Email (optional): ');
    if (!password) password = await ask(rl, 'Password: ');
    if (admin === undefined) {
      const a = await ask(rl, 'Grant admin access? (y/N): ');
      admin = /^y/i.test(a);
    }
    rl.close();
  }

  if (!username || !password) {
    console.error('Username and password are required.');
    process.exit(1);
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  const hash = bcrypt.hashSync(password, 10);

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, email = COALESCE(?, email), admin_enabled = ?, role = COALESCE(?, role) WHERE id = ?')
      .run(hash, email || null, admin ? 1 : 0, role || null, existing.id);
    console.log(`Updated existing user "${username}" (id ${existing.id}). Admin: ${!!admin}`);
  } else {
    const info = db.prepare('INSERT INTO users (username,email,password_hash,role,admin_enabled) VALUES (?,?,?,?,?)')
      .run(username, email || '', hash, role || 'user', admin ? 1 : 0);
    console.log(`Created user "${username}" (id ${info.lastInsertRowid}). Admin: ${!!admin}`);
  }
  process.exit(0);
}

main();
