const Docker = require('dockerode');
const docker = new Docker(); // uses /var/run/docker.sock by default

const MC_PORT_BASE = 25565;
const NODE_PORT_BASE = 3000;

function nextPort(db, type) {
  const row = db.prepare(`SELECT MAX(port) m FROM servers WHERE type = ?`).get(type);
  const base = type === 'mc' ? MC_PORT_BASE : NODE_PORT_BASE;
  return row.m ? row.m + 1 : base;
}

let cachedInfo = null, cachedAt = 0;
async function getSystemInfo() {
  if (cachedInfo && Date.now() - cachedAt < 30000) return cachedInfo;
  const info = await docker.info();
  cachedInfo = {
    cpus: info.NCPU || 1,
    memBytes: info.MemTotal || 2 * 1024 * 1024 * 1024
  };
  cachedAt = Date.now();
  return cachedInfo;
}

// Clamp a requested {cpu, ram} to what the Docker host can actually give out,
// leaving a small headroom so the daemon itself doesn't starve.
async function clampResources(cpu, ram) {
  const sys = await getSystemInfo();
  const maxCpu = Math.max(0.25, sys.cpus - 0.25);
  const maxRamGb = Math.max(0.5, sys.memBytes / (1024 ** 3) - 0.5);
  return {
    cpu: Math.min(Math.max(cpu, 0.25), maxCpu),
    ram: Math.min(Math.max(ram, 0.5), maxRamGb),
    maxCpu, maxRamGb
  };
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


async function createMcContainer(server, allocations = []) {
  const image = 'itzg/minecraft-server:latest';
  await pullIfMissing(image);
  const { cpu, ram } = await clampResources(server.cpu, server.ram);
  const rconPassword = server.rcon_password || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const rconPort = server.rcon_port || (35575 + (server.id % 9000));

  const portBindings = {
    '25565/tcp': [{ HostPort: String(server.port) }],
    '25575/tcp': [{ HostPort: String(rconPort) }]
  };
  const exposed = { '25565/tcp': {}, '25575/tcp': {} };
  allocations.forEach(a => {
    const key = `${a.container_port}/${a.protocol || 'tcp'}`;
    portBindings[key] = [{ HostPort: String(a.host_port) }];
    exposed[key] = {};
  });

  const container = await docker.createContainer({
    Image: image,
    name: `panelfy_${server.id}_${server.name}`,
    Env: [
      'EULA=TRUE',
      `TYPE=${MC_TYPE_MAP[server.software] || 'PAPER'}`,
      `VERSION=${server.version}`,
      `MEMORY=${Math.max(1, Math.floor(ram))}G`,
      'ONLINE_MODE=TRUE',
      'ENABLE_RCON=true',
      `RCON_PASSWORD=${rconPassword}`,
      'RCON_PORT=25575'
    ],
    HostConfig: {
      Memory: Math.floor(ram * 1024 * 1024 * 1024),
      NanoCpus: Math.floor(cpu * 1e9),
      PortBindings: portBindings,
      RestartPolicy: { Name: 'unless-stopped' }
    },
    ExposedPorts: exposed,
    Tty: true,
    OpenStdin: true
  });
  return { containerId: container.id, rconPort, rconPassword };
}

async function createNodeContainer(server, allocations = []) {
  const image = `node:${server.version.replace('LTS', '').trim().replace(/\s/g, '')}-alpine`;
  await pullIfMissing(image);
  const startCmd = server.start_cmd || 'npm start';
  const shellCmd = server.repo
    ? `apk add --no-cache git >/dev/null && git clone ${server.repo} /app && cd /app && npm install && ${startCmd}`
    : `mkdir -p /app && cd /app && echo "console.log('Panelfy Node server ready. Upload/clone your code.')" > index.js && node index.js`;
  const { cpu, ram } = await clampResources(server.cpu, server.ram);

  const portBindings = { [`${server.port}/tcp`]: [{ HostPort: String(server.port) }] };
  const exposed = { [`${server.port}/tcp`]: {} };
  allocations.forEach(a => {
    const key = `${a.container_port}/${a.protocol || 'tcp'}`;
    portBindings[key] = [{ HostPort: String(a.host_port) }];
    exposed[key] = {};
  });

  const container = await docker.createContainer({
    Image: image,
    name: `panelfy_${server.id}_${server.name}`,
    Cmd: ['sh', '-c', shellCmd],
    Env: [`PORT=${server.port}`],
    HostConfig: {
      Memory: Math.floor(ram * 1024 * 1024 * 1024),
      NanoCpus: Math.floor(cpu * 1e9),
      PortBindings: portBindings,
      RestartPolicy: { Name: 'unless-stopped' }
    },
    ExposedPorts: exposed,
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

// Run a shell command inside a container and collect its stdout/stderr (used by the file manager)
async function execInContainer(id, cmd) {
  const container = docker.getContainer(id);
  const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
  return new Promise((resolve, reject) => {
    exec.start({}, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      docker.modem.demuxStream(stream,
        { write: (c) => { out += c.toString('utf8'); } },
        { write: (c) => { out += c.toString('utf8'); } }
      );
      stream.on('end', () => resolve(out));
      stream.on('error', reject);
    });
  });
}

module.exports = {
  docker, nextPort, createMcContainer, createNodeContainer,
  startContainer, stopContainer, removeContainer, streamLogs, sendCommand,
  getSystemInfo, clampResources, execInContainer
};
