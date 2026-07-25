const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Each Minecraft server gets its own playit agent, identified by a persisted
// secret file. First run for a server: playit has no secret yet, so it prints
// a one-time claim URL - the account owner clicks it once to approve. From then
// on the secret is saved to disk and every future start/restart reconnects
// automatically with zero manual steps.

const SECRETS_DIR = path.join(__dirname, 'playit-secrets');
if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });

const state = new Map(); // serverId -> { proc, status: 'pending_claim'|'connected', claimUrl, ip }

function secretPath(serverId) { return path.join(SECRETS_DIR, `server-${serverId}.toml`); }

function start(serverId) {
  return new Promise((resolve, reject) => {
    if (state.has(serverId)) return resolve(state.get(serverId));

    const args = ['--secret_path', secretPath(serverId)];
    const proc = spawn('playit', args, { env: process.env });
    const entry = { proc, status: 'connecting', claimUrl: null, ip: null };
    state.set(serverId, entry);

    let settled = false;
    const onData = (chunk) => {
      const text = chunk.toString();

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
    proc.on('exit', () => state.delete(serverId));
    proc.on('error', (err) => { if (!settled) { settled = true; reject(err); } });

    setTimeout(() => { if (!settled) { settled = true; resolve(entry); } }, 15000);
  });
}

function status(serverId) { return state.get(serverId) || null; }

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

module.exports = { start, stop, status, forgetAgent };
