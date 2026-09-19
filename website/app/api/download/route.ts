import {
  DOWNLOAD_ASSETS,
  detectDownloadPlatform,
  isDownloadPlatform,
} from '@/lib/downloads';

function redirect(location: string) {
  return new Response(null, {
    status: 307,
    headers: {
      'Cache-Control': 'private, no-store',
      Location: location,
      Vary: 'User-Agent',
    },
  });
}

export function GET(request: Request) {
  const url = new URL(request.url);
  const requestedPlatform = url.searchParams.get('platform');
  const platform = isDownloadPlatform(requestedPlatform)
    ? requestedPlatform
    : detectDownloadPlatform(request.headers.get('user-agent') ?? '');

  if (!platform) return redirect(new URL('/#download', url).toString());

  return redirect(DOWNLOAD_ASSETS[platform]);
}
