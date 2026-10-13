import { Component, Fragment, type ReactNode } from "react";
import { RecoveryCard } from "@/components/chat-cards/recovery-card";
import { useUiStrings } from "@/lib/i18n/strings";

/**
 * A component that throws must not take the conversation with it.
 *
 * Browser-authored components render in the transcript from model-supplied arguments, sometimes
 * while a tool call is still streaming. A render failure is isolated to the component card and shown
 * as a recovery card; stacks stay in the developer console.
 *
 * RETRY REMOUNTS. Most of these failures are a card handed half an argument mid-stream, which the
 * finished arguments draw fine; Retry clears the failure and mounts the children afresh (a new key,
 * so nothing of the broken instance's state is reused). One that throws again lands back here.
 */
export class ToolRenderBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Keep stack details out of the conversation while preserving them for component authors.
    console.error(
      "[gallery] a component failed to render",
      this.props.name,
      error,
    );
  }

  retry = () => {
    this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <RenderFailed name={this.props.name} onRetry={this.retry} />;
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

/** The boundary's card, a function so it can read the conversation's language. */
function RenderFailed({
  name,
  onRetry,
}: {
  name: string;
  onRetry: () => void;
}) {
  const ui = useUiStrings();
  return (
    <RecoveryCard
      compact
      detail={ui.renderCrashDetail}
      onRetry={onRetry}
      testId="tool-render-failed"
      title={ui.renderCrash(name)}
    />
  );
}
