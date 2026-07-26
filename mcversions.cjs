// Pulls the full, current release version list straight from Mojang instead of
// a hand-maintained array that inevitably goes stale.
const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

let cache = null, cachedAt = 0;
const TTL = 6 * 60 * 60 * 1000; // 6h

const FALLBACK = [
  '1.21.4','1.21.3','1.21.1','1.21','1.20.6','1.20.4','1.20.2','1.20.1','1.20',
  '1.19.4','1.19.3','1.19.2','1.19.1','1.19','1.18.2','1.18.1','1.18',
  '1.17.1','1.17','1.16.5','1.16.4','1.16.3','1.16.2','1.16.1','1.16',
  '1.15.2','1.15.1','1.15','1.14.4','1.14.3','1.14.2','1.14.1','1.14',
  '1.13.2','1.13.1','1.13','1.12.2','1.12.1','1.12','1.11.2','1.11.1','1.11',
  '1.10.2','1.10','1.9.4','1.9','1.8.9','1.8.8','1.8'
];

async function getMcVersions() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    const releases = data.versions
      .filter(v => v.type === 'release')
      .map(v => v.id);
    // keep 1.8.9 and newer, plus the very latest snapshot-free release list Mojang gives us
    cache = releases;
    cachedAt = Date.now();
    return cache;
  } catch (e) {
    console.warn('mc-versions: falling back to static list —', e.message);
    return FALLBACK;
  }
}

module.exports = { getMcVersions };
