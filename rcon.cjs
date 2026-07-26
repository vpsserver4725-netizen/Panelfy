const net = require('net');

// Minimal Source RCON client (used by Minecraft's built-in RCON). One-shot
// connect -> auth -> command -> disconnect per call; fine for admin actions
// like kick/ban/op/list which aren't high-frequency.

function buildPacket(id, type, body) {
  const bodyBuf = Buffer.from(body + '\0\0', 'utf8');
  const size = 4 + 4 + bodyBuf.length;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

function rconCommand(host, port, password, command, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(buildPacket(1, 3, password)); // SERVERDATA_AUTH
    });
    socket.setTimeout(timeoutMs);
    let stage = 'auth';
    let buffer = Buffer.alloc(0);
    let resultText = '';

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < 4 + size) break;
        const packet = buffer.subarray(0, 4 + size);
        buffer = buffer.subarray(4 + size);
        const id = packet.readInt32LE(4);
        const type = packet.readInt32LE(8);

        if (stage === 'auth') {
          if (id === -1) { socket.destroy(); return reject(new Error('RCON authentication failed')); }
          stage = 'cmd';
          socket.write(buildPacket(2, 2, command)); // SERVERDATA_EXECCOMMAND
        } else if (stage === 'cmd' && type === 0) {
          resultText += packet.subarray(12, packet.length - 2).toString('utf8');
        }
      }
    });
    socket.on('timeout', () => { socket.destroy(); resolve(resultText || ''); });
    socket.on('error', reject);
    socket.on('close', () => resolve(resultText));
  });
}

module.exports = { rconCommand };
