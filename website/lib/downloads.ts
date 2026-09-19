export const REPOSITORY_URL = 'https://github.com/Mehdidjah/Concat-app';
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

const LATEST_RELEASE_ASSET_URL = `${RELEASES_URL}/latest/download`;

export const DOWNLOAD_ASSETS = {
  macos: `${LATEST_RELEASE_ASSET_URL}/Concat-macOS.dmg`,
  windows: `${LATEST_RELEASE_ASSET_URL}/Concat-Windows-Setup.exe`,
  linux: `${LATEST_RELEASE_ASSET_URL}/Concat-Linux-x86_64.AppImage`,
} as const;

export type DownloadPlatform = keyof typeof DOWNLOAD_ASSETS;

export const AUTO_DOWNLOAD_URL = '/api/download';

export function isDownloadPlatform(
  value: string | null,
): value is DownloadPlatform {
  return value === 'macos' || value === 'windows' || value === 'linux';
}

export function detectDownloadPlatform(
  userAgent: string,
): DownloadPlatform | null {
  const normalized = userAgent.toLowerCase();

  if (/android|iphone|ipad|ipod/.test(normalized)) return null;
  if (/windows|win64|win32/.test(normalized)) return 'windows';
  if (/macintosh|mac os x/.test(normalized)) return 'macos';
  if (/linux|x11/.test(normalized)) return 'linux';

  return null;
}
