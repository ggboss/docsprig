import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {ensureRandomUUID} from '../src/browser-crypto.mjs';

test('LAN crypto compatibility produces UUID v4 using getRandomValues', () => {
  let calls = 0;
  const crypto = { getRandomValues(bytes) { calls++; return webcrypto.getRandomValues(bytes); } };
  ensureRandomUUID(crypto);
  const ids = Array.from({length:100}, () => crypto.randomUUID());
  assert.equal(calls, 100);
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('keeps native UUID and never falls back to insecure randomness', () => {
  const native = () => 'native'; const crypto = {randomUUID:native};
  ensureRandomUUID(crypto); assert.equal(crypto.randomUUID,native);
  const unavailable = {}; ensureRandomUUID(unavailable); assert.equal(unavailable.randomUUID,undefined);
  ensureRandomUUID(null);
});
