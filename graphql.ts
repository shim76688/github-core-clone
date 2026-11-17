// graphql.ts — the GraphQL v4 surface (POST /api/graphql). v1: the envelope and the viewer query;
// the full executor (repository/issues/pull requests, mutations, introspection, batching) lands in
// the next revision of this file.

import type { Store } from './store.ts';

export interface GraphQLResponse {
  status: number;
  json: unknown;
}

/** Answer one GraphQL request body (a single operation object, or an array for batching). */
export function handleGraphQL(store: Store, bodyText: string): GraphQLResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map((entry) => runOne(store, entry)) };
  }
  return { status: 200, json: runOne(store, parsed) };
}

function runOne(store: Store, entry: unknown): Record<string, unknown> {
  void entry;
  return { data: { viewer: { login: store.boundOwner ?? '' } } };
}
