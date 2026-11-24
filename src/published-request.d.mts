export function fetchPublished(
  url: string,
  options: Omit<RequestInit, 'method'>,
  request?: typeof fetch,
): Promise<Response>;
