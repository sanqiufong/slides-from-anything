const DEEP_LINK_DEFAULT_BASE_URL = 'http://127.0.0.1:3217';

export function buildVaultDeepLinkUrl(baseUrl: string | null, currentUrl: string): string {
  const origin = (baseUrl && baseUrl.trim()) || DEEP_LINK_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL('/', origin);
  } catch {
    url = new URL('/', DEEP_LINK_DEFAULT_BASE_URL);
  }
  url.searchParams.set('source', 'open-ppt');
  url.searchParams.set('intent', 'create');
  url.searchParams.set('return_to', currentUrl);
  return url.toString();
}
