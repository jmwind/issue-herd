// Update check: compare the installed version with package.json on the repo's main branch.

export const LATEST_URL = 'https://raw.githubusercontent.com/jmwind/weawr/main/package.json';

/** Numeric semver compare on "x.y.z" (pre-release tags ignored). Returns <0, 0, >0. */
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/**
 * Resolve to the latest published version string if it is newer than `current`, else null.
 * Never throws and never takes longer than `timeoutMs`; offline just means null.
 */
export async function newerVersion(current, { url = LATEST_URL, timeoutMs = 4000, fetchImpl = fetch } = {}) {
  if (process.env.WEAWR_NO_UPDATE_CHECK) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    const { version } = await res.json();
    return version && compareVersions(version, current) > 0 ? version : null;
  } catch { return null; }
}
