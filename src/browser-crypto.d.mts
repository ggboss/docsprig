export function ensureRandomUUID(crypto?: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>): void;
