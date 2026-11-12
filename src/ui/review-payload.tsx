// Diff renderer for the review card (show_changes). Loaded lazily (React.lazy) so that
// @pierre/diffs and Shiki stay out of the initial bundle.

import { useMemo, useState } from "react";
import {
  getFiletypeFromFileName,
  parsePatchFiles,
  type FileDiffMetadata,
  type FileDiffOptions,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ToolResultCard } from "./card-types.js";
import { CODE_THEMES, useHighlighterFailure } from "./highlighter.js";
import { PlainFallback, StatusLine, type ThemeType } from "./payload-fallback.js";
import { reviewCacheKeyPrefix, reviewFileDisplay, reviewFileKindLabel } from "./review-files.js";
import {
  PREFERRED_HIGHLIGHTER,
  renderFailureMessage,
  splitPatchByFile,
} from "./render-fallback.js";

export default function ReviewPayload({
  card,
  themeType,
  visibleFileCount,
}: {
  card: ToolResultCard;
  themeType: ThemeType;
  /** Files to list; undefined lists all. */
  visibleFileCount?: number;
}) {
  const patch = card.payload?.patch;
  const parsed = useMemo(() => parseFiles(patch), [patch]);
  const files = parsed.files;
  const sections = useMemo(() => (patch ? splitPatchByFile(patch) : []), [patch]);
  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

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
          const section = sections.length === files.length ? sections[index] : undefined;
          const display = reviewFileDisplay(
            { type: fileDiff.type, prevName: fileDiff.prevName, name: fileDiff.name, hunkCount: fileDiff.hunks.length },
            section,
          );
          const isOpen = display.expandable && openFiles.has(key);
          const title = display.previousPath ? `${display.previousPath} → ${fileDiff.name}` : fileDiff.name;

          return (
            <div className="review-diff-file" key={key}>
              <button
                type="button"
                className="review-diff-file-header"
                aria-expanded={display.expandable ? isOpen : undefined}
                disabled={!display.expandable}
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
                {display.previousPath ? (
                  // The previous path gives way first, so a narrow row keeps the current path.
                  <span className="review-diff-file-name renamed" title={title}>
                    <span className="review-diff-file-previous">{`${display.previousPath} →\u00a0`}</span>
                    <span className="review-diff-file-current">{fileDiff.name}</span>
                  </span>
                ) : (
                  <span className="review-diff-file-name" title={title}>{title}</span>
                )}
                <span className="review-diff-file-stats">
                  <span className={`review-diff-file-kind ${display.kind}`}>{reviewFileKindLabel(display)}</span>
                  {display.showStats ? (
                    <>
                      <span className="add">+{stats.additions}</span>
                      <span className="remove">-{stats.removals}</span>
                    </>
                  ) : null}
                </span>
              </button>
              {isOpen ? (
                <ReviewFileDiff
                  fileDiff={fileDiff}
                  options={options}
                  plainText={section ?? patch}
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
      files: parsePatchFiles(patch, { cacheKeyPrefix: reviewCacheKeyPrefix(patch), throwOnError: true })
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
