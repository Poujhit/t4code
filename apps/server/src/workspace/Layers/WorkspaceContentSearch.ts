import type { ProjectTextSearchMatch, ProjectTextSearchResult } from "@t3tools/contracts";
import { Effect, Layer, Path } from "effect";

import * as processRunner from "../../processRunner.ts";
import {
  WorkspaceContentSearch,
  WorkspaceContentSearchError,
  type WorkspaceContentSearchShape,
} from "../Services/WorkspaceContentSearch.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_CONTENT_SEARCH_TIMEOUT_MS = 20_000;
const WORKSPACE_CONTENT_SEARCH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BUILT_IN_IGNORED_DIRECTORY_NAMES = [
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
] as const;

type RipgrepEncodedText = {
  readonly text?: string;
  readonly bytes?: string;
};

type RipgrepMatchMessage = {
  readonly type: "match";
  readonly data: {
    readonly path?: RipgrepEncodedText;
    readonly lines?: RipgrepEncodedText;
    readonly line_number?: number;
    readonly submatches?: ReadonlyArray<{
      readonly start?: number;
      readonly end?: number;
    }>;
  };
};

function contentSearchError(input: {
  cwd: string;
  operation: string;
  detail: string;
  cause?: unknown;
}): WorkspaceContentSearchError {
  return new WorkspaceContentSearchError({
    cwd: input.cwd,
    operation: input.operation,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function decodeRipgrepText(input: RipgrepEncodedText | undefined): string | null {
  if (!input) return null;
  if (typeof input.text === "string") {
    return input.text;
  }
  if (typeof input.bytes === "string") {
    return Buffer.from(input.bytes, "base64").toString("utf8");
  }
  return null;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function normalizeExcludeGlob(glob: string): string {
  return glob.startsWith("!") ? glob : `!${glob}`;
}

function asRipgrepMatchMessage(input: unknown): RipgrepMatchMessage | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const message = input as { readonly type?: unknown; readonly data?: unknown };
  if (message.type !== "match" || !message.data || typeof message.data !== "object") {
    return null;
  }
  return {
    type: "match",
    data: message.data as RipgrepMatchMessage["data"],
  };
}

function utf16ColumnFromUtf8ByteOffset(input: string, byteOffset: number): number {
  const encoded = Buffer.from(input, "utf8");
  const safeOffset = Math.max(0, Math.min(byteOffset, encoded.length));
  return encoded.subarray(0, safeOffset).toString("utf8").length + 1;
}

function compareMatches(left: ProjectTextSearchMatch, right: ProjectTextSearchMatch): number {
  if (left.lineNumber !== right.lineNumber) {
    return left.lineNumber - right.lineNumber;
  }
  if (left.startColumn !== right.startColumn) {
    return left.startColumn - right.startColumn;
  }
  return left.endColumn - right.endColumn;
}

export const makeWorkspaceContentSearch = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;

  const search: WorkspaceContentSearchShape["search"] = Effect.fn("WorkspaceContentSearch.search")(
    function* (input) {
      const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
        Effect.mapError((cause) =>
          contentSearchError({
            cwd: input.cwd,
            operation: "workspaceContentSearch.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
        ),
      );

      const args = ["--json", "--hidden", "--line-number", "--no-require-git", "--sort", "path"];
      if (!input.caseSensitive) {
        args.push("--ignore-case");
      }
      if (input.wholeWord) {
        args.push("--word-regexp");
      }
      if (!input.regexp) {
        args.push("--fixed-strings");
      }
      for (const ignoredDirectoryName of BUILT_IN_IGNORED_DIRECTORY_NAMES) {
        args.push("--glob", `!${ignoredDirectoryName}/**`);
      }
      for (const includeGlob of input.includeGlobs) {
        args.push("--glob", includeGlob);
      }
      for (const excludeGlob of input.excludeGlobs) {
        args.push("--glob", normalizeExcludeGlob(excludeGlob));
      }
      args.push(input.query, ".");

      const result = yield* Effect.tryPromise({
        try: () =>
          processRunner.runProcess("rg", args, {
            cwd: normalizedWorkspaceRoot,
            allowNonZeroExit: true,
            outputMode: "truncate",
            maxBufferBytes: WORKSPACE_CONTENT_SEARCH_MAX_OUTPUT_BYTES,
            timeoutMs: WORKSPACE_CONTENT_SEARCH_TIMEOUT_MS,
          }),
        catch: (cause) =>
          contentSearchError({
            cwd: input.cwd,
            operation: "workspaceContentSearch.runRipgrep",
            detail:
              cause instanceof Error && cause.message === "Command not found: rg"
                ? "ripgrep (rg) is required for workspace content search."
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
            cause,
          }),
      });

      if (result.timedOut) {
        return yield* contentSearchError({
          cwd: input.cwd,
          operation: "workspaceContentSearch.runRipgrep",
          detail: "Workspace content search timed out.",
        });
      }

      if (result.code === 1 && result.stdout.trim().length === 0) {
        return {
          files: [],
          truncated: false,
        } satisfies ProjectTextSearchResult;
      }

      if ((result.code ?? 0) !== 0 && result.code !== 1) {
        return yield* contentSearchError({
          cwd: input.cwd,
          operation: "workspaceContentSearch.runRipgrep",
          detail: result.stderr.trim() || "Workspace content search failed.",
        });
      }

      const files = new Map<
        string,
        {
          relativePath: string;
          matchCount: number;
          matches: ProjectTextSearchMatch[];
        }
      >();
      let totalMatches = 0;
      let truncated = Boolean(result.stdoutTruncated || result.stderrTruncated);

      const stdoutLines = result.stdout.split("\n");
      if (result.stdoutTruncated && !result.stdout.endsWith("\n")) {
        stdoutLines.pop();
      }

      for (const line of stdoutLines) {
        if (!line.trim()) {
          continue;
        }
        const parsed = Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: (cause) =>
            contentSearchError({
              cwd: input.cwd,
              operation: "workspaceContentSearch.parseRipgrepJson",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        const message = asRipgrepMatchMessage(yield* parsed);
        if (!message) {
          continue;
        }

        const rawPath = decodeRipgrepText(message.data.path);
        const lineText = decodeRipgrepText(message.data.lines);
        const lineNumber = message.data.line_number;
        if (!rawPath || lineText === null || typeof lineNumber !== "number") {
          continue;
        }

        const relativePath = path.isAbsolute(rawPath)
          ? toPosixPath(path.relative(normalizedWorkspaceRoot, rawPath))
          : toPosixPath(rawPath);
        const normalizedPath = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: normalizedWorkspaceRoot,
            relativePath,
          })
          .pipe(
            Effect.mapError((cause) =>
              contentSearchError({
                cwd: input.cwd,
                operation: "workspaceContentSearch.normalizeRipgrepPath",
                detail: cause.message,
                cause,
              }),
            ),
          );

        const fileEntry = files.get(normalizedPath.relativePath) ?? {
          relativePath: normalizedPath.relativePath,
          matchCount: 0,
          matches: [],
        };

        for (const submatch of message.data.submatches ?? []) {
          if (totalMatches >= input.limit) {
            truncated = true;
            break;
          }
          if (typeof submatch.start !== "number" || typeof submatch.end !== "number") {
            continue;
          }

          const match: ProjectTextSearchMatch = {
            relativePath: normalizedPath.relativePath,
            lineNumber,
            startColumn: utf16ColumnFromUtf8ByteOffset(lineText, submatch.start),
            endColumn: utf16ColumnFromUtf8ByteOffset(lineText, submatch.end),
            lineText,
            snippet: lineText,
          };
          fileEntry.matches.push(match);
          fileEntry.matchCount += 1;
          totalMatches += 1;
        }

        if (fileEntry.matchCount > 0) {
          files.set(fileEntry.relativePath, fileEntry);
        }
      }

      const groupedFiles = [...files.values()]
        .map((fileEntry) => ({
          relativePath: fileEntry.relativePath,
          matchCount: fileEntry.matchCount,
          matches: fileEntry.matches.toSorted(compareMatches),
        }))
        .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));

      return {
        files: groupedFiles,
        truncated,
      } satisfies ProjectTextSearchResult;
    },
  );

  return {
    search,
  } satisfies WorkspaceContentSearchShape;
});

export const WorkspaceContentSearchLive = Layer.effect(
  WorkspaceContentSearch,
  makeWorkspaceContentSearch,
);
