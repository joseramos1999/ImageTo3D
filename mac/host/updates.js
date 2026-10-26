// New-version notice from GitHub Releases. The app is not signed with an Apple Developer ID,
// so it cannot replace itself: the notice ("manual") offers the release page, where the user
// downloads the .dmg for their Mac and drags the app over the old one.
const { app, net } = require('electron');

const REPO_RELEASES = 'https://github.com/joseramos1999/ImageTo3D/releases/';
const LATEST_API = 'https://api.github.com/repos/joseramos1999/ImageTo3D/releases/latest';

const parse = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
const newer = (a, b) => {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/** The latest release if it is newer than this app and has a build for this Mac, else null. */
async function checkForUpdate() {
  const res = await net.fetch(LATEST_API, { headers: { 'User-Agent': `ImageTo3D-mac/${app.getVersion()}`, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  const r = await res.json();
  if (r.draft || r.prerelease || !newer(r.tag_name, app.getVersion())) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const asset = (r.assets || []).find(a => /^ImageTo3D-.*-mac-/.test(a.name) && a.name.includes(`-mac-${arch}.`) && a.name.endsWith('.dmg'));
  if (!asset) return null;   // the Windows build is out, the Mac one not yet
  return {
    version: String(r.tag_name).replace(/^v/i, ''), current: app.getVersion(), notes: r.body || '',
    page: String(r.html_url || ''), size: asset.size, manual: true,
  };
}

const isReleasePage = url => typeof url === 'string' && url.startsWith(REPO_RELEASES);

module.exports = { checkForUpdate, isReleasePage, newer };
