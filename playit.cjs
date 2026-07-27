const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Each Minecraft server gets its own playit agent, identified by a persisted
// secret file. First run for a server: playit has no secret yet, so it prints
// a one-time claim URL - the account owner clicks it once to approve. From then
// on the secret is saved to disk and every future start/restart reconnects
// automatically with zero manual steps.

const SECRETS_DIR = path.join(__dirname, 'playit-secrets');
if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });

const state = new Map(); // serverId -> { proc, status, claimUrl, ip, logs: [], emitter }
const MAX_LOG_LINES = 500;

function secretPath(serverId) { return path.join(SECRETS_DIR, `server-${serverId}.toml`); }

function pushLog(entry, line) {
  entry.logs.push(line);
  if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
  entry.emitter.emit('log', line);
}

function start(serverId) {
  return new Promise((resolve, reject) => {
    const existing = state.get(serverId);
    if (existing && existing.proc && !existing.proc.killed) return resolve(existing);
    if (existing) state.delete(serverId); // stale/dead entry, restart clean

    const args = ['--secret_path', secretPath(serverId)];
    let proc;
    try {
      proc = spawn('playit', args, { env: process.env });
    } catch (err) {
      return reject(new Error('Could not start the playit binary: ' + err.message));
    }
    const entry = { proc, status: 'connecting', claimUrl: null, ip: null, logs: [], emitter: new EventEmitter() };
    state.set(serverId, entry);

    let settled = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      text.split('\n').forEach(line => { if (line.trim()) pushLog(entry, line); });

      const claimMatch = text.match(/https:\/\/playit\.gg\/claim\/[A-Za-z0-9-]+/);
      if (claimMatch && !entry.ip) {
        entry.status = 'pending_claim';
        entry.claimUrl = claimMatch[0];
        if (!settled) { settled = true; resolve(entry); }
      }

      // once approved+connected, playit prints the assigned tunnel address
      const ipMatch = text.match(/([a-z0-9-]+\.(joinmc\.link|playit\.gg|ply\.gg))(:\d+)?/i);
      if (ipMatch) {
        entry.status = 'connected';
        entry.ip = ipMatch[0];
        entry.claimUrl = null;
        if (!settled) { settled = true; resolve(entry); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      pushLog(entry, `[panelfy] playit process exited (code ${code})`);
      entry.status = 'stopped';
      state.delete(serverId);
    });
    proc.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? 'The "playit" CLI is not installed or not on PATH on this host — install it first (see docs), then try again.'
        : 'playit process error: ' + err.message;
      pushLog(entry, '[panelfy] ' + msg);
      entry.status = 'error';
      if (!settled) { settled = true; reject(new Error(msg)); }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        pushLog(entry, '[panelfy] still waiting on playit after 15s — check the console below for details.');
        resolve(entry);
      }
    }, 15000);
  });
}

function status(serverId) { return state.get(serverId) || null; }

function subscribe(serverId, onLine) {
  const entry = state.get(serverId);
  if (!entry) return () => {};
  entry.emitter.on('log', onLine);
  return () => entry.emitter.off('log', onLine);
}

function stop(serverId) {
  const entry = state.get(serverId);
  if (entry) { entry.proc.kill(); state.delete(serverId); }
  // secret file is intentionally kept so the agent reconnects instantly next time
}

function forgetAgent(serverId) {
  stop(serverId);
  const p = secretPath(serverId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = { start, stop, status, forgetAgent, subscribe };
