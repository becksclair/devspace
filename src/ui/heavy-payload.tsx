// Code and diff renderer for read, write and edit cards. Loaded lazily (React.lazy) so that
// @pierre/diffs and Shiki stay out of the initial bundle.

import { useEffect, useMemo, useRef, useState } from "react";
import { FileStream, getFiletypeFromFileName } from "@pierre/diffs";
import type { FileStreamOptions } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import {
  isEditTool,
  isReadTool,
  isWriteTool,
  payloadText,
  summaryNumber,
  type ToolResultCard,
} from "./card-types.js";
import { CODE_THEMES, useHighlighterFailure } from "./highlighter.js";
import { PlainFallback, StatusLine, type ThemeType } from "./payload-fallback.js";
import { PREFERRED_HIGHLIGHTER, renderFailureMessage } from "./render-fallback.js";

export default function HeavyPayload({
  card,
  themeType,
}: {
  card: ToolResultCard;
  themeType: ThemeType;
}) {
  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    const patch = card.payload?.patch || card.payload?.diff;
    if (!patch) {
      // write_file results carry no diff; show the result message instead.
      const message = payloadText(card.payload);
      return message
        ? <pre className={`text-payload ${card.tool}`}>{message}</pre>
        : <StatusLine message="Diff payload is not available." />;
    }

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
    // Each run renders into its own element, so a run that settles after a newer one started
    // (the theme changed while the highlighter loaded) removes only its own output.
    const target = wrapper.appendChild(document.createElement("div"));

    fileStream.setup(source, target).then(
      () => {
        if (disposed) fileStream.cleanUp();
      },
      (error: unknown) => {
        if (disposed) return;
        fileStream.cleanUp();
        target.remove();
        setFailure(renderFailureMessage(error));
      },
    );

    return () => {
      disposed = true;
      fileStream.cleanUp();
      target.remove();
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
