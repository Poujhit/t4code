import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type EditorView } from "@codemirror/view";
import type { AiReviewHunk } from "~/lib/aiReviewDiff";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  const safeRadius = Math.min(radius, safeWidth / 2, safeHeight / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + safeWidth - safeRadius, y);
  context.quadraticCurveTo(x + safeWidth, y, x + safeWidth, y + safeRadius);
  context.lineTo(x + safeWidth, y + safeHeight - safeRadius);
  context.quadraticCurveTo(
    x + safeWidth,
    y + safeHeight,
    x + safeWidth - safeRadius,
    y + safeHeight,
  );
  context.lineTo(x + safeRadius, y + safeHeight);
  context.quadraticCurveTo(x, y + safeHeight, x, y + safeHeight - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

export function WorkspaceEditorMinimap(props: {
  value: string;
  resolvedTheme: "light" | "dark";
  view: EditorView | null;
  reviewHunks?: readonly AiReviewHunk[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hasScrollableContent, setHasScrollableContent] = useState(false);
  const lines = useMemo(() => props.value.split("\n"), [props.value]);
  const reviewMarkers = useMemo(() => {
    const totalLines = Math.max(lines.length, 1);
    return (props.reviewHunks ?? []).map((hunk) => {
      const safeStartLine = Math.max(1, Math.min(totalLines, hunk.startLine));
      const safeEndLine = Math.max(safeStartLine, Math.min(totalLines, hunk.endLine));
      return {
        id: hunk.id,
        topPercent: ((safeStartLine - 1) / totalLines) * 100,
        heightPercent: (Math.max(1, safeEndLine - safeStartLine + 1) / totalLines) * 100,
      };
    });
  }, [lines.length, props.reviewHunks]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextEntry = entries[0];
      if (!nextEntry) {
        return;
      }
      setSize({
        width: nextEntry.contentRect.width,
        height: nextEntry.contentRect.height,
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const view = props.view;
    if (!view) {
      setHasScrollableContent(false);
      return;
    }

    const scroller = view.scrollDOM;
    const updateScrollableState = () => {
      setHasScrollableContent(
        scroller.scrollHeight > scroller.clientHeight + 1 ||
          scroller.scrollWidth > scroller.clientWidth + 1,
      );
    };

    let frameId = 0;
    let remainingFrames = 6;
    const measureForAWhile = () => {
      updateScrollableState();
      if (remainingFrames <= 0) {
        return;
      }
      remainingFrames -= 1;
      frameId = requestAnimationFrame(measureForAWhile);
    };

    measureForAWhile();
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            updateScrollableState();
          })
        : null;
    resizeObserver?.observe(scroller);
    scroller.addEventListener("scroll", updateScrollableState, { passive: true });
    window.addEventListener("resize", updateScrollableState);
    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      scroller.removeEventListener("scroll", updateScrollableState);
      window.removeEventListener("resize", updateScrollableState);
    };
  }, [props.value, props.view, size.height, size.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const view = props.view;
    if (!canvas || !view || !hasScrollableContent || size.width <= 0 || size.height <= 0) {
      return;
    }

    const scroller = view.scrollDOM;
    const background =
      props.resolvedTheme === "dark" ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.03)";
    const stroke =
      props.resolvedTheme === "dark" ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.14)";
    const thumbFill =
      props.resolvedTheme === "dark" ? "rgba(148, 163, 184, 0.16)" : "rgba(100, 116, 139, 0.12)";
    const thumbStroke =
      props.resolvedTheme === "dark" ? "rgba(148, 163, 184, 0.6)" : "rgba(100, 116, 139, 0.5)";

    let frameId = 0;

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(size.width));
      const height = Math.max(1, Math.floor(size.height));
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);

      const bucketCount = Math.max(1, Math.floor(height));
      const bucketHeights = height / bucketCount;
      let maxLineLength = 1;
      for (const line of lines) {
        if (line.length > maxLineLength) {
          maxLineLength = line.length;
        }
      }
      const buckets = Array.from({ length: bucketCount }, () => ({
        widthRatio: 0,
        indentRatio: 0,
      }));

      for (const [index, line] of lines.entries()) {
        const bucketIndex = Math.min(
          bucketCount - 1,
          Math.floor((index / Math.max(lines.length, 1)) * bucketCount),
        );
        const lengthRatio = clamp(line.trimEnd().length / maxLineLength, 0, 1);
        const indentMatch = line.match(/^\s*/);
        const indentRatio = clamp((indentMatch?.[0].length ?? 0) / 24, 0, 1);
        const bucket = buckets[bucketIndex];
        if (!bucket) {
          continue;
        }
        bucket.widthRatio = Math.max(bucket.widthRatio, lengthRatio);
        bucket.indentRatio = Math.max(bucket.indentRatio, indentRatio);
      }

      for (const [index, bucket] of buckets.entries()) {
        if (bucket.widthRatio <= 0) {
          continue;
        }
        const y = index * bucketHeights;
        const x = 4 + bucket.indentRatio * Math.max(0, width * 0.22);
        const barWidth = Math.max(2, (width - x - 5) * bucket.widthRatio);
        context.fillStyle =
          props.resolvedTheme === "dark" ? "rgba(226, 232, 240, 0.22)" : "rgba(15, 23, 42, 0.18)";
        context.fillRect(x, y, barWidth, Math.max(1, bucketHeights * 0.9));
      }

      const scrollHeight = Math.max(scroller.scrollHeight, 1);
      const clientHeight = Math.max(scroller.clientHeight, 1);
      const viewportTopRatio = clamp(scroller.scrollTop / scrollHeight, 0, 1);
      const viewportHeightRatio = clamp(clientHeight / scrollHeight, 0.04, 1);
      const viewportTop = viewportTopRatio * height;
      const viewportHeight = Math.max(18, viewportHeightRatio * height);
      const viewportX = 1.5;
      const viewportWidth = Math.max(0, width - 3);

      context.fillStyle = thumbFill;
      context.strokeStyle = thumbStroke;
      context.lineWidth = 1;
      drawRoundedRect(context, viewportX, viewportTop, viewportWidth, viewportHeight, 6);
      context.fill();
      drawRoundedRect(
        context,
        viewportX,
        viewportTop + 0.5,
        viewportWidth,
        Math.max(0, viewportHeight - 1),
        6,
      );
      context.stroke();
      context.strokeStyle = stroke;
      context.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    };

    const scheduleDraw = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(draw);
    };

    scheduleDraw();
    scroller.addEventListener("scroll", scheduleDraw, { passive: true });
    window.addEventListener("resize", scheduleDraw);
    return () => {
      cancelAnimationFrame(frameId);
      scroller.removeEventListener("scroll", scheduleDraw);
      window.removeEventListener("resize", scheduleDraw);
    };
  }, [hasScrollableContent, lines, props.resolvedTheme, props.view, size.height, size.width]);

  const scrollEditorToClientY = useCallback(
    (clientY: number) => {
      const container = containerRef.current;
      const view = props.view;
      if (!container || !view) {
        return;
      }
      const scroller = view.scrollDOM;
      const rect = container.getBoundingClientRect();
      const ratio = clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo({
        top: clamp(ratio * scroller.scrollHeight - scroller.clientHeight / 2, 0, maxScrollTop),
      });
      view.focus();
    },
    [props.view],
  );

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-16 shrink-0 items-stretch border-l border-border/70 bg-background/60 p-1"
      style={{
        visibility: hasScrollableContent ? "visible" : "hidden",
        pointerEvents: hasScrollableContent ? "auto" : "none",
      }}
      data-testid="workspace-editor-minimap"
      aria-label="Editor minimap"
      onPointerDown={(event) => {
        dragPointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollEditorToClientY(event.clientY);
      }}
      onPointerMove={(event) => {
        if (dragPointerIdRef.current !== event.pointerId) {
          return;
        }
        scrollEditorToClientY(event.clientY);
      }}
      onPointerUp={(event) => {
        if (dragPointerIdRef.current !== event.pointerId) {
          return;
        }
        dragPointerIdRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (dragPointerIdRef.current !== event.pointerId) {
          return;
        }
        dragPointerIdRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      {reviewMarkers.map((marker) => (
        <div
          key={marker.id}
          data-slot="workspace-editor-minimap-hunk"
          className="pointer-events-none absolute left-1 right-1 rounded-sm bg-primary/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
          style={{
            top: `${marker.topPercent}%`,
            minHeight: "4px",
            height: `${Math.max(marker.heightPercent, 0.6)}%`,
          }}
        />
      ))}
      <canvas ref={canvasRef} className="h-full w-full rounded-sm" />
    </div>
  );
}
