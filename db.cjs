const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'panelfy.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  admin_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'mc' | 'node'
  software TEXT,             -- paper/spigot/fabric/... for mc
  version TEXT,              -- mc version or node version
  repo TEXT,                 -- git repo for node servers
  start_cmd TEXT,            -- npm start override
  cpu REAL DEFAULT 1,
  ram REAL DEFAULT 2,
  disk INTEGER DEFAULT 10,
  port INTEGER,
  container_id TEXT,
  status TEXT DEFAULT 'off',
  playit_active INTEGER DEFAULT 0,
  playit_ip TEXT,
  rcon_port INTEGER,
  rcon_password TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
// default: playit tunnels enabled panel-wide
if (getSetting('playit_enabled', null) === null) setSetting('playit_enabled', '1');
if (getSetting('onboarding_enabled', null) === null) setSetting('onboarding_enabled', '1');
if (getSetting('cinematic_login', null) === null) setSetting('cinematic_login', '1');
if (getSetting('user_registration', null) === null) setSetting('user_registration', '0');
if (getSetting('panel_name', null) === null) setSetting('panel_name', 'Panelfy');
if (getSetting('panel_logo', null) === null) setSetting('panel_logo', '');
if (getSetting('login_bg', null) === null) setSetting('login_bg', '');
if (getSetting('login_bg_blur', null) === null) setSetting('login_bg_blur', '0');

// migrate: add any columns that were introduced after a user's db was first created
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
ensureColumn('servers', 'rcon_port', 'INTEGER');
ensureColumn('servers', 'rcon_password', 'TEXT');
ensureColumn('servers', 'playit_ip', 'TEXT');
ensureColumn('servers', 'playit_active', 'INTEGER DEFAULT 0');
ensureColumn('servers', 'ip_alias', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS server_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  container_port INTEGER NOT NULL,
  host_port INTEGER NOT NULL,
  protocol TEXT DEFAULT 'tcp',
  note TEXT
);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  software TEXT,
  version TEXT,
  cpu REAL DEFAULT 1,
  ram REAL DEFAULT 2,
  disk INTEGER DEFAULT 10,
  plugin_ids TEXT DEFAULT '[]',
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS server_subusers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permissions TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(server_id, user_id)
);
`);

// seed default owner/admin if no users exist
const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (count === 0) {
  const hash = bcrypt.hashSync('changeme123', 10);
  db.prepare(`INSERT INTO users (username,email,password_hash,role,admin_enabled) VALUES (?,?,?,?,1)`)
    .run('admin', 'admin@panelfy.local', hash, 'owner');
  console.log('>> Seeded default login: admin / changeme123  (CHANGE THIS PASSWORD)');
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
