import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublished } from '../src/published-request.mjs';

test('published GET retries transient gateway errors once and releases the response', async () => {
  for (const status of [502, 503, 504]) {
    let calls = 0, cancelled = false;
    const result = await fetchPublished('/content/tree.json', {}, async (_url, options) => {
      assert.equal(options.method, 'GET');
      return ++calls === 1 ? { status, body: { cancel: async () => { cancelled = true; } } } : { status: 200 };
    });
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
    assert.equal(cancelled, true);
  }
});

test('network failure is retried once but persistent failure terminates', async () => {
  let calls = 0;
  await assert.rejects(fetchPublished('/content/tree.json', {}, async () => {
    calls++; throw new TypeError('Failed to fetch');
  }), TypeError);
  assert.equal(calls, 2);
});

test('unpublished, authorization and invalid-content responses are not retried', async () => {
  for (const status of [200, 401, 403, 404, 422, 500]) {
    let calls = 0;
    assert.equal((await fetchPublished('/content/tree.json', {}, async () => {
      calls++; return { status };
    })).status, status);
    assert.equal(calls, 1);
  }
});

test('persistent service failure stops at two requests', async () => {
  let calls = 0;
  assert.equal((await fetchPublished('/content/tree.json', {}, async () => {
    calls++; return { status: 503 };
  })).status, 503);
  assert.equal(calls, 2);
});

test('navigation abort never starts or retries an obsolete request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchPublished('/content/tree.json', { signal: controller.signal }, async () => {
    calls++; controller.abort(); throw new TypeError('Failed to fetch');
  }));
  assert.equal(calls, 1);
  await assert.rejects(fetchPublished('/content/tree.json', { signal: controller.signal }, async () => { calls++; }));
  assert.equal(calls, 1);
});
