import { Component, type ReactNode } from "react";
import { renderFailureMessage } from "./render-fallback.js";

export type ThemeType = "light" | "dark";

export function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}

/** A visible error line followed by the content as plain text. */
export function PlainFallback({
  message,
  text,
  tool,
}: {
  message: string;
  text: string;
  tool: string;
}) {
  return (
    <>
      <div className="status error" role="alert">{message}</div>
      {text ? <pre className={`text-payload ${tool}`}>{text}</pre> : null}
    </>
  );
}

interface BoundaryProps {
  /** Plain text to show when rendering fails. */
  fallbackText: string;
  tool: string;
  children: ReactNode;
}

/** Catches render failures in the code and diff renderers and shows a plain-text fallback. */
export class PayloadErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error("Unknown rendering error.") };
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.error !== undefined && previous.fallbackText !== this.props.fallbackText) {
      this.setState({ error: undefined });
    }
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <PlainFallback
        message={renderFailureMessage(this.state.error)}
        text={this.props.fallbackText}
        tool={this.props.tool}
      />
    );
  }
}
