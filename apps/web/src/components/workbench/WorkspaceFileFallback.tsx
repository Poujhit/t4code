import type { ReactNode } from "react";
import { AlertTriangleIcon, FileQuestionIcon, FileWarningIcon, RefreshCcwIcon } from "lucide-react";

import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

const ICON_BY_KIND = {
  binary: <FileWarningIcon className="size-4" />,
  tooLarge: <FileWarningIcon className="size-4" />,
  unreadable: <AlertTriangleIcon className="size-4" />,
  missing: <FileQuestionIcon className="size-4" />,
  conflict: <AlertTriangleIcon className="size-4" />,
} as const;

export function WorkspaceFileFallback(props: {
  kind: "binary" | "tooLarge" | "unreadable" | "missing" | "conflict";
  title: string;
  description: string;
  details?: ReactNode;
  variant?: "full" | "banner";
  primaryAction?: { label: string; onClick: () => void; loading?: boolean };
  secondaryAction?: { label: string; onClick: () => void };
}) {
  const variant = props.variant ?? "full";
  const icon = ICON_BY_KIND[props.kind];

  return (
    <div
      className={cn(
        "border-border/80 bg-card/60 text-card-foreground",
        variant === "full"
          ? "flex h-full min-h-0 flex-col items-center justify-center gap-4 px-6 py-10 text-center"
          : "border-b border-border px-4 py-3",
      )}
    >
      <div
        className={cn(
          "flex items-start gap-3",
          variant === "full" ? "max-w-xl flex-col items-center text-center" : "w-full",
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className={cn("min-w-0", variant === "full" ? "space-y-2" : "space-y-1")}>
          <p className="text-sm font-medium text-foreground">{props.title}</p>
          <p className="text-sm text-muted-foreground">{props.description}</p>
          {props.details ? (
            <div className="text-xs text-muted-foreground">{props.details}</div>
          ) : null}
          {props.primaryAction || props.secondaryAction ? (
            <div
              className={cn(
                "flex flex-wrap gap-2",
                variant === "full" ? "justify-center pt-1" : "pt-2",
              )}
            >
              {props.primaryAction ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={props.primaryAction.onClick}
                  disabled={props.primaryAction.loading}
                >
                  <RefreshCcwIcon className="size-4" />
                  {props.primaryAction.loading ? "Working..." : props.primaryAction.label}
                </Button>
              ) : null}
              {props.secondaryAction ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={props.secondaryAction.onClick}
                >
                  {props.secondaryAction.label}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
