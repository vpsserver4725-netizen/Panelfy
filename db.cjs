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
