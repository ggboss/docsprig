import assert from 'node:assert/strict';

// Invoked by the authenticated, disposable Chrome smoke before logout.
// All mutations below use the real UI; API reads verify durable state.
export async function runOrganizationRegression({ page, origin, nonce, tab, workspace, createNode, selectTab, ready }) {
  assert.equal(process.env.SMOKE_DISPOSABLE, 'yes', 'Organization regression requires a disposable demo');
  assert.equal(origin, `http://127.0.0.1:${process.env.SMOKE_PORT}`);
  const wb = page.getByRole('region', { name: '文档管理工作区' });
  const nav = wb.getByRole('navigation', { name: '工作区目录' });
  const tabs = page.getByRole('tablist', { name: '管理栏目' });
  const button = (scope, name) => scope.getByRole('button', { name, exact: true });
  const row = id => nav.locator(`.wb-row[data-node-id="${id}"]`);
  const sorted = (nodes, parentId) => nodes.filter(n => n.parentId === parentId)
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placements = (state, ids) => state.nodes.filter(n => ids.includes(n.id))
    .map(({ id, parentId, sort }) => ({ id, parentId, sort }));
  async function change(action, method, endpoint) {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === method && r.url() === origin + endpoint),
      action(),
    ]);
    assert.equal(response.status(), 200, `${method} ${endpoint}: ${response.status()}`);
    return { state: await response.json(), request: response.request().postDataJSON() };
  }
  async function drag(source, target, position, expected) {
    await row(target).scrollIntoViewIfNeeded();
    const box = await row(target).boundingBox();
    assert.ok(box, 'Drop target must be visible');
    const result = await change(() => row(source).dragTo(row(target), {
      sourcePosition: { x: 8, y: box.height / 2 },
      targetPosition: { x: box.width / 2, y: position === 'before' ? 2 : box.height / 2 },
    }), 'POST', '/manage/node/move');
    const { revision, ...move } = result.request;
    assert.ok(Number.isSafeInteger(revision));
    assert.deepEqual(move, { id: source, ...expected }, 'Real drag must send the intended destination');
    await wb.getByRole('status').filter({ hasText: '目录位置已保存为草稿' }).waitFor();
    return result.state;
  }
  async function reloadPlacement(state, ids, parentId, expectedOrder) {
    const expected = placements(state, ids);
    await page.reload(); await ready();
    await selectTab(tab.title);
    const persisted = await workspace();
    assert.deepEqual(placements(persisted, ids), expected, 'Parent and sort must survive reload');
    assert.deepEqual(sorted(persisted.nodes, parentId).map(n => n.id), expectedOrder);
    for (const id of expectedOrder) await row(id).waitFor();
    const rendered = await nav.locator('.wb-row').evaluateAll((rows, ids) => rows
      .map(row => row.getAttribute('data-node-id')).filter(id => ids.includes(id)), expectedOrder);
    assert.deepEqual(rendered, expectedOrder, 'Reloaded UI order must match saved sibling order');
  }
  async function confirmDelete(name, accept) {
    const dialogPromise = page.waitForEvent('dialog');
    const click = button(page, `删除栏目「${name}」`).click();
    const dialog = await dialogPromise;
    const expected = dialog.type() === 'confirm' && dialog.message().includes(`删除栏目「${name}」`);
    await (expected && accept ? dialog.accept() : dialog.dismiss());
    await click;
    assert.ok(expected, 'Deleting a tab must ask for confirmation');
  }

  const parent = await createNode(tab.title, tab.title, 'group', `Drag parent ${nonce}`);
  const first = await createNode(tab.title, parent.title, 'markdown', `Drag first ${nonce}`, `First body ${nonce}`);
  const second = await createNode(tab.title, parent.title, 'markdown', `Drag second ${nonce}`, `Second body ${nonce}`);
  const empty = await createNode(tab.title, parent.title, 'group', `Empty destination ${nonce}`);
  const ids = [parent.id, first.id, second.id, empty.id];
  const before = await workspace();
  assert.deepEqual(sorted(before.nodes, parent.id).map(n => n.id), [first.id, second.id, empty.id]);
  assert.equal(sorted(before.nodes, empty.id).length, 0, 'Move target starts empty');

  const reordered = await drag(second.id, first.id, 'before', { parentId: parent.id, beforeId: first.id });
  assert.deepEqual(reordered.published, before.published, 'Reordering drafts must not publish');
  await reloadPlacement(reordered, ids, parent.id, [second.id, first.id, empty.id]);

  const moved = await drag(first.id, empty.id, 'inside', { parentId: empty.id, beforeId: null });
  assert.deepEqual(moved.published, before.published, 'Moving drafts must not publish');
  assert.equal(moved.nodes.find(n => n.id === first.id).body, first.body);
  assert.equal(moved.nodes.find(n => n.id === first.id).publishedVersion, null);
  await reloadPlacement(moved, ids, parent.id, [second.id, empty.id]);
  assert.deepEqual(sorted((await workspace()).nodes, empty.id).map(n => n.id), [first.id]);
  await row(first.id).waitFor();
  assert.equal(await row(empty.id).locator('..').locator(`.wb-row[data-node-id="${first.id}"]`).count(), 1,
    'Moved document renders below the formerly empty group');

  const emptyTab = `Delete empty tab ${nonce}`;
  await button(page, '新增栏目').click();
  const form = page.getByRole('form', { name: '新增栏目' });
  await form.getByLabel('栏目名称').fill(emptyTab);
  const added = await change(() => button(form, '保存栏目').click(), 'PUT', '/manage/tabs');
  await form.waitFor({ state: 'hidden' });
  const target = added.state.nodes.find(n => n.parentId === null && n.title === emptyTab);
  assert.ok(target);
  assert.equal(target.publishedVersion, null);
  await tabs.getByRole('tab', { name: emptyTab, exact: true }).click();
  await tabs.getByRole('tab', { name: emptyTab, exact: true, selected: true }).waitFor();
  const beforeDelete = await workspace();
  const requests = [];
  const recordDelete = request => {
    if (request.method() === 'DELETE' && request.url() === origin + '/manage/tabs') requests.push(request);
  };
  page.on('request', recordDelete);
  try {
    await confirmDelete(emptyTab, false);
    assert.deepEqual(await workspace(), beforeDelete, 'Cancel must preserve the tab and all workspace state');
    assert.equal(requests.length, 0, 'Cancel must not submit a deletion');
    await tabs.getByRole('tab', { name: emptyTab, exact: true, selected: true }).waitFor();

    const deleted = await change(() => confirmDelete(emptyTab, true), 'DELETE', '/manage/tabs');
    assert.equal(requests.length, 1);
    assert.deepEqual(deleted.request, { revision: beforeDelete.revision, id: target.id });
    assert.equal(deleted.state.revision, beforeDelete.revision + 1);
    assert.deepEqual(deleted.state.nodes, beforeDelete.nodes.filter(n => n.id !== target.id),
      'Confirm deletes only the empty tab, preserving every other tab and document');
    assert.deepEqual(deleted.state.published, beforeDelete.published);
    await tabs.getByRole('tab', { name: emptyTab, exact: true }).waitFor({ state: 'detached' });
    await page.reload(); await ready();
    assert.deepEqual(await workspace(), deleted.state, 'Confirmed deletion persists after reload');
    assert.deepEqual(await tabs.getByRole('tab').allTextContents(),
      sorted(deleted.state.nodes, null).map(n => n.title), 'All other tabs retain their order and labels');
    assert.equal(new URL(page.url()).pathname, '/admin');
    assert.notEqual(new URL(page.url()).searchParams.get('doc'), target.id, 'Selection falls back from the deleted tab');
  } finally { page.off('request', recordDelete); }
  console.log('PASS organization UI: real tree drag reorder/reparent, persisted parent/sort, empty-tab delete cancel/confirm and preservation of other tabs');
}
