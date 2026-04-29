export interface MarketplaceVersionRowLite {
  version: string;
  published_at: string | null;
  yanked: boolean;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function nearestPatchFromRows(
  versions: MarketplaceVersionRowLite[],
  version: string,
): MarketplaceVersionRowLite | null {
  const current = parseSemver(version);
  if (!current) return null;
  return versions
    .filter((candidate) => !candidate.yanked)
    .filter((candidate) => {
      const parsed = parseSemver(candidate.version);
      return parsed?.major === current.major && parsed.minor === current.minor;
    })
    .sort((a, b) => compareSemver(b.version, a.version))[0] ?? null;
}

export function latestPatchFromRows(
  versions: MarketplaceVersionRowLite[],
  version: string,
): MarketplaceVersionRowLite | null {
  const current = parseSemver(version);
  if (!current) return null;
  return versions
    .filter((candidate) => !candidate.yanked)
    .filter((candidate) => {
      const parsed = parseSemver(candidate.version);
      return (
        parsed?.major === current.major &&
        parsed.minor === current.minor &&
        parsed.patch > current.patch
      );
    })
    .sort((a, b) => compareSemver(b.version, a.version))[0] ?? null;
}

export function parseSemver(version: string): Semver | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(a: string, b: string): number {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  if (!aa || !bb) return a.localeCompare(b);
  return aa.major - bb.major || aa.minor - bb.minor || aa.patch - bb.patch;
}
