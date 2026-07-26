// Real plugin search/install backed by Modrinth's public API (no key needed).
// Installing downloads the primary jar straight into the container's /data/plugins.

async function searchPlugins(query, loader) {
  const facets = encodeURIComponent(JSON.stringify([
    ['project_type:plugin'],
    [`categories:${loader || 'paper'}`]
  ]));
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${facets}&limit=20`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Modrinth search failed: ' + res.status);
  const data = await res.json();
  return data.hits.map(h => ({
    id: h.project_id, slug: h.slug, title: h.title, description: h.description,
    icon: h.icon_url, downloads: h.downloads, author: h.author
  }));
}

async function getVersionForServer(projectId, mcVersion, loader) {
  const url = `https://api.modrinth.com/v2/project/${projectId}/version`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Modrinth version lookup failed: ' + res.status);
  const versions = await res.json();
  // prefer an exact game-version + loader match, fall back to the newest version
  const match = versions.find(v => v.game_versions.includes(mcVersion) && v.loaders.includes((loader || 'paper').toLowerCase()))
    || versions.find(v => v.loaders.includes((loader || 'paper').toLowerCase()))
    || versions[0];
  if (!match) throw new Error('No compatible version found on Modrinth');
  const file = match.files.find(f => f.primary) || match.files[0];
  return { downloadUrl: file.url, filename: file.filename, versionNumber: match.version_number };
}

module.exports = { searchPlugins, getVersionForServer };
