import { useReducer } from 'react';

type State = { query: string; term: string; browse: Set<string>; search: Set<string> };
type Action = { type: 'query'; value: string } | { type: 'toggle'; id: string } | { type: 'expand'; ids: string[] };

function update(state: State, action: Action): State {
  if (action.type === 'query') {
    const term = action.value.trim().toLocaleLowerCase();
    // A new result set starts open. Clearing the input restores the browse tree.
    return { ...state, query: action.value, term, search: term === state.term ? state.search : new Set() };
  }
  const key = state.term ? 'search' : 'browse';
  if (action.type === 'expand' && !action.ids.some(id => state[key].has(id))) return state;
  const next = new Set(state[key]);
  if (action.type === 'expand') {
    for (const id of action.ids) next.delete(id);
  } else if (next.has(action.id)) next.delete(action.id);
  else next.add(action.id);
  return { ...state, [key]: next };
}

export function useDirectorySearch() {
  const [state, dispatch] = useReducer(update, { query: '', term: '', browse: new Set<string>(), search: new Set<string>() });
  return { query: state.query, term: state.term, collapsed: state.term ? state.search : state.browse, dispatch };
}
