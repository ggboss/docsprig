# Zudoku operation server precedence

`zudoku@0.93.2.patch` fixes a mismatch between the rendered operation URL/cURL
snippet and the playground server. Upstream `OperationList` passes its first
root server as if it were a deliberate user selection, hiding operation/path
server overrides.

The patch uses the existing `useSelectedServer(operation.servers)` in both
operation display and sidecar. GraphQL already resolves operation > path > root
inheritance; the same hook is used by Playground. Persisted selections only
apply when they belong to the effective server list, and variable values still
resolve normally. Stored OpenAPI contracts, exports and MCP responses are not
rewritten.

pnpm applies the patch from `pnpm-workspace.yaml`; keep the lockfile together
with it. On Zudoku upgrades, review the patch instead of silently dropping it.
Regression: build, then run
`node --test tests/api-preview-performance-browser.mjs` (independent headless
browser). Covers draft/save/public rendering, inheritance, stale selection,
valid selection and server variables.
