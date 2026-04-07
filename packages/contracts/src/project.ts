import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_FILE_CONTENTS_MAX_LIMIT = 200;
const PROJECT_SEARCH_FILE_CONTENTS_MAX_GLOBS = 32;
const PROJECT_SEARCH_FILE_CONTENTS_MAX_GLOB_LENGTH = 256;
const PROJECT_LIST_DIRECTORY_MAX_PATH_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

const ProjectSearchGlob = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_SEARCH_FILE_CONTENTS_MAX_GLOB_LENGTH),
);

export const ProjectTextSearchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  regexp: Schema.Boolean,
  includeGlobs: Schema.Array(ProjectSearchGlob).check(
    Schema.isMaxLength(PROJECT_SEARCH_FILE_CONTENTS_MAX_GLOBS),
  ),
  excludeGlobs: Schema.Array(ProjectSearchGlob).check(
    Schema.isMaxLength(PROJECT_SEARCH_FILE_CONTENTS_MAX_GLOBS),
  ),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_FILE_CONTENTS_MAX_LIMIT)),
});
export type ProjectTextSearchInput = typeof ProjectTextSearchInput.Type;

export const ProjectTextSearchMatch = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  startColumn: PositiveInt,
  endColumn: PositiveInt,
  lineText: Schema.String,
  snippet: Schema.String,
});
export type ProjectTextSearchMatch = typeof ProjectTextSearchMatch.Type;

export const ProjectTextSearchFile = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  matchCount: PositiveInt,
  matches: Schema.Array(ProjectTextSearchMatch),
});
export type ProjectTextSearchFile = typeof ProjectTextSearchFile.Type;

export const ProjectTextSearchResult = Schema.Struct({
  files: Schema.Array(ProjectTextSearchFile),
  truncated: Schema.Boolean,
});
export type ProjectTextSearchResult = typeof ProjectTextSearchResult.Type;

export const ProjectListDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.NullOr(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_LIST_DIRECTORY_MAX_PATH_LENGTH)),
  ),
});
export type ProjectListDirectoryInput = typeof ProjectListDirectoryInput.Type;

export const ProjectDirectoryEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectDirectoryEntry = typeof ProjectDirectoryEntry.Type;

export const ProjectListDirectoryResult = Schema.Struct({
  entries: Schema.Array(ProjectDirectoryEntry),
  truncated: Schema.Boolean,
});
export type ProjectListDirectoryResult = typeof ProjectListDirectoryResult.Type;

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  mtimeMs: Schema.Number,
  sizeBytes: NonNegativeInt,
  isBinary: Schema.Boolean,
  isTooLarge: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectTextSearchError extends Schema.TaggedErrorClass<ProjectTextSearchError>()(
  "ProjectTextSearchError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectListDirectoryError extends Schema.TaggedErrorClass<ProjectListDirectoryError>()(
  "ProjectListDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  expectedMtimeMs: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
