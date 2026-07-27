// Real plugin search/install backed by Modrinth's public API (no key needed).
// Installing downloads the primary jar straight into the container's /data/plugins.

// Real plugin search/install backed by Modrinth's public API (no key needed),
// plus SpigotMC search/download via the public Spiget mirror API (api.spiget.org —
// well-established, no auth needed, but only resources the author marked as
// externally downloadable will have a working direct download).

// Modrinth's loader/category facet values don't match our display strings 1:1.
const MODRINTH_LOADER = {
  Paper: 'paper', Spigot: 'spigot', Purpur: 'purpur', Bukkit: 'bukkit',
  Fabric: 'fabric', Forge: 'forge', NeoForge: 'neoforge', Sponge: 'sponge',
  Vanilla: 'paper', // vanilla has no plugin loader; default to paper-compatible results
  'Velocity (Proxy)': 'velocity', 'BungeeCord (Proxy)': 'bungeecord'
};

async function searchPlugins(query, softwareDisplay, offset = 0, limit = 20) {
  const loader = MODRINTH_LOADER[softwareDisplay] || 'paper';
  const facets = [['project_type:plugin'], [`categories:${loader}`]];
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=${limit}&offset=${offset}&index=downloads`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Modrinth search failed: ' + res.status);
  const data = await res.json();
  return {
    total: data.total_hits,
    results: data.hits.map(h => ({
      source: 'modrinth', id: h.project_id, slug: h.slug, title: h.title, description: h.description,
      icon: h.icon_url || '', downloads: h.downloads, author: h.author
    }))
  };
}

async function searchSpiget(query, offset = 0, limit = 20) {
  const q = query && query.trim() ? query.trim() : 'essentials';
  const url = `https://api.spiget.org/v2/search/resources/${encodeURIComponent(q)}?size=${limit}&from=${offset}&fields=name,tag,icon,downloads,rating`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('SpigotMC search failed: ' + res.status);
  const data = await res.json();
  return {
    total: null,
    results: (Array.isArray(data) ? data : []).map(r => ({
      source: 'spigot', id: String(r.id), title: r.name, description: r.tag || '',
      icon: r.icon?.url ? `https://api.spiget.org/v2/resources/${r.id}/icon` : '',
      downloads: r.downloads || 0, author: ''
    }))
  };
}

async function getVersionForServer(projectId, mcVersion, loader, versionId) {
  const url = `https://api.modrinth.com/v2/project/${projectId}/version`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Modrinth version lookup failed: ' + res.status);
  const versions = await res.json();
  const l = (MODRINTH_LOADER[loader] || 'paper');
  let match;
  if (versionId) match = versions.find(v => v.id === versionId);
  if (!match) {
    // prefer an exact game-version + loader match, fall back to the newest version
    match = versions.find(v => v.game_versions.includes(mcVersion) && v.loaders.includes(l))
      || versions.find(v => v.loaders.includes(l))
      || versions[0];
  }
  if (!match) throw new Error('No compatible version found on Modrinth');
  const file = match.files.find(f => f.primary) || match.files[0];
  return { downloadUrl: file.url, filename: file.filename, versionNumber: match.version_number };
}

async function listModrinthVersions(projectId) {
  const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Modrinth version lookup failed: ' + res.status);
  const versions = await res.json();
  return versions.map(v => ({
    id: v.id,
    label: `${v.version_number} — ${v.game_versions.slice(0, 3).join(', ')}${v.game_versions.length > 3 ? '…' : ''} (${v.loaders.join('/')})`
  }));
}

async function listSpigetVersions(resourceId) {
  const res = await fetch(`https://api.spiget.org/v2/resources/${resourceId}/versions?size=50&sort=-releaseDate`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Could not list versions for that SpigotMC resource');
  const versions = await res.json();
  return (Array.isArray(versions) ? versions : []).map(v => ({
    id: String(v.id),
    label: `${v.name || 'v' + v.id}${v.releaseDate ? ' — ' + new Date(v.releaseDate * 1000).toLocaleDateString() : ''}`
  }));
}

async function getSpigetDownload(resourceId, versionId) {
  // Spiget proxies the author's actual file when the resource permits external downloads;
  // premium/paid resources or ones without direct download will 4xx here.
  const infoRes = await fetch(`https://api.spiget.org/v2/resources/${resourceId}`, { signal: AbortSignal.timeout(8000) });
  if (!infoRes.ok) throw new Error('Could not look up that SpigotMC resource');
  const info = await infoRes.json();
  const filename = `${(info.name || 'plugin').replace(/[^a-z0-9._-]/gi, '_')}.jar`;
  const downloadUrl = versionId
    ? `https://api.spiget.org/v2/resources/${resourceId}/versions/${versionId}/download`
    : `https://api.spiget.org/v2/resources/${resourceId}/download`;
  return { downloadUrl, filename };
}

module.exports = { searchPlugins, searchSpiget, getVersionForServer, getSpigetDownload, listModrinthVersions, listSpigetVersions };
