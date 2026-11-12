import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileStream, getFiletypeFromFileName } from "@pierre/diffs";
import type { FileStreamOptions } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import {
  isEditTool,
  isReadTool,
  isWriteTool,
  payloadText,
  summaryNumber,
  type HostContext,
  type ToolResultCard,
} from "./card-types.js";
import { CODE_THEMES, useHighlighterFailure } from "./highlighter.js";
import { PayloadErrorBoundary, PlainFallback } from "./payload-fallback.js";
import { PREFERRED_HIGHLIGHTER, plainRenderText, renderFailureMessage } from "./render-fallback.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountHeavyPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  const render = (next: PayloadRendererOptions) => {
    root.render(
      <PayloadErrorBoundary fallbackText={plainRenderText(next.card)} tool={next.card.tool}>
        <HeavyPayload {...next} />
      </PayloadErrorBoundary>,
    );
  };
  render(options);

  return {
    update(nextOptions) {
      render(nextOptions);
    },
    unmount() {
      root.unmount();
    },
  };
}

export type { MountedPayload, PayloadRendererOptions };

function HeavyPayload({
  card,
  hostContext,
  errorMessage = null,
}: PayloadRendererOptions) {
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";

  if (errorMessage) {
    return <StatusLine message={errorMessage} tone="error" />;
  }

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    const patch = card.payload?.patch || card.payload?.diff;
    if (!patch) return <StatusLine message="Diff payload is not available." />;

    return <DiffPayload patch={patch} path={card.path} tool={card.tool} themeType={themeType} />;
  }

  const text = payloadText(card.payload);
  if (!text) return <StatusLine message="No details available." />;

  if (isReadTool(card.tool)) {
    return (
      <FilePayload
        path={card.path ?? "file"}
        text={text}
        startLine={summaryNumber(card.summary, "offset") ?? 1}
        themeType={themeType}
      />
    );
  }

  return <pre className={`text-payload ${card.tool}`}>{text}</pre>;
}

function FilePayload({
  path,
  text,
  startLine,
  themeType,
}: {
  path: string;
  text: string;
  startLine: number;
  themeType: ThemeType;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileOptions: FileStreamOptions = useMemo(
    () => ({
      theme: CODE_THEMES,
      themeType,
      overflow: "scroll",
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
    }),
    [themeType],
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    setFailure(null);

    const fileStream = new FileStream({
      ...fileOptions,
      lang: getFiletypeFromFileName(path),
      startingLineIndex: startLine,
    });
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    });
    let disposed = false;

    fileStream.setup(source, wrapper).then(
      () => {
        if (!disposed) return;
        fileStream.cleanUp();
        wrapper.replaceChildren();
      },
      (error: unknown) => {
        if (disposed) return;
        fileStream.cleanUp();
        wrapper.replaceChildren();
        setFailure(renderFailureMessage(error));
      },
    );

    return () => {
      disposed = true;
      fileStream.cleanUp();
      wrapper.replaceChildren();
    };
  }, [fileOptions, path, startLine, text]);

  if (failure) return <PlainFallback message={failure} text={text} tool="read_file" />;
  return <div ref={wrapperRef} className="pierre-file" />;
}

function DiffPayload({
  patch,
  path,
  tool,
  themeType,
}: {
  patch: string;
  path: string | undefined;
  tool: string;
  themeType: ThemeType;
}) {
  const failure = useHighlighterFailure(path ? getFiletypeFromFileName(path) : undefined);
  if (failure) return <PlainFallback message={failure} text={patch} tool={tool} />;

  return (
    <PatchDiff
      patch={patch}
      options={{
        theme: CODE_THEMES,
        themeType,
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        diffStyle: "unified",
        diffIndicators: "bars",
        hunkSeparators: "line-info",
        lineDiffType: "word-alt",
        overflow: "scroll",
        collapsedContextThreshold: 4,
        expansionLineCount: 20,
        stickyHeader: true,
        disableFileHeader: true,
      }}
      className="pierre-diff"
    />
  );
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}
