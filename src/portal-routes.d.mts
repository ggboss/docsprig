export function portalRedirect(pathname: string, search?: string, hash?: string): string | undefined;
export function legacyDetailTarget(
  location: { pathname: string; search: string; hash: string },
  items: Iterable<{ id: string; detailRoutes?: string[] }>,
): string;
