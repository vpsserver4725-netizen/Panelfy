# Panelfy

Real, working Minecraft + Node.js hosting panel. Node/Express backend, Docker
(`dockerode`) spins up actual containers per server, SQLite stores users/servers,
JWT auth, WebSocket live console, playit.gg tunnels for Minecraft servers.

Default login after first boot: **admin / changeme123** — change it immediately
(Settings not built yet, so update it directly in `panelfy.db` or via the Users
admin panel by creating a new admin user, then delete the default one).

## Requirements
- Docker installed and running on the host (Docker-in-Docker works too — GitHub
  Codespaces and most Codesandbox VPS templates have Docker pre-installed).
- Node.js 18+.

## 1. Clone to your VPS / Codespace / Codesandbox

```bash
git clone <your-repo-url> panelfy
cd panelfy
npm install
cp .env.example .env
# edit .env — set JWT_SECRET, and PLAYIT_SECRET if you'll use playit.gg
```

## 2. Run

```bash
npm start
```

You'll see:
```
Panelfy running on http://0.0.0.0:8080
```

## 3. Forward the port

**GitHub Codespaces:** open the "Ports" tab, find port `8080`, right-click →
"Port Visibility" → Public. Codespaces gives you a URL like
`https://<codespace>-8080.app.github.dev` — that's your panel link.

**Codesandbox:** the running port shows up automatically under the "Ports"
panel in the sidebar; click it to open/copy the public URL.

**Own VPS:** either open port 8080 in your firewall (`ufw allow 8080`) and hit
`http://<vps-ip>:8080`, or put Nginx/Caddy in front for a domain + HTTPS.

## playit.gg tunnels

1. Install the playit CLI on the host (`curl` install from playit.gg/download)
   so the `playit` binary is on `$PATH`.
2. Claim an agent at https://playit.gg/account/agents, copy its secret key
   into `.env` as `PLAYIT_SECRET`.
3. In Panelfy → playit.gg Tunnels tab, toggle a server on — Panelfy starts the
   agent and reads back the assigned public address.

## What's real vs. what to extend

Working now: auth + roles, Docker container create/start/stop/delete for
Minecraft (`itzg/minecraft-server` image, all software types, versions
1.8.9 → latest via `VERSION` env) and Node.js (any version via `node:<ver>-alpine`,
optional git repo clone + `npm install` + start command), live log streaming
and command input over WebSocket, admin user management, playit.gg toggle.

Not built yet, worth adding: file manager / SFTP, resource usage graphs (wire
up `docker stats`), password reset / settings page, backups, per-user resource
quota enforcement (currently DB stores cpu/ram/disk but doesn't hard-limit
total-across-servers vs. real VPS capacity — add a check in
`POST /api/servers` against `docker info` before creating).
