import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  getFiletypeFromFileName,
  parsePatchFiles,
  type FileDiffMetadata,
  type FileDiffOptions,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";
import { CODE_THEMES, useHighlighterFailure } from "./highlighter.js";
import { PayloadErrorBoundary, PlainFallback } from "./payload-fallback.js";
import {
  PREFERRED_HIGHLIGHTER,
  plainRenderText,
  renderFailureMessage,
  splitPatchByFile,
} from "./render-fallback.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
  visibleFileCount?: number;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  const render = (next: PayloadRendererOptions) => {
    root.render(
      <PayloadErrorBoundary fallbackText={plainRenderText(next.card)} tool={next.card.tool}>
        <ReviewPayload {...next} />
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

function ReviewPayload({
  card,
  hostContext,
  errorMessage = null,
  visibleFileCount,
}: PayloadRendererOptions) {
  const patch = card.payload?.patch;
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const parsed = useMemo(() => parseFiles(patch), [patch]);
  const files = parsed.files;
  const sections = useMemo(() => (patch ? splitPatchByFile(patch) : []), [patch]);
  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (parsed.error) return <PlainFallback message={parsed.error} text={patch} tool={card.tool} />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);

  return (
    <div className="review-diff">
      <div className="review-diff-files">
        {visibleFiles.map((fileDiff, index) => {
          const key = fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
          const stats = diffStats(fileDiff);
          const isOpen = openFiles.has(key);

          return (
            <div className="review-diff-file" key={key}>
              <button
                type="button"
                className="review-diff-file-header"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(openFiles);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  setOpenFiles(next);
                }}
              >
                <span className="review-diff-file-name">{fileDiff.name}</span>
                <span className="review-diff-file-stats">
                  <span className="add">+{stats.additions}</span>
                  <span className="remove">-{stats.removals}</span>
                </span>
              </button>
              {isOpen ? (
                <ReviewFileDiff
                  fileDiff={fileDiff}
                  options={options}
                  plainText={sections.length === files.length ? sections[index] ?? patch : patch}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReviewFileDiff({
  fileDiff,
  options,
  plainText,
}: {
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<undefined, undefined>;
  plainText: string;
}) {
  const failure = useHighlighterFailure(fileDiff.lang ?? getFiletypeFromFileName(fileDiff.name));
  if (failure) return <PlainFallback message={failure} text={plainText} tool="show_changes" />;
  return <FileDiff fileDiff={fileDiff} options={options} className="pierre-diff" />;
}

function parseFiles(patch: string | undefined): { files: FileDiffMetadata[]; error?: string } {
  if (!patch) return { files: [] };
  try {
    return {
      files: parsePatchFiles(patch, { cacheKeyPrefix: "review", throwOnError: true })
        .flatMap((parsedPatch) => parsedPatch.files),
    };
  } catch (error) {
    return { files: [], error: renderFailureMessage(error) };
  }
}

function diffStats(fileDiff: FileDiffMetadata): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

function diffOptions(themeType: ThemeType): FileDiffOptions<undefined, undefined> {
  return {
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
    stickyHeader: false,
    disableFileHeader: true,
  };
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
