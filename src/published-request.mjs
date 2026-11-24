// Only public GET requests may be retried. Never replay administrator writes.
export async function fetchPublished(url, options, request = fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal?.throwIfAborted();
    let response;
    try {
      response = await request(url, { ...options, method: 'GET' });
    } catch (error) {
      if (attempt === 0 && !options.signal?.aborted && error instanceof TypeError) continue;
      throw error;
    }
    if (attempt === 0 && [502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      continue;
    }
    return response;
  }
}
