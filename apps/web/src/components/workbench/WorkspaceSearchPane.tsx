import type { ProjectTextSearchMatch, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef } from "react";

import { projectSearchFileContentsQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { selectWorkspaceSearchState, useWorkspaceWorkbenchStore } from "~/workspaceWorkbenchStore";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { WorkbenchEmptyState } from "./WorkbenchEmptyState";

function parseGlobInput(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function searchMatchKey(relativePath: string, match: ProjectTextSearchMatch): string {
  return `${relativePath}:${match.lineNumber}:${match.startColumn}:${match.endColumn}:${match.snippet}`;
}

function renderHighlightedSnippet(match: ProjectTextSearchMatch, active: boolean) {
  const start = Math.max(0, match.startColumn - 1);
  const end = Math.max(start, match.endColumn - 1);
  return (
    <>
      <span>{match.snippet.slice(0, start)}</span>
      <mark
        className={cn(
          "rounded px-0.5 font-medium",
          active
            ? "bg-primary text-primary-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_80%,transparent)]"
            : "bg-amber-300/30 text-amber-50",
        )}
      >
        {match.snippet.slice(start, end)}
      </mark>
      <span>{match.snippet.slice(end)}</span>
    </>
  );
}

export function WorkspaceSearchPane(props: {
  threadId: ThreadId;
  workspaceRoot: string | null;
  theme: "light" | "dark";
}) {
  const searchState = useWorkspaceWorkbenchStore((state) =>
    selectWorkspaceSearchState(state.searchStateByThreadId, props.threadId),
  );
  const updateSearchState = useWorkspaceWorkbenchStore((state) => state.updateSearchState);
  const toggleSearchResultCollapsed = useWorkspaceWorkbenchStore(
    (state) => state.toggleSearchResultCollapsed,
  );
  const revealFile = useWorkspaceWorkbenchStore((state) => state.revealFile);
  const setPendingRevealTarget = useWorkspaceWorkbenchStore(
    (state) => state.setPendingRevealTarget,
  );
  const queryInputRef = useRef<HTMLInputElement | null>(null);

  const deferredQuery = useDeferredValue(searchState.query.trim());
  const deferredIncludeGlobInput = useDeferredValue(searchState.includeGlobInput);
  const deferredExcludeGlobInput = useDeferredValue(searchState.excludeGlobInput);
  const includeGlobs = useMemo(
    () => parseGlobInput(deferredIncludeGlobInput),
    [deferredIncludeGlobInput],
  );
  const excludeGlobs = useMemo(
    () => parseGlobInput(deferredExcludeGlobInput),
    [deferredExcludeGlobInput],
  );

  const searchQuery = useQuery(
    projectSearchFileContentsQueryOptions({
      cwd: props.workspaceRoot,
      query: deferredQuery,
      caseSensitive: searchState.caseSensitive,
      wholeWord: searchState.wholeWord,
      regexp: searchState.regexp,
      includeGlobs,
      excludeGlobs,
      enabled: props.workspaceRoot !== null && deferredQuery.length > 0,
    }),
  );

  useEffect(() => {
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
  }, [searchState.focusRequestKey]);

  useEffect(() => {
    if (!searchQuery.data) {
      return;
    }
    const validPaths = new Set(searchQuery.data.files.map((file) => file.relativePath));
    const nextCollapsedPaths = searchState.collapsedFilePaths.filter((path) =>
      validPaths.has(path),
    );
    if (nextCollapsedPaths.length === searchState.collapsedFilePaths.length) {
      return;
    }
    updateSearchState(props.threadId, { collapsedFilePaths: nextCollapsedPaths });
  }, [props.threadId, searchQuery.data, searchState.collapsedFilePaths, updateSearchState]);

  if (!props.workspaceRoot) {
    return (
      <WorkbenchEmptyState
        icon={<SearchIcon className="size-4" />}
        title="Workspace unavailable"
        description="Open a thread with an active project to search across files."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-3">
        <div className="space-y-2">
          <Input
            ref={queryInputRef}
            type="search"
            className="text-[12.5px]"
            value={searchState.query}
            onChange={(event) =>
              updateSearchState(props.threadId, { query: event.currentTarget.value })
            }
            placeholder="Search across files"
            aria-label="Search across files"
          />
          <div className="flex flex-wrap gap-1.5">
            <Toggle
              pressed={searchState.caseSensitive}
              onPressedChange={(pressed) =>
                updateSearchState(props.threadId, { caseSensitive: pressed })
              }
              size="sm"
              aria-label="Match case"
            >
              Aa
            </Toggle>
            <Toggle
              pressed={searchState.wholeWord}
              onPressedChange={(pressed) =>
                updateSearchState(props.threadId, { wholeWord: pressed })
              }
              size="sm"
              aria-label="Match whole word"
            >
              ab
            </Toggle>
            <Toggle
              pressed={searchState.regexp}
              onPressedChange={(pressed) => updateSearchState(props.threadId, { regexp: pressed })}
              size="sm"
              aria-label="Use regular expression"
            >
              .*
            </Toggle>
          </div>
          <Input
            type="text"
            className="text-[12px]"
            value={searchState.includeGlobInput}
            onChange={(event) =>
              updateSearchState(props.threadId, {
                includeGlobInput: event.currentTarget.value,
              })
            }
            placeholder="Include files, comma-separated"
            aria-label="Include globs"
            size="sm"
          />
          <Input
            type="text"
            className="text-[12px]"
            value={searchState.excludeGlobInput}
            onChange={(event) =>
              updateSearchState(props.threadId, {
                excludeGlobInput: event.currentTarget.value,
              })
            }
            placeholder="Exclude files, comma-separated"
            aria-label="Exclude globs"
            size="sm"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {searchState.query.trim().length === 0 ? (
          <WorkbenchEmptyState
            icon={<SearchIcon className="size-4" />}
            title="Search across files"
            description="Enter a query to search the active workspace."
          />
        ) : searchQuery.isPending ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Searching workspace...</div>
        ) : searchQuery.isError ? (
          <div className="space-y-2 px-2 py-3">
            <div className="text-sm text-destructive">Unable to search the workspace.</div>
            <div className="text-xs text-muted-foreground">{searchQuery.error.message}</div>
          </div>
        ) : searchQuery.data.files.length === 0 ? (
          <WorkbenchEmptyState
            icon={<SearchIcon className="size-4" />}
            title="No matches"
            description="Try a different query or adjust the filters."
          />
        ) : (
          <div className="space-y-1.5">
            {searchQuery.data.files.map((file) => {
              const isCollapsed = searchState.collapsedFilePaths.includes(file.relativePath);
              return (
                <section
                  key={file.relativePath}
                  className="overflow-hidden rounded-lg border border-border/70 bg-card/45"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-accent/45"
                    onClick={() => toggleSearchResultCollapsed(props.threadId, file.relativePath)}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      {isCollapsed ? (
                        <ChevronRightIcon className="size-3.5" />
                      ) : (
                        <ChevronDownIcon className="size-3.5" />
                      )}
                    </span>
                    <VscodeEntryIcon
                      pathValue={file.relativePath}
                      kind="file"
                      theme={props.theme}
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{file.relativePath}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {file.matchCount} {file.matchCount === 1 ? "match" : "matches"}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="border-t border-border/70">
                      {file.matches.map((match) => (
                        <Button
                          key={searchMatchKey(file.relativePath, match)}
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "flex h-auto w-full items-start justify-start rounded-none px-2 py-2 text-left",
                            "hover:bg-accent/50",
                            searchState.activeMatchKey ===
                              searchMatchKey(file.relativePath, match) && "bg-accent/65",
                          )}
                          onClick={() => {
                            updateSearchState(props.threadId, {
                              activeMatchKey: searchMatchKey(file.relativePath, match),
                            });
                            setPendingRevealTarget(props.threadId, {
                              path: file.relativePath,
                              lineNumber: match.lineNumber,
                              startColumn: match.startColumn,
                              endColumn: match.endColumn,
                            });
                            revealFile(props.threadId, file.relativePath);
                          }}
                        >
                          <span className="mt-0.5 shrink-0 font-mono text-[11px] text-muted-foreground">
                            {match.lineNumber}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 overflow-hidden font-mono text-[12px] leading-5",
                              searchState.activeMatchKey ===
                                searchMatchKey(file.relativePath, match)
                                ? "text-foreground"
                                : "text-foreground/90",
                            )}
                          >
                            {renderHighlightedSnippet(
                              match,
                              searchState.activeMatchKey ===
                                searchMatchKey(file.relativePath, match),
                            )}
                          </span>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {searchQuery.data.truncated ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                Showing the first 200 matches.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
