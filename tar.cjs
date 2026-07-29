// Minimal single/multi-file USTAR tar builder. Used so file uploads and plugin/world/
// datapack installs go through Docker's native putArchive() instead of embedding
// base64 file content inside a shell command string — the latter breaks (or silently
// truncates) on anything beyond a few hundred KB because it hits OS/Docker exec
// argument-length limits. A tar stream has no such ceiling.

function pad(str, len) {
  return Buffer.concat([Buffer.from(str, 'utf8'), Buffer.alloc(Math.max(0, len - Buffer.byteLength(str, 'utf8')))]).subarray(0, len);
}
function octal(num, len) {
  return pad(num.toString(8).padStart(len - 1, '0'), len);
}

function fileHeader(name, size) {
  const buf = Buffer.alloc(512);
  pad(name, 100).copy(buf, 0);
  octal(0o644, 8).copy(buf, 100);   // mode
  octal(0, 8).copy(buf, 108);       // uid
  octal(0, 8).copy(buf, 116);       // gid
  octal(size, 12).copy(buf, 124);   // size
  octal(Math.floor(Date.now() / 1000), 12).copy(buf, 136); // mtime
  buf.write('        ', 148);       // checksum placeholder (8 spaces)
  buf.write('0', 156);              // typeflag: normal file
  buf.write('ustar', 257);
  buf.write('00', 263);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  octal(sum, 8).copy(buf, 148);
  buf[148 + 7] = 0x20; // trailing space per spec
  return buf;
}

/** entries: [{ name: 'relative/path.txt', data: Buffer }] */
function buildTar(entries) {
  const parts = [];
  for (const { name, data } of entries) {
    parts.push(fileHeader(name, data.length));
    parts.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) parts.push(Buffer.alloc(512 - remainder));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return Buffer.concat(parts);
}

module.exports = { buildTar };
