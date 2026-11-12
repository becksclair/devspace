import type { ReactNode } from "react";
import type { IconName } from "./tool-display.js";

function IconSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="icon-svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {children}
    </svg>
  );
}

const TOOL_ICON_PATHS: Record<IconName, ReactNode> = {
  folder: (
    <>
      <path d="M3 7.5h6l2 2h10" />
      <path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />
    </>
  ),
  file: (
    <>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </>
  ),
  filePlus: (
    <>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M12 12v6" />
      <path d="M9 15h6" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  files: (
    <>
      <path d="M8 7V4h9l4 4v10h-3" />
      <path d="M12 4v5h5" />
      <path d="M4 7h9l4 4v10H4z" />
      <path d="M13 7v5h4" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 17h7" />
    </>
  ),
  review: (
    <>
      <path d="M5 4h14v16H5z" />
      <path d="M8 8h8" />
      <path d="M8 12h5" />
      <path d="M8 16h7" />
    </>
  ),
};

export function ToolIcon({ name }: { name: IconName }) {
  return <IconSvg>{TOOL_ICON_PATHS[name]}</IconSvg>;
}

export function ChevronIcon() {
  return (
    <IconSvg>
      <path d="m6 9 6 6 6-6" />
    </IconSvg>
  );
}

export function CheckCircleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="badge-icon"
      fill="none"
      viewBox="0 0 16 16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8 1.7 1.7 3.4-3.5" />
    </svg>
  );
}
