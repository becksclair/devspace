// Shared highlighter setup for the lazily loaded code and diff renderers. Import it only from
// those modules: it pulls in @pierre/diffs, which must stay out of the initial bundle.

import { useEffect, useState } from "react";
import { preloadHighlighter, type SupportedLanguages } from "@pierre/diffs";
import { PREFERRED_HIGHLIGHTER, renderFailureMessage } from "./render-fallback.js";

export const CODE_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

/**
 * Loads the shared highlighter with the widget's themes and the given language and returns a
 * failure message when that fails. The diff components only log such a failure and then render an
 * empty body, so callers use this to switch to a plain-text fallback instead.
 */
export function useHighlighterFailure(lang: SupportedLanguages | undefined): string | null {
  const [failure, setFailure] = useState<{ lang: SupportedLanguages | undefined; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    preloadHighlighter({
      themes: [CODE_THEMES.light, CODE_THEMES.dark],
      langs: lang ? ["text", lang] : ["text"],
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
    }).catch((error: unknown) => {
      if (active) setFailure({ lang, message: renderFailureMessage(error) });
    });
    return () => {
      active = false;
    };
  }, [lang]);

  return failure !== null && failure.lang === lang ? failure.message : null;
}
