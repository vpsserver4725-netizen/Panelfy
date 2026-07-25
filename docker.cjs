const Docker = require('dockerode');
const docker = new Docker(); // uses /var/run/docker.sock by default

const MC_PORT_BASE = 25565;
const NODE_PORT_BASE = 3000;

function nextPort(db, type) {
  const row = db.prepare(`SELECT MAX(port) m FROM servers WHERE type = ?`).get(type);
  const base = type === 'mc' ? MC_PORT_BASE : NODE_PORT_BASE;
  return row.m ? row.m + 1 : base;
}

// software name -> itzg/minecraft-server TYPE env value
const MC_TYPE_MAP = {
  Paper: 'PAPER', Spigot: 'SPIGOT', Purpur: 'PURPUR', Fabric: 'FABRIC',
  Forge: 'FORGE', NeoForge: 'NEOFORGE', Vanilla: 'VANILLA',
  'Velocity (Proxy)': 'VELOCITY', 'BungeeCord (Proxy)': 'BUNGEECORD',
  Bukkit: 'BUKKIT', Sponge: 'SPONGEVANILLA'
};

async function pullIfMissing(image) {
  try { await docker.getImage(image).inspect(); return; } catch (_) {}
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

async function createMcContainer(server) {
  const image = 'itzg/minecraft-server:latest';
  await pullIfMissing(image);
  const container = await docker.createContainer({
    Image: image,
    name: `panelfy_${server.id}_${server.name}`,
    Env: [
      'EULA=TRUE',
      `TYPE=${MC_TYPE_MAP[server.software] || 'PAPER'}`,
      `VERSION=${server.version}`,
      `MEMORY=${server.ram}G`,
      'ONLINE_MODE=TRUE'
    ],
    HostConfig: {
      Memory: server.ram * 1024 * 1024 * 1024,
      NanoCpus: server.cpu * 1e9,
      PortBindings: { '25565/tcp': [{ HostPort: String(server.port) }] },
      RestartPolicy: { Name: 'unless-stopped' }
    },
    ExposedPorts: { '25565/tcp': {} },
    Tty: true,
    OpenStdin: true
  });
  return container.id;
}

async function createNodeContainer(server) {
  const image = `node:${server.version.replace('LTS', '').trim().replace(/\s/g, '')}-alpine`;
  await pullIfMissing(image);
  const startCmd = server.start_cmd || 'npm start';
  const shellCmd = server.repo
    ? `apk add --no-cache git >/dev/null && git clone ${server.repo} /app && cd /app && npm install && ${startCmd}`
    : `mkdir -p /app && cd /app && echo "console.log('Panelfy Node server ready. Upload/clone your code.')" > index.js && node index.js`;
  const container = await docker.createContainer({
    Image: image,
    name: `panelfy_${server.id}_${server.name}`,
    Cmd: ['sh', '-c', shellCmd],
    Env: [`PORT=${server.port}`],
    HostConfig: {
      Memory: server.ram * 1024 * 1024 * 1024,
      NanoCpus: server.cpu * 1e9,
      PortBindings: { [`${server.port}/tcp`]: [{ HostPort: String(server.port) }] },
      RestartPolicy: { Name: 'unless-stopped' }
    },
    ExposedPorts: { [`${server.port}/tcp`]: {} },
    Tty: true,
    OpenStdin: true
  });
  return container.id;
}

async function startContainer(id) { await docker.getContainer(id).start(); }
async function stopContainer(id) { try { await docker.getContainer(id).stop(); } catch (_) {} }
async function removeContainer(id) { try { await docker.getContainer(id).remove({ force: true }); } catch (_) {} }

// Stream logs to a websocket client
function streamLogs(id, ws) {
  docker.getContainer(id).logs({ follow: true, stdout: true, stderr: true, tail: 100 }, (err, stream) => {
    if (err || !stream) return;
    stream.on('data', (chunk) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'log', data: chunk.toString('utf8') }));
    });
    ws.on('close', () => stream.destroy());
  });
}

// Send a console command into the container's stdin (works for Tty+OpenStdin containers)
async function sendCommand(id, cmd) {
  const container = docker.getContainer(id);
  const stream = await container.attach({ stream: true, stdin: true, hijack: true });
  stream.write(cmd + '\n');
  stream.end();
}

module.exports = {
  docker, nextPort, createMcContainer, createNodeContainer,
  startContainer, stopContainer, removeContainer, streamLogs, sendCommand
};
