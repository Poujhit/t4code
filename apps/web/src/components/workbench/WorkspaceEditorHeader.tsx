export function WorkspaceEditorHeader(props: {
  filename: string;
  relativePath: string;
  isDirty: boolean;
  readOnlyLabel?: string | null;
}) {
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="truncate">{props.filename}</span>
          {props.isDirty ? (
            <span className="rounded-full bg-amber-500/14 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-300">
              Unsaved
            </span>
          ) : null}
          {props.readOnlyLabel ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {props.readOnlyLabel}
            </span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={props.relativePath}>
          {props.relativePath}
        </p>
      </div>
    </div>
  );
}
