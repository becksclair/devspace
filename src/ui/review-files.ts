// How the review card labels each changed file. Pure, so it is unit-testable in Node.

export type ReviewChangeKind = "added" | "modified" | "deleted" | "renamed" | "binary";

export interface ReviewFileDisplay {
  kind: ReviewChangeKind;
  /** The previous path of a renamed file. */
  previousPath?: string;
  /** False for pure renames and binary changes, which have no line counts to show. */
  showStats: boolean;
  /** False when there are no hunks to open. */
  expandable: boolean;
}

/** True for a file section of a Git patch that carries a binary change. */
export function isBinaryPatchSection(section: string | undefined): boolean {
  return section !== undefined && (/^GIT binary patch$/m.test(section) || /^Binary files .* differ$/m.test(section));
}

/**
 * Describes one parsed file of a review patch. `type` is the change type of the parsed file
 * (the same values as the result's per-file `type`); `section` is that file's part of the patch.
 */
export function reviewFileDisplay(
  file: { type: string; prevName?: string; name: string; hunkCount: number },
  section: string | undefined,
): ReviewFileDisplay {
  const binary = isBinaryPatchSection(section);
  const renamed = file.type === "rename-pure" || file.type === "rename-changed";
  const kind: ReviewChangeKind = binary
    ? "binary"
    : file.type === "new"
      ? "added"
      : file.type === "deleted"
        ? "deleted"
        : renamed
          ? "renamed"
          : "modified";
  return {
    kind,
    previousPath: renamed && file.prevName && file.prevName !== file.name ? file.prevName : undefined,
    showStats: !binary && file.type !== "rename-pure",
    expandable: file.hunkCount > 0,
  };
}
