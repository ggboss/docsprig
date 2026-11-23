import { validateApiDraft } from './content.mjs';
import { saveDrafts, recordDraftChanges, insertRelease, loadRelease, nodeJSON, releaseJSON } from './repository.mjs';
const maxNodes = 1000, maxLevels = 16; // roots are level 1
const maxTreeBytes = 12 * 1024 * 1024;
export const validId = id => typeof id === 'string' && id.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(id) && !/\s/u.test(id);
function reject(status, message) { throw Object.assign(new Error(message), { status }); }

function tree(input) {
  if (!Array.isArray(input) || input.length > maxNodes) reject(400, 'Expected at most 1000 nodes');
  let bytes = 2; // JSON array brackets, plus one comma between nodes below
  const byId = new Map();
  const nodes = input.map(n => {
    if (!n || typeof n !== 'object') reject(400, 'Expected a node');
    const { id, parentId, sort, title, type, body } = n;
    if (!validId(id) || byId.has(id) ||
        (parentId !== null && !validId(parentId)) || !Number.isSafeInteger(sort) || sort < 0 || sort > 2147483647 ||
        typeof title !== 'string' || !title.trim() || title.length > 200 || /[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(title) || typeof body !== 'string' || !['group','markdown','api'].includes(type))
      reject(400, 'Invalid or duplicate node');
    if (parentId === null && type !== 'group')
      reject(400, 'Invalid workspace root');
    const node = { id, parentId, sort, title, type, body };
    // Count normalized content (including JSON escaping), not client-supplied metadata.
    bytes += Buffer.byteLength(JSON.stringify(node)) + (byId.size ? 1 : 0);
    if (bytes > maxTreeBytes) reject(413, 'Workspace tree exceeds 12 MiB');
    byId.set(id, node);
    return node;
  });
  for (const node of nodes) {
    let ancestor = node, level = 1;
    while (ancestor.parentId !== null) {
      // The depth bound also rejects cycles, independent of input order.
      if (++level > maxLevels) reject(400, 'Tree exceeds 16 levels or contains a cycle');
      ancestor = byId.get(ancestor.parentId);
      if (ancestor?.type !== 'group') reject(400, 'Expected a parent group');
    }
  }
  return nodes;
}

const byRank = (a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// The same insertion algorithm is applied separately to the draft and released siblings.
function insertionRanks(siblings, moved, index) {
  const rank = (siblings[index - 1]?.sort ?? -1) + 1;
  if (rank < (siblings[index]?.sort ?? 2147483648)) return new Map([[moved.id, rank]]);
  const ordered = siblings.toSpliced(index, 0, moved);
  return new Map(ordered.map((n, i) => [n.id, i]));
}

export function createStore(pool) {
  async function current(client, lock = false) {
    // Lock before the read: every writer observes the preceding committed revision.
    if (lock) await client.query('SELECT singleton FROM docs_state WHERE singleton FOR UPDATE');
    const { rows: [state] } = await client.query(`SELECT s.revision, ${releaseJSON} AS published,
      coalesce((SELECT jsonb_agg(${nodeJSON('d')} ORDER BY d.ordinal) FROM docs_drafts d
        JOIN docs_document_versions v ON v.id=d.version_id),'[]'::jsonb) AS nodes
      FROM docs_state s LEFT JOIN docs_releases r ON r.id=s.current_release_id WHERE s.singleton`);
    if (!state) throw new Error('Docs workspace has not been initialized');
    return state;
  }
  async function liveTree(client, published) {
    if (published === null) return [];
    const release = await loadRelease(client, published.id);
    if (!release) throw new Error('Missing published workspace release');
    return release.nodes;
  }
  async function write(expected, actor, prepare) {
    if (actor == null || actor === '') reject(400, 'Missing audit actor');
    const audit = JSON.stringify(actor);
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const state = await current(client, true);
      if (state.revision !== expected) reject(409, 'Workspace revision changed');
      const { nodes, published, live } = await prepare(state, client);
      const action = live === undefined ? 'save' : 'publish';
      if (live !== undefined) {
        if (!validId(published?.id)) throw new Error('Publisher returned no release ID or invalid release ID');
        if (published.revision !== state.revision) throw new Error('Publisher returned invalid release revision');
        await insertRelease(client, published, live);
      }
      await saveDrafts(client, nodes);
      const revision = state.revision + 1;
      await client.query(`UPDATE docs_state SET revision=$1,current_release_id=$2 WHERE singleton`,[revision,published?.id ?? null]);
      const before = new Map(state.nodes.map(n=>[n.id,n]));
      const changed = nodes.filter(n=>JSON.stringify(n)!==JSON.stringify(before.get(n.id))).map(n=>n.id);
      const removed = state.nodes.filter(n=>!nodes.some(next=>next.id===n.id)).map(n=>n.id);
      await client.query(`INSERT INTO docs_audit(revision,action,actor,release_id,metadata) VALUES ($1,$2,$3,$4,$5)`,
        [revision,action,audit,action==='publish' ? published.id : null,JSON.stringify({changed,removed})]);
      await recordDraftChanges(client,revision,state.nodes,nodes);
      const next = await current(client);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
  return {
    read: () => current(pool),
    async readNode(id) {
      const { rows: [row] } = await pool.query(`SELECT ${nodeJSON('d')} AS node
        FROM docs_drafts d JOIN docs_document_versions v ON v.id=d.version_id
        WHERE d.node_id=$1`, [id]);
      return row?.node ?? null;
    },
    releaseNodes: id => loadRelease(pool, id),
    async siteName() {
      const { rows: [setting] } = await pool.query('SELECT site_name AS name FROM docs_state WHERE singleton');
      if (!setting) throw new Error('Docs workspace has not been initialized');
      return setting;
    },
    async setSiteName(value) {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || [...name].length > 64 || /[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value))
        reject(400, '站点名称必须为 1 至 64 个字符的单行文本');
      const { rows: [setting] } = await pool.query('UPDATE docs_state SET site_name=$1 WHERE singleton RETURNING site_name AS name', [name]);
      if (!setting) throw new Error('Docs workspace has not been initialized');
      return setting;
    },
    async current() {
      const { rows: [state] } = await pool.query(`SELECT ${releaseJSON} AS published FROM docs_state s
        LEFT JOIN docs_releases r ON r.id=s.current_release_id WHERE s.singleton`);
      if (!state) throw new Error('Docs workspace has not been initialized');
      return state.published;
    },
    async hasRelease(id) {
      const { rows: [row] } = await pool.query('SELECT EXISTS (SELECT 1 FROM docs_releases WHERE id=$1) AS found', [id]);
      return row.found;
    },
    saveNode: (expected, node, actor) => write(expected, actor, async (state, client) => {
      const old = state.nodes.find(n => n.id === node?.id);
      if (old?.parentId === null && node.parentId !== null) reject(400, 'Cannot move an existing root under another node');
      if (old && old.type !== node.type) reject(400, 'Cannot change the type of an existing node');
      const next = tree(old ? state.nodes.map(n => n === old ? node : n) : [...state.nodes, node])
        .find(n => n.id === node.id);
      if (next.type === 'api') validateApiDraft(next.body, state.nodes.filter(n => n.id !== next.id), old?.body);
      // A legacy whole-tree save could remove a node that is still live.
      const publishedVersion = old ? old.publishedVersion :
        (await liveTree(client, state.published)).find(n => n.id === next.id)?.publishedVersion ?? null;
      const saved = { ...next, draftVersion: (old?.draftVersion ?? publishedVersion ?? 0) + 1, publishedVersion };
      // Content edits retain server-owned placement intent; explicit rank/parent edits replace it.
      if (old?.parentId === next.parentId && old.sort === next.sort) {
        if (old.pendingPlacement) saved.pendingPlacement = true;
        if (Object.hasOwn(old, 'keepLiveRank')) saved.keepLiveRank = old.keepLiveRank;
      }
      return { ...state, nodes: old ? state.nodes.map(n => n === old ? saved : n) : [...state.nodes, saved] };
    }),
    moveNode: (expected, id, parentId, beforeId, actor) => write(expected, actor, async state => {
      if (!validId(id) || !validId(parentId) || (beforeId !== null && !validId(beforeId)))
        reject(400, 'Invalid move identifiers');
      const byId = new Map(state.nodes.map(n => [n.id, n]));
      const moved = byId.get(id);
      if (!moved) reject(404, 'Unknown workspace node');
      if (!byId.has(parentId)) reject(404, 'Unknown destination parent');
      if (moved.parentId === null || byId.get(parentId).type !== 'group')
        reject(400, 'Expected a group destination for a non-root node');
      if (beforeId !== null && !byId.has(beforeId)) reject(404, 'Unknown insertion anchor');
      if (beforeId !== null && (beforeId === id || byId.get(beforeId).parentId !== parentId))
        reject(400, 'Insertion anchor must be another destination sibling');

      // Use the same sort/id tie-break as the published tree. Source siblings need no edits.
      const siblings = state.nodes.filter(n => n.parentId === parentId)
        .sort(byRank);
      const oldIndex = siblings.indexOf(moved);
      if (oldIndex >= 0) siblings.splice(oldIndex, 1);
      const index = beforeId === null ? siblings.length : siblings.indexOf(byId.get(beforeId));
      if (index === oldIndex) return state;
      const ranks = insertionRanks(siblings, moved, index);
      const nodes = state.nodes.map(n => {
        const sort = ranks.get(n.id);
        if (n === moved) return { ...n, parentId, sort, pendingPlacement: true, draftVersion: n.draftVersion + 1 };
        if (sort === undefined || sort === n.sort) return n;
        return { ...n, sort, draftVersion: n.draftVersion + 1 };
      });
      tree(nodes); // Includes the moved subtree's new depth, cycles and group-only roots.
      return { ...state, nodes };
    }),
    deleteNode: (expected, id, actor, stage) => write(expected, actor, async (state, client) => {
      if (!validId(id)) reject(400, 'Invalid node ID');
      const selected = state.nodes.find(n => n.id === id);
      if (!selected) reject(404, '节点不存在');
      if (selected.parentId === null) reject(409, '不能删除顶级目录');
      if (state.nodes.some(n => n.parentId === id)) reject(409, '草稿目录非空，不能删除');
      const previous = await liveTree(client, state.published);
      if (previous.some(n => n.id === id && n.parentId === null)) reject(409, '不能删除已发布的顶级目录');
      if (previous.some(n => n.parentId === id)) reject(409, '已发布目录非空，不能删除');
      const nodes = state.nodes.filter(n => n.id !== id);
      const live = previous.filter(n => n.id !== id);
      if (live.length === previous.length) return { nodes, published: state.published };
      const published = await stage({ nodes: structuredClone(live), revision: state.revision });
      if (typeof published?.id !== 'string' || !published.id.trim()) throw new Error('Publisher returned no release ID');
      return { nodes, published, live };
    }),
    deleteTab: (expected, id, actor, stage) => write(expected, actor, async (state, client) => {
      if (!validId(id)) reject(400, 'Invalid tab ID');
      const selected = state.nodes.find(node => node.id === id);
      if (!selected) reject(404, '栏目不存在');
      if (selected.parentId !== null || selected.type !== 'group') reject(400, '只能通过此接口删除顶级栏目');
      if (state.nodes.filter(node => node.parentId === null).length <= 1) reject(409, '至少保留一个栏目');
      if (state.nodes.some(node => node.parentId === id)) reject(409, '栏目草稿非空，请先移动或删除子节点');
      const previous = await liveTree(client, state.published);
      if (previous.some(node => node.parentId === id)) reject(409, '已发布栏目非空，请先发布子节点移动或删除子节点');
      const nodes = state.nodes.filter(node => node.id !== id);
      const live = previous.filter(node => node.id !== id);
      if (live.length === previous.length) return { nodes, published: state.published };
      if (!live.some(node => node.parentId === null)) reject(409, '至少保留一个已发布栏目，请先发布其他栏目');
      tree(live);
      const published = await stage({ nodes: structuredClone(live), revision: state.revision });
      if (typeof published?.id !== 'string' || !published.id.trim()) throw new Error('Publisher returned no release ID');
      return { nodes, published, live };
    }),
    saveTabs: (expected, tabs, actor) => write(expected, actor, async state => {
      if (!Array.isArray(tabs) || tabs.length > maxNodes) reject(400, 'Expected tabs array');
      const seen = new Set(), existing = new Map(state.nodes.map(node => [node.id, node]));
      const updates = new Map();
      for (const tab of tabs) {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab) ||
            Object.keys(tab).some(key => !['id', 'title', 'sort'].includes(key)) || seen.has(tab.id))
          reject(400, 'Invalid or duplicate tab');
        seen.add(tab.id);
        const old = existing.get(tab.id);
        if (old && old.parentId !== null) reject(400, 'Tab ID belongs to a non-root node');
        const changed = !old || old.title !== tab.title || old.sort !== tab.sort;
        updates.set(tab.id, { ...(old ?? { parentId: null, type: 'group', body: '', publishedVersion: null }),
          id: tab.id, title: tab.title, sort: tab.sort,
          draftVersion: (old?.draftVersion ?? 0) + (changed ? 1 : 0) });
      }
      for (const node of state.nodes) if (node.parentId === null && !seen.has(node.id)) reject(400, 'Cannot delete an existing root');
      const nodes = state.nodes.map(node => updates.get(node.id) ?? node);
      for (const [id, node] of updates) if (!existing.has(id)) nodes.push(node);
      tree(nodes); // Validate the entire update before writing anything.
      return { ...state, nodes };
    }),
    publishTabs: (expected, actor, stage) => write(expected, actor, async (state, client) => {
      const live = new Map((await liveTree(client, state.published)).map(node => [node.id, node]));
      const released = new Map();
      for (const node of state.nodes) if (node.parentId === null) {
        const next = { ...node, publishedVersion: node.draftVersion };
        released.set(node.id, next);
        live.set(node.id, next);
      }
      const snapshot = [...live.values()];
      tree(snapshot);
      const published = await stage({ nodes: structuredClone(snapshot), revision: state.revision });
      if (typeof published?.id !== 'string' || !published.id.trim()) throw new Error('Publisher returned no release ID');
      return { nodes: state.nodes.map(node => released.get(node.id) ?? node), published, live: snapshot };
    }),
    publishNode: (expected, id, draftVersion, actor, stage) => write(expected, actor, async (state, client) => {
      const selected = state.nodes.find(n => n.id === id);
      if (!selected) reject(404, 'Unknown workspace node');
      if (selected.draftVersion !== draftVersion) reject(409, 'Node draft version changed');
      const live = new Map((await liveTree(client, state.published)).map(n => [n.id, n]));
      if (selected.parentId !== null && !live.has(selected.parentId)) reject(409, 'Publish parent group first');
      const { pendingPlacement, keepLiveRank, ...draft } = selected;
      const released = { ...draft, publishedVersion: draft.draftVersion };
      let liveSort = released.sort;
      if (pendingPlacement) {
        const siblings = [...live.values()].filter(n => n.parentId === draft.parentId && n.id !== id).sort(byRank);
        // Resolve against today's draft order: a prior anchor may itself have moved or never been published.
        const ordered = state.nodes.filter(n => n.parentId === draft.parentId).sort(byRank);
        const next = ordered.slice(ordered.indexOf(selected) + 1).find(n => live.get(n.id)?.parentId === draft.parentId);
        const index = siblings.findIndex(n => n.id === next?.id);
        const ranks = insertionRanks(siblings, selected, index < 0 ? siblings.length : index);
        liveSort = ranks.get(id);
        for (const sibling of siblings) {
          const sort = ranks.get(sibling.id);
          if (sort !== undefined && sort !== sibling.sort) live.set(sibling.id, { ...sibling, sort });
        }
      } else if (keepLiveRank && live.has(id)) liveSort = live.get(id).sort;
      live.set(id, { ...released, sort: liveSort });
      // Draft-only siblings can make the two rank spaces differ. A later body edit must not undo this placement.
      if (released.sort !== liveSort) released.keepLiveRank = true;
      const snapshot = [...live.values()];
      tree(snapshot); // Validate live topology independently of pending moves/type changes.
      const published = await stage({ nodes: structuredClone(snapshot), revision: state.revision });
      if (typeof published?.id !== 'string' || !published.id.trim()) throw new Error('Publisher returned no release ID');
      return { nodes: state.nodes.map(n => n === selected ? released : n), published, live: snapshot };
    }),
  };
}
