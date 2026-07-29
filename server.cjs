require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const db = require('./db.cjs');
const dock = require('./docker.cjs');
const playit = require('./playit.cjs');
const { getMcVersions } = require('./mcversions.cjs');
const { rconCommand } = require('./rcon.cjs');
const { searchPlugins, searchSpiget, getVersionForServer, getSpigetDownload, listModrinthVersions, listSpigetVersions } = require('./plugins.cjs');

const JWT_SECRET = process.env.JWT_SECRET || 'panelfy-dev-secret-change-me';
const PORT = process.env.PORT || 8080;

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth helpers ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function requireAdmin(req, res, next) {
  if (!req.user.admin_enabled) return res.status(403).json({ error: 'Admin access disabled' });
  next();
}

// ---------- auth routes ----------
// Public — the login screen needs branding before anyone is authenticated
app.get('/api/branding', (req, res) => {
  res.json({
    panel_name: db.getSetting('panel_name', 'Panelfy'),
    panel_logo: db.getSetting('panel_logo', ''),
    login_bg: db.getSetting('login_bg', ''),
    login_bg_blur: db.getSetting('login_bg_blur', '0'),
    cinematic_login: db.getSetting('cinematic_login', '1') === '1',
    user_registration: db.getSetting('user_registration', '0') === '1'
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, admin_enabled: !!user.admin_enabled },
    JWT_SECRET, { expiresIn: '12h' }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, admin_enabled: !!user.admin_enabled } });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.post('/api/auth/register', async (req, res) => {
  if (db.getSetting('user_registration', '0') !== '1') return res.status(403).json({ error: 'Registration is disabled' });
  const { username, email, password } = req.body;
  if (!username || !password || password.length < 6) return res.status(400).json({ error: 'Username and a password (6+ chars) are required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO users (username,email,password_hash,role,admin_enabled) VALUES (?,?,?,?,0)`)
      .run(username, email || '', hash, 'user');
    const token = jwt.sign({ id: info.lastInsertRowid, username, role: 'user', admin_enabled: false }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: info.lastInsertRowid, username, role: 'user', admin_enabled: false } });
  } catch (e) { res.status(400).json({ error: 'Username already taken' }); }
});

// live host capacity, used by the create-server form to cap sliders correctly
app.get('/api/system/info', auth, async (req, res) => {
  try { res.json(await dock.getSystemInfo()); }
  catch (e) { res.status(500).json({ error: 'Could not read Docker host info: ' + e.message }); }
});

app.get('/api/mc-versions', auth, async (req, res) => {
  res.json(await getMcVersions());
});

// ---------- panel-wide settings ----------
app.get('/api/settings', auth, (req, res) => {
  res.json({
    playit_enabled: db.getSetting('playit_enabled', '1') === '1',
    onboarding_enabled: db.getSetting('onboarding_enabled', '1') === '1',
    cinematic_login: db.getSetting('cinematic_login', '1') === '1',
    user_registration: db.getSetting('user_registration', '0') === '1',
    panel_name: db.getSetting('panel_name', 'Panelfy'),
    panel_logo: db.getSetting('panel_logo', ''),
    login_bg: db.getSetting('login_bg', ''),
    login_bg_blur: db.getSetting('login_bg_blur', '0')
  });
});
app.patch('/api/settings', auth, requireAdmin, (req, res) => {
  const b = req.body;
  if ((b.panel_logo && b.panel_logo.length > 6_000_000) || (b.login_bg && b.login_bg.length > 6_000_000)) {
    return res.status(413).json({ error: 'Image is too large — keep it under ~4MB' });
  }
  const boolKeys = ['playit_enabled', 'onboarding_enabled', 'cinematic_login', 'user_registration'];
  const textKeys = ['panel_name', 'panel_logo', 'login_bg', 'login_bg_blur'];
  boolKeys.forEach(k => { if (b[k] !== undefined) db.setSetting(k, b[k] ? '1' : '0'); });
  textKeys.forEach(k => { if (b[k] !== undefined) db.setSetting(k, b[k]); });
  res.json({ ok: true });
});

// ---------- servers ----------
app.get('/api/servers', auth, (req, res) => {
  const rows = req.user.admin_enabled
    ? db.prepare('SELECT * FROM servers').all()
    : db.prepare(`
        SELECT s.* FROM servers s WHERE s.owner_id = ?
        UNION
        SELECT s.* FROM servers s JOIN server_subusers su ON su.server_id = s.id WHERE su.user_id = ?
      `).all(req.user.id, req.user.id);
  res.json(rows);
});

app.post('/api/servers', auth, async (req, res) => {
  let info;
  try {
    const b = req.body;
    const port = dock.nextPort(db, b.type);
    const { cpu, ram, maxCpu, maxRamGb } = await dock.clampResources(b.cpu || 1, b.ram || 2);
    if ((b.cpu || 1) > maxCpu + 0.001 || (b.ram || 2) > maxRamGb + 0.001) {
      // still create it, but let the user know it got scaled down to what the host can give
      req._resourceNote = `Requested ${b.cpu}vCPU/${b.ram}GB exceeds this host's capacity — scaled to ${cpu.toFixed(2)}vCPU/${ram.toFixed(1)}GB.`;
    }
    info = db.prepare(`INSERT INTO servers
      (owner_id,name,type,software,version,repo,start_cmd,cpu,ram,disk,port,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'creating')`).run(
      req.user.id, b.name, b.type, b.software || null, b.version || null,
      b.repo || null, b.start_cmd || null, cpu, ram, b.disk || 10, port
    );
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(info.lastInsertRowid);

    let containerId;
    if (b.type === 'mc') {
      const mc = await dock.createMcContainer(server);
      containerId = mc.containerId;
      db.prepare('UPDATE servers SET rcon_port = ?, rcon_password = ? WHERE id = ?').run(mc.rconPort, mc.rconPassword, server.id);
    } else {
      containerId = await dock.createNodeContainer(server);
    }

    await dock.startContainer(containerId);
    db.prepare('UPDATE servers SET container_id = ?, status = ? WHERE id = ?').run(containerId, 'on', server.id);

    if (b.setupId && b.type === 'mc') {
      const setup = db.prepare('SELECT * FROM setups WHERE id = ?').get(b.setupId);
      const pluginIds = setup ? JSON.parse(setup.plugin_ids || '[]') : [];
      for (const pid of pluginIds) {
        try {
          const { downloadUrl, filename } = await getVersionForServer(pid, server.version, server.software);
          const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
          if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
          const buf = Buffer.from(await fileRes.arrayBuffer());
          await dock.putFileBuffer(containerId, '/data/plugins', filename, buf);
        } catch (e) { console.warn('Setup plugin install failed for', pid, e.message); }
      }
    }

    const created = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    res.json({ ...created, note: req._resourceNote || null });
  } catch (e) {
    console.error(e);
    const msg = e.json?.message || e.message;
    // creation failed after the DB row was made — clean it up so it doesn't linger as a ghost server
    if (info) db.prepare('DELETE FROM servers WHERE id = ?').run(info.lastInsertRowid);
    res.status(500).json({ error: 'Failed to create server: ' + msg });
  }
});

const ALL_PERMS = ['console','files','players','plugins','backups','settings','playit','allocations','subusers'];

function ownedOrAdmin(req, res, id) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!s) { res.status(404).json({ error: 'Not found' }); return null; }
  if (s.owner_id === req.user.id || req.user.admin_enabled) { s._perms = ALL_PERMS; return s; }
  const sub = db.prepare('SELECT * FROM server_subusers WHERE server_id = ? AND user_id = ?').get(id, req.user.id);
  if (sub) { s._perms = JSON.parse(sub.permissions || '[]'); return s; }
  res.status(403).json({ error: 'Forbidden' });
  return null;
}
// Call after ownedOrAdmin — checks the specific permission a subuser needs for an action.
// Owners/admins always pass (their _perms is the full list).
function requirePerm(s, req, res, perm) {
  if (s._perms && s._perms.includes(perm)) return true;
  res.status(403).json({ error: `You don't have "${perm}" permission on this server` });
  return false;
}

app.post('/api/servers/:id/start', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'console')) return;
  try {
    await dock.startContainer(s.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('on', s.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to start: ' + e.message }); }
});

app.post('/api/servers/:id/stop', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'console')) return;
  try {
    await dock.stopContainer(s.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('off', s.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to stop: ' + e.message }); }
});

app.post('/api/servers/:id/restart', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'console')) return;
  try {
    await dock.stopContainer(s.container_id);
    await dock.startContainer(s.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('on', s.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to restart: ' + e.message }); }
});

app.delete('/api/servers/:id', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (s.owner_id !== req.user.id && !req.user.admin_enabled) return res.status(403).json({ error: 'Only the owner or an admin can delete a server' });
  if (s.playit_active) playit.stop(s.id);
  await dock.removeContainer(s.container_id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/command', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'console')) return;
  try {
    await dock.sendCommand(s.container_id, req.body.cmd || '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Command failed: ' + e.message }); }
});

// ---------- playit.gg ----------
// Toggle on: starts (or reconnects) this server's playit agent. First time ever
// for a server it returns a one-time claimUrl to approve; after that it
// reconnects silently using the saved secret and returns the tunnel ip directly.
app.post('/api/servers/:id/playit/toggle', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'playit')) return;
  if (db.getSetting('playit_enabled', '1') !== '1') {
    return res.status(403).json({ error: 'playit.gg tunnels are disabled panel-wide (Settings → admin only)' });
  }
  try {
    if (!s.playit_active) {
      const entry = await playit.start(s.id);
      db.prepare('UPDATE servers SET playit_active = 1, playit_ip = ? WHERE id = ?').run(entry.ip || null, s.id);
      res.json({ active: true, status: entry.status, claimUrl: entry.claimUrl, ip: entry.ip });
    } else {
      playit.stop(s.id);
      db.prepare('UPDATE servers SET playit_active = 0, playit_ip = NULL WHERE id = ?').run(s.id);
      res.json({ active: false });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Frontend polls this while status is 'pending_claim' to pick up the ip once approved
app.get('/api/servers/:id/playit/status', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'playit')) return;
  const entry = playit.status(s.id);
  if (!entry) return res.json({ active: false });
  if (entry.status === 'connected' && entry.ip && s.playit_ip !== entry.ip) {
    db.prepare('UPDATE servers SET playit_ip = ? WHERE id = ?').run(entry.ip, s.id);
  }
  res.json({ active: true, status: entry.status, claimUrl: entry.claimUrl, ip: entry.ip });
});

// Fully unlink the agent (deletes the saved secret - next toggle-on needs a fresh claim)
app.post('/api/servers/:id/playit/forget', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'playit')) return;
  playit.forgetAgent(s.id);
  db.prepare('UPDATE servers SET playit_active = 0, playit_ip = NULL WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// ---------- users (admin only) ----------
// Lightweight, non-admin-gated user list — used for the subuser picker so any
// server owner (not just admins) can grant access without needing admin rights.
app.get('/api/users/basic', auth, (req, res) => {
  res.json(db.prepare('SELECT id, username FROM users').all());
});

app.get('/api/servers/:id/subusers', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'subusers')) return;
  const rows = db.prepare(`
    SELECT su.id, su.user_id, su.permissions, u.username FROM server_subusers su
    JOIN users u ON u.id = su.user_id WHERE su.server_id = ?
  `).all(s.id);
  res.json(rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions || '[]') })));
});

app.post('/api/servers/:id/subusers', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'subusers')) return;
  const { user_id, permissions } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  try {
    db.prepare(`INSERT INTO server_subusers (server_id,user_id,permissions) VALUES (?,?,?)
                ON CONFLICT(server_id,user_id) DO UPDATE SET permissions = excluded.permissions`)
      .run(s.id, user_id, JSON.stringify(permissions || []));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/servers/:id/subusers/:subId', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'subusers')) return;
  db.prepare('DELETE FROM server_subusers WHERE id = ? AND server_id = ?').run(req.params.subId, s.id);
  res.json({ ok: true });
});

app.get('/api/users', auth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,email,role,admin_enabled FROM users').all());
});

app.post('/api/users', auth, requireAdmin, (req, res) => {
  const { username, email, password, admin_enabled } = req.body;
  const hash = bcrypt.hashSync(password || 'changeme123', 10);
  try {
    const info = db.prepare(`INSERT INTO users (username,email,password_hash,role,admin_enabled) VALUES (?,?,?,?,?)`)
      .run(username, email || '', hash, 'user', admin_enabled ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'Username may already exist' }); }
});

app.patch('/api/users/:id', auth, requireAdmin, (req, res) => {
  const { admin_enabled, role } = req.body;
  if (admin_enabled !== undefined) db.prepare('UPDATE users SET admin_enabled = ? WHERE id = ?').run(admin_enabled ? 1 : 0, req.params.id);
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- file manager (runs commands inside the container) ----------
function safePath(p) {
  const clean = (p || '.').replace(/\.\./g, '').replace(/^\/+/, '');
  return clean || '.';
}
const dataDir = (s) => s.type === 'mc' ? '/data' : '/app';

app.get('/api/servers/:id/files', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const p = safePath(req.query.path);
  try {
    const out = await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && ls -lAp --time-style=+%s "${p}" 2>&1`);
    const lines = out.trim().split('\n').filter(l => l && !l.startsWith('total'));
    const entries = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const perms = parts[0], size = parts[4], mtime = parts[5], name = parts.slice(6).join(' ');
      return { name: name.replace(/\/$/, ''), isDir: name.endsWith('/') || perms.startsWith('d'), size: +size || 0, mtime: +mtime || 0 };
    }).filter(e => e.name && e.name !== '.' && e.name !== '..');
    res.json({ path: p, entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Uses a query-string token like the backup download route, since <a download>
// links can't send an Authorization header.
app.get('/api/servers/:id/files/download', async (req, res) => {
  let user;
  try { user = jwt.verify(req.query.token, JWT_SECRET); } catch { return res.status(401).send('Invalid token'); }
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).send('Not found');
  const isOwnerOrAdmin = s.owner_id === user.id || user.admin_enabled;
  const sub = isOwnerOrAdmin ? null : db.prepare('SELECT * FROM server_subusers WHERE server_id = ? AND user_id = ?').get(s.id, user.id);
  const perms = isOwnerOrAdmin ? ALL_PERMS : JSON.parse(sub?.permissions || '[]');
  if (!isOwnerOrAdmin && !sub) return res.status(403).send('Forbidden');
  if (!perms.includes('files')) return res.status(403).send('No files permission');
  const p = safePath(req.query.path);
  try {
    const buf = await dock.execInContainerBinary(s.container_id, `cd ${dataDir(s)} && cat "${p}"`);
    res.setHeader('Content-Disposition', `attachment; filename="${p.split('/').pop()}"`);
    res.send(buf);
  } catch (e) { res.status(500).send('Download failed: ' + e.message); }
});

app.get('/api/servers/:id/files/read', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const p = safePath(req.query.path);
  try {
    const size = await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && wc -c < "${p}" 2>&1`);
    if (parseInt(size) > 2_000_000) return res.status(413).json({ error: 'File too large to edit in-browser (2MB limit)' });
    const content = await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && cat "${p}"`);
    res.json({ path: p, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/:id/files/write', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const p = safePath(req.body.path);
  const b64 = Buffer.from(req.body.content || '', 'utf8').toString('base64');
  try {
    await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && echo '${b64}' | base64 -d > "${p}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// For binary uploads (jars, zips, images) the client sends already-base64 data.
// Uses putFileBuffer (tar + Docker's native putArchive) instead of shelling
// base64 through the command line — that approach silently broke on anything
// beyond a few hundred KB (OS/Docker exec argument-length limits).
app.post('/api/servers/:id/files/upload', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const p = safePath(req.body.path);
  const base64 = (req.body.base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return res.status(400).json({ error: 'No file data received' });
  try {
    const buf = Buffer.from(base64, 'base64');
    await dock.putFileBuffer(s.container_id, dataDir(s), p, buf);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Upload failed: ' + e.message }); }
});

app.post('/api/servers/:id/files/mkdir', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const p = safePath(req.body.path);
  try { await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && mkdir -p "${p}"`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/servers/:id/files', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const p = safePath(req.query.path);
  if (!p || p === '.') return res.status(400).json({ error: 'Refusing to delete root' });
  try { await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && rm -rf "${p}"`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk delete (Pterodactyl-style checkbox multi-select)
app.post('/api/servers/:id/files/bulk-delete', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const paths = (req.body.paths || []).map(safePath).filter(p => p && p !== '.');
  if (!paths.length) return res.status(400).json({ error: 'No paths given' });
  try {
    const cmd = paths.map(p => `rm -rf "${p}"`).join(' && ');
    await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && ${cmd}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/:id/files/rename', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const from = safePath(req.body.from);
  const to = safePath(req.body.to);
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  try { await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && mv "${from}" "${to}"`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Zip selected files/folders into an archive in-place (Pterodactyl "Create Archive")
app.post('/api/servers/:id/files/archive', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  const paths = (req.body.paths || []).map(safePath).filter(p => p && p !== '.');
  if (!paths.length) return res.status(400).json({ error: 'No paths given' });
  const archiveName = `archive-${Date.now()}.zip`;
  try {
    const quoted = paths.map(p => `"${p}"`).join(' ');
    await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && (which zip >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq zip) || (apk add --no-cache zip)) ; zip -r -q "${archiveName}" ${quoted}`);
    res.json({ ok: true, archiveName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- player manager (RCON, Minecraft servers only) ----------
app.get('/api/servers/:id/players', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'players')) return;
  if (s.type !== 'mc') return res.status(400).json({ error: 'Not a Minecraft server' });
  if (s.status !== 'on') return res.json({ online: [], raw: 'Server is offline' });
  try {
    const raw = await rconCommand('127.0.0.1', s.rcon_port, s.rcon_password, 'list');
    const match = raw.match(/:\s*(.*)$/);
    const online = match && match[1].trim() ? match[1].split(',').map(n => n.trim()).filter(Boolean) : [];
    res.json({ online, raw });
  } catch (e) { res.status(500).json({ error: 'RCON error: ' + e.message }); }
});

app.post('/api/servers/:id/players/action', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'players')) return;
  if (s.type !== 'mc') return res.status(400).json({ error: 'Not a Minecraft server' });
  const { action, player } = req.body;
  const cmds = {
    kick: `kick ${player}`, ban: `ban ${player}`, pardon: `pardon ${player}`,
    op: `op ${player}`, deop: `deop ${player}`,
    whitelist_add: `whitelist add ${player}`, whitelist_remove: `whitelist remove ${player}`
  };
  if (!cmds[action]) return res.status(400).json({ error: 'Unknown action' });
  try {
    const raw = await rconCommand('127.0.0.1', s.rcon_port, s.rcon_password, cmds[action]);
    res.json({ ok: true, raw });
  } catch (e) { res.status(500).json({ error: 'RCON error: ' + e.message }); }
});

// ---------- plugin installer (Modrinth + SpigotMC via Spiget) ----------
app.get('/api/servers/:id/plugins/search', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'plugins')) return;
  const source = req.query.source || 'modrinth';
  const offset = +req.query.offset || 0;
  try {
    if (source === 'spigot') return res.json(await searchSpiget(req.query.q, offset));
    if (source === 'bbyb') return res.json({ total: 0, results: [], note: 'BuildByBit has no public search API — use the button below to search their site directly and upload the jar via File Manager.' });
    if (source === 'nullforms') return res.json({ total: 0, results: [], note: 'Nullforms has no public search API — use the button below to search their site directly and upload the jar via File Manager.' });
    res.json(await searchPlugins(req.query.q, s.software, offset));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/servers/:id/plugins/:source/:projectId/versions', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'plugins')) return;
  try {
    const versions = req.params.source === 'spigot'
      ? await listSpigetVersions(req.params.projectId)
      : await listModrinthVersions(req.params.projectId);
    res.json(versions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/:id/plugins/install', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'plugins')) return;
  if (s.type !== 'mc') return res.status(400).json({ error: 'Not a Minecraft server' });
  if (s.status !== 'on') return res.status(400).json({ error: 'Start the server first — plugins install into the running container.' });
  try {
    const { downloadUrl, filename } = req.body.source === 'spigot'
      ? await getSpigetDownload(req.body.projectId, req.body.versionId)
      : await getVersionForServer(req.body.projectId, s.version, s.software, req.body.versionId);

    // Fetch the jar on the panel host (reliable, full internet access) rather than
    // relying on wget existing inside the container image, then write it via the
    // same tar/putArchive path as regular uploads — no shell/exec size limits.
    const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!fileRes.ok) throw new Error(`Download failed (HTTP ${fileRes.status})`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    await dock.putFileBuffer(s.container_id, '/data/plugins', filename, buf);

    res.json({ ok: true, filename, note: 'Installed — restart the server to load it.' });
  } catch (e) { res.status(500).json({ error: 'Install failed: ' + e.message }); }
});

app.get('/api/servers/:id/stats', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'console')) return;
  if (s.status !== 'on') return res.json({ cpuPct: 0, memMB: 0, running: false });
  try {
    const stats = await dock.docker.getContainer(s.container_id).stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cores = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || [1]).length;
    const cpuPct = sysDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
    const memMB = (stats.memory_stats.usage || 0) / (1024 * 1024);
    res.json({ cpuPct: +cpuPct.toFixed(1), memMB: Math.round(memMB), running: true });
  } catch (e) { res.json({ cpuPct: 0, memMB: 0, running: false, error: e.message }); }
});

// ---------- network allocations (extra ports beyond the primary game port) ----------
app.get('/api/servers/:id/allocations', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'allocations')) return;
  res.json(db.prepare('SELECT * FROM server_allocations WHERE server_id = ?').all(s.id));
});
app.post('/api/servers/:id/allocations', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'allocations')) return;
  const containerPort = +req.body.container_port;
  if (!containerPort) return res.status(400).json({ error: 'container_port is required' });
  const maxHostPort = db.prepare('SELECT MAX(host_port) m FROM server_allocations').get().m;
  const hostPort = Math.max(maxHostPort ? maxHostPort + 1 : 40000, 40000);
  const info = db.prepare('INSERT INTO server_allocations (server_id,container_port,host_port,protocol,note) VALUES (?,?,?,?,?)')
    .run(s.id, containerPort, hostPort, req.body.protocol || 'tcp', req.body.note || '');
  res.json({ id: info.lastInsertRowid, server_id: s.id, container_port: containerPort, host_port: hostPort, protocol: req.body.protocol || 'tcp', note: req.body.note || '', note2: 'Restart or reconfigure the server for this to take effect.' });
});
app.delete('/api/servers/:id/allocations/:allocId', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'allocations')) return;
  db.prepare('DELETE FROM server_allocations WHERE id = ? AND server_id = ?').run(req.params.allocId, s.id);
  res.json({ ok: true });
});

// ---------- version / software changer + simple field updates ----------
// Recreates the container with new software/version/resources/allocations; data
// volume-less setups mean the world/app files live in the old container until
// first boot of the new one re-pulls, so this is intended for pre-launch or
// fresh reconfiguration. ip_alias/owner_id are cosmetic/DB-only and don't recreate.
app.patch('/api/servers/:id', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'settings')) return;
  const { software, version, cpu, ram, ip_alias, owner_id } = req.body;

  if (ip_alias !== undefined) db.prepare('UPDATE servers SET ip_alias = ? WHERE id = ?').run(ip_alias, s.id);
  if (owner_id !== undefined) {
    if (!req.user.admin_enabled) return res.status(403).json({ error: 'Only admins can transfer server ownership' });
    db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(owner_id, s.id);
  }

  const needsRecreate = software !== undefined || version !== undefined || cpu !== undefined || ram !== undefined;
  if (!needsRecreate) return res.json(db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id));

  if (s.status === 'on') return res.status(400).json({ error: 'Stop the server before changing software/version/resources' });

  try {
    await dock.removeContainer(s.container_id);
    const updated = {
      ...s,
      software: software || s.software, version: version || s.version,
      cpu: cpu || s.cpu, ram: ram || s.ram
    };
    const allocations = db.prepare('SELECT * FROM server_allocations WHERE server_id = ?').all(s.id);
    let containerId;
    if (s.type === 'mc') {
      const mc = await dock.createMcContainer(updated, allocations);
      containerId = mc.containerId;
      db.prepare('UPDATE servers SET rcon_port = ?, rcon_password = ? WHERE id = ?').run(mc.rconPort, mc.rconPassword, s.id);
    } else {
      containerId = await dock.createNodeContainer(updated, allocations);
    }
    await dock.startContainer(containerId);
    db.prepare('UPDATE servers SET software=?, version=?, cpu=?, ram=?, container_id=?, status=? WHERE id=?')
      .run(updated.software, updated.version, updated.cpu, updated.ram, containerId, 'on', s.id);
    res.json(db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id));
  } catch (e) { res.status(500).json({ error: 'Failed to reconfigure: ' + (e.json?.message || e.message) }); }
});


// ---------- backups (real docker tar archive of the data dir, not a shell tar hack) ----------
const fs = require('fs');
const BACKUPS_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

app.get('/api/servers/:id/backups', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'backups')) return;
  res.json(db.prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC').all(s.id));
});

app.post('/api/servers/:id/backups', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'backups')) return;
  try {
    const filename = `backup-${s.id}-${Date.now()}.tar`;
    const dest = path.join(BACKUPS_DIR, filename);
    await dock.backupToFile(s.container_id, dataDir(s), dest);
    const size = fs.statSync(dest).size;
    const info = db.prepare('INSERT INTO backups (server_id,filename,size) VALUES (?,?,?)').run(s.id, filename, size);
    res.json({ id: info.lastInsertRowid, server_id: s.id, filename, size });
  } catch (e) { res.status(500).json({ error: 'Backup failed: ' + e.message }); }
});

app.get('/api/servers/:id/backups/:backupId/download', (req, res) => {
  // uses a query-string token since <a download> links can't send an Authorization header
  let user;
  try { user = jwt.verify(req.query.token, JWT_SECRET); } catch { return res.status(401).send('Invalid token'); }
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!s || (s.owner_id !== user.id && !user.admin_enabled)) return res.status(403).send('Forbidden');
  const b = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.backupId, s.id);
  if (!b) return res.status(404).send('Not found');
  res.download(path.join(BACKUPS_DIR, b.filename), b.filename);
});

app.post('/api/servers/:id/backups/:backupId/restore', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'backups')) return;
  const b = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.backupId, s.id);
  if (!b) return res.status(404).json({ error: 'Backup not found' });
  try {
    await dock.restoreFromFile(s.container_id, dataDir(s), path.join(BACKUPS_DIR, b.filename));
    res.json({ ok: true, note: 'Restored — restart the server to pick up the restored files.' });
  } catch (e) { res.status(500).json({ error: 'Restore failed: ' + e.message }); }
});

app.delete('/api/servers/:id/backups/:backupId', auth, (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'backups')) return;
  const b = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.backupId, s.id);
  if (b) { try { fs.unlinkSync(path.join(BACKUPS_DIR, b.filename)); } catch (_) {} }
  db.prepare('DELETE FROM backups WHERE id = ? AND server_id = ?').run(req.params.backupId, s.id);
  res.json({ ok: true });
});

// Import: upload a .tar (optionally gzip-compressed, Docker accepts both) and extract
// it straight into the server's data directory via the same native archive API.
app.post('/api/servers/:id/backups/import', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'backups')) return;
  const base64 = (req.body.base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return res.status(400).json({ error: 'No file data received' });
  try {
    const buf = Buffer.from(base64, 'base64');
    const isZip = buf[0] === 0x50 && buf[1] === 0x4B; // 'PK' magic bytes
    if (isZip) {
      const filename = `import-${Date.now()}.zip`;
      await dock.putFileBuffer(s.container_id, dataDir(s), filename, buf);
      await dock.execInContainer(s.container_id, `cd ${dataDir(s)} && (which unzip >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq unzip) || (apk add --no-cache unzip)) ; unzip -o -q "${filename}" && rm -f "${filename}"`);
    } else {
      const tmp = path.join(BACKUPS_DIR, `import-${s.id}-${Date.now()}.tar`);
      fs.writeFileSync(tmp, buf);
      await dock.restoreFromFile(s.container_id, dataDir(s), tmp);
      fs.unlinkSync(tmp);
    }
    res.json({ ok: true, note: 'Imported — restart the server to pick up the imported files.' });
  } catch (e) { res.status(500).json({ error: 'Import failed: ' + e.message }); }
});

// ---------- world installer ----------
// Uploads a zip/tar of a world folder and extracts it as a named world directory.
app.post('/api/servers/:id/world/install', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  if (s.type !== 'mc') return res.status(400).json({ error: 'Not a Minecraft server' });
  const worldName = (req.body.worldName || 'world').replace(/[^a-zA-Z0-9_-]/g, '_');
  const base64 = (req.body.base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return res.status(400).json({ error: 'No file data received' });
  try {
    const buf = Buffer.from(base64, 'base64');
    const isZip = buf[0] === 0x50 && buf[1] === 0x4B;
    await dock.execInContainer(s.container_id, `mkdir -p /data/${worldName}`);
    if (isZip) {
      const filename = `world-import-${Date.now()}.zip`;
      await dock.putFileBuffer(s.container_id, '/data', filename, buf);
      await dock.execInContainer(s.container_id, `cd /data && (which unzip >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq unzip) || (apk add --no-cache unzip)) ; unzip -o -q "${filename}" -d "${worldName}" && rm -f "${filename}"`);
    } else {
      const tmp = path.join(BACKUPS_DIR, `world-import-${s.id}-${Date.now()}.tar`);
      fs.writeFileSync(tmp, buf);
      await dock.restoreFromFile(s.container_id, `/data/${worldName}`, tmp);
      fs.unlinkSync(tmp);
    }
    res.json({ ok: true, note: `Installed as world "${worldName}". Set level-name=${worldName} in server.properties (Files tab), then restart.` });
  } catch (e) { res.status(500).json({ error: 'World install failed: ' + e.message }); }
});

// ---------- datapack installer ----------
app.post('/api/servers/:id/datapack/install', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (!requirePerm(s, req, res, 'files')) return;
  if (s.type !== 'mc') return res.status(400).json({ error: 'Not a Minecraft server' });
  const worldName = (req.body.worldName || 'world').replace(/[^a-zA-Z0-9_-]/g, '_');
  const packName = (req.body.packName || 'datapack').replace(/[^a-zA-Z0-9_-]/g, '_');
  const base64 = (req.body.base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return res.status(400).json({ error: 'No file data received' });
  try {
    const buf = Buffer.from(base64, 'base64');
    const targetDir = `/data/${worldName}/datapacks/${packName}`;
    await dock.execInContainer(s.container_id, `mkdir -p "${targetDir}"`);
    const isZip = buf[0] === 0x50 && buf[1] === 0x4B;
    if (isZip) {
      const filename = `dp-import-${Date.now()}.zip`;
      await dock.putFileBuffer(s.container_id, `/data/${worldName}/datapacks`, filename, buf);
      await dock.execInContainer(s.container_id, `cd "/data/${worldName}/datapacks" && (which unzip >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq unzip) || (apk add --no-cache unzip)) ; unzip -o -q "${filename}" -d "${packName}" && rm -f "${filename}"`);
    } else {
      const tmp = path.join(BACKUPS_DIR, `dp-import-${s.id}-${Date.now()}.tar`);
      fs.writeFileSync(tmp, buf);
      await dock.restoreFromFile(s.container_id, targetDir, tmp);
      fs.unlinkSync(tmp);
    }
    res.json({ ok: true, note: `Datapack installed into ${worldName}/datapacks/${packName}. Run "reload" in console or restart.` });
  } catch (e) { res.status(500).json({ error: 'Datapack install failed: ' + e.message }); }
});

// ---------- server setups (reusable creation templates) ----------
app.get('/api/setups', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM setups ORDER BY created_at DESC').all().map(r => ({ ...r, plugin_ids: JSON.parse(r.plugin_ids || '[]') })));
});
app.post('/api/setups', auth, requireAdmin, (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO setups (name,type,software,version,cpu,ram,disk,plugin_ids,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(b.name, b.type, b.software || null, b.version || null, b.cpu || 1, b.ram || 2, b.disk || 10, JSON.stringify(b.plugin_ids || []), req.user.id);
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/setups/:id', auth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM setups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});


const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wssPlayit = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws/console') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/ws/playit') {
    wssPlayit.handleUpgrade(req, socket, head, (ws) => wssPlayit.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const id = url.searchParams.get('id');
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return ws.close(); }
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!s || (s.owner_id !== user.id && !user.admin_enabled)) return ws.close();

  dock.streamLogs(s.container_id, ws);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'cmd') dock.sendCommand(s.container_id, msg.data);
    } catch {}
  });
});

wssPlayit.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const id = url.searchParams.get('id');
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return ws.close(); }
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!s || (s.owner_id !== user.id && !user.admin_enabled)) return ws.close();

  const entry = playit.status(s.id);
  if (entry) entry.logs.forEach(line => ws.send(JSON.stringify({ type: 'log', data: line + '\n' })));
  const unsubscribe = playit.subscribe(s.id, (line) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'log', data: line + '\n' }));
  });
  ws.on('close', unsubscribe);
});

server.listen(PORT, () => console.log(`Panelfy running on http://0.0.0.0:${PORT}`));
