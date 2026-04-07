/**
 * WorkspaceContentSearch - Effect service contract for workspace-wide content search.
 *
 * Owns project-relative full-text search within a workspace root.
 *
 * @module WorkspaceContentSearch
 */
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectTextSearchInput, ProjectTextSearchResult } from "@t3tools/contracts";

export class WorkspaceContentSearchError extends Schema.TaggedErrorClass<WorkspaceContentSearchError>()(
  "WorkspaceContentSearchError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface WorkspaceContentSearchShape {
  readonly search: (
    input: ProjectTextSearchInput,
  ) => Effect.Effect<ProjectTextSearchResult, WorkspaceContentSearchError>;
}

export class WorkspaceContentSearch extends ServiceMap.Service<
  WorkspaceContentSearch,
  WorkspaceContentSearchShape
>()("t3/workspace/Services/WorkspaceContentSearch") {}
