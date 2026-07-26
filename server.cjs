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

const JWT_SECRET = process.env.JWT_SECRET || 'panelfy-dev-secret-change-me';
const PORT = process.env.PORT || 8080;

const app = express();
app.use(cors());
app.use(express.json());
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

// live host capacity, used by the create-server form to cap sliders correctly
app.get('/api/system/info', auth, async (req, res) => {
  try { res.json(await dock.getSystemInfo()); }
  catch (e) { res.status(500).json({ error: 'Could not read Docker host info: ' + e.message }); }
});

app.get('/api/mc-versions', auth, async (req, res) => {
  res.json(await getMcVersions());
});

// ---------- servers ----------
app.get('/api/servers', auth, (req, res) => {
  const rows = req.user.admin_enabled
    ? db.prepare('SELECT * FROM servers').all()
    : db.prepare('SELECT * FROM servers WHERE owner_id = ?').all(req.user.id);
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

    const containerId = b.type === 'mc'
      ? await dock.createMcContainer(server)
      : await dock.createNodeContainer(server);

    await dock.startContainer(containerId);
    db.prepare('UPDATE servers SET container_id = ?, status = ? WHERE id = ?').run(containerId, 'on', server.id);
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

function ownedOrAdmin(req, res, id) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!s) { res.status(404).json({ error: 'Not found' }); return null; }
  if (s.owner_id !== req.user.id && !req.user.admin_enabled) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return s;
}

app.post('/api/servers/:id/start', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  await dock.startContainer(s.container_id);
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('on', s.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/stop', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  await dock.stopContainer(s.container_id);
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('off', s.id);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  if (s.playit_active) playit.stop(s.id);
  await dock.removeContainer(s.container_id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/command', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
  await dock.sendCommand(s.container_id, req.body.cmd || '');
  res.json({ ok: true });
});

// ---------- playit.gg ----------
// Toggle on: starts (or reconnects) this server's playit agent. First time ever
// for a server it returns a one-time claimUrl to approve; after that it
// reconnects silently using the saved secret and returns the tunnel ip directly.
app.post('/api/servers/:id/playit/toggle', auth, async (req, res) => {
  const s = ownedOrAdmin(req, res, req.params.id); if (!s) return;
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
  playit.forgetAgent(s.id);
  db.prepare('UPDATE servers SET playit_active = 0, playit_ip = NULL WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// ---------- users (admin only) ----------
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

// ---------- server + websocket console ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/console' });

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

server.listen(PORT, () => console.log(`Panelfy running on http://0.0.0.0:${PORT}`));
