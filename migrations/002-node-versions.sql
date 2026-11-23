-- Legacy publish history already stores the exact live tree. Keep those rows
-- immutable; treat each node in a legacy release as published version 1.
UPDATE docs_workspace w SET nodes = (
  SELECT jsonb_agg(d.node || jsonb_build_object(
    'draftVersion', CASE WHEN l.node IS NOT NULL AND l.node <> d.node THEN 2 ELSE 1 END,
    'publishedVersion', CASE WHEN l.node IS NOT NULL THEN 1 END
  ) ORDER BY d.pos)
  FROM jsonb_array_elements(w.nodes) WITH ORDINALITY AS d(node,pos)
  LEFT JOIN (
    SELECT n.node FROM docs_history h, jsonb_array_elements(h.nodes) n(node)
    WHERE h.action = 'publish' AND h.release->>'id' = w.published->>'id'
  ) l ON l.node->>'id' = d.node->>'id'
) WHERE NOT (nodes->0 ? 'draftVersion');
