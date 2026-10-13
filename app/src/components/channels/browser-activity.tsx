import { PendingApprovals } from "@/components/approvals/inline-approval";
import {
  RecoveryCard,
  useBotScreen,
} from "@/components/chat-cards/recovery-card";
import { PausedTaskCard } from "@/components/computer/handoff-resume-notice";
import { useActiveBotId } from "@/lib/copilot/active-bot";
import { useUiStrings } from "@/lib/i18n/strings";
import type { VisibleChatItem } from "./chat-messages";
import { ToolLine } from "./tool-line";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;
export type BrowserGroup = {
  kind: "browser";
  id: string;
  steps: BrowserStep[];
};
export type TranscriptItem = VisibleChatItem | BrowserGroup;

const labels: Record<string, string> = {
  computer_navigate: "Opened page",
  computer_read: "Read page",
  computer_snapshot: "Inspected page",
  computer_click: "Clicked on page",
  computer_type: "Filled in field",
  computer_key: "Pressed key",
  computer_scroll: "Scrolled page",
};

/** Group adjacent browsing steps without moving messages or hiding requests for human help. */
export function groupBrowserSteps(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  for (const item of items) {
    if (
      item.kind !== "tool" ||
      !Object.hasOwn(labels, item.toolCall.function.name)
    ) {
      grouped.push(item);
      continue;
    }
    const last = grouped.at(-1);
    if (last?.kind === "browser") last.steps.push(item);
    else grouped.push({ kind: "browser", id: item.id, steps: [item] });
  }
  return grouped;
}

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function browserStepDetails(step: BrowserStep) {
  const result = objectOf(step.result);
  const args = objectOf(step.toolCall.function.arguments);
  const navigation = step.toolCall.function.name === "computer_navigate";
  const rawUrl = navigation ? (result.url ?? args.url) : undefined;
  let url: URL | undefined;
  try {
    if (typeof rawUrl === "string") {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        url = parsed;
    }
  } catch {
    /* A partial streaming URL is not a link yet. */
  }
  /*
   * NOT EVERY "NO" IS A PROBLEM. The server answers 409 for two things the prompt tells the Bot are
   * not errors: a person holds the wheel (the Bot waits and carries on once they hand back), and the
   * page moved under a ref (the Bot takes a fresh snapshot and clicks again). A fresh snapshot after
   * a handback is the safety rule working too. All three are shown, muted, as what happened, and
   * none counts as an issue: a group that read "2 issues" for a Bot doing exactly what it should
   * taught people to ignore the count.
   */
  const resnapshot =
    typeof result.reason === "string" &&
    /fresh browser snapshot after handback/i.test(result.reason);
  const neutral: "person-control" | "page-changed" | undefined =
    result.humanHasControl === true
      ? "person-control"
      : resnapshot || result.staleRefs === true
        ? "page-changed"
        : undefined;
  const failed =
    neutral === undefined &&
    (result.ok === false ||
      result.refused === true ||
      step.result?.startsWith("Error:") === true);
  return {
    name: step.toolCall.function.name,
    label: labels[step.toolCall.function.name],
    href: url?.href,
    title:
      navigation && typeof result.title === "string" && result.title.trim()
        ? result.title
        : url?.hostname,
    failed,
    neutral,
    reason: typeof result.reason === "string" ? result.reason : undefined,
    visited: navigation && result.ok === true,
    pending: step.result === undefined,
  };
}

export function BrowserActivity({
  group,
  active,
}: {
  group: BrowserGroup;
  active: boolean;
}) {
  const ui = useUiStrings();
  const steps = group.steps.map((step) => ({
    id: step.id,
    ...browserStepDetails(step),
  }));
  const pages = steps.filter((step) => step.visited).length;
  const issues = steps.filter((step) => step.failed).length;
  const firstIssue = steps
    .find((step) => step.failed && step.reason)
    ?.reason?.slice(0, 120);
  const running = active && steps.some((step) => step.pending);
  /*
   * THE WAY FORWARD, WHEN THE BROWSING ENDED ON A FAILURE: the last step that finished did not
   * work. An issue the Bot got past (a click that missed, then one that landed) is still counted and
   * still readable in the steps, but offering Take over for it would be a button for a problem that
   * is already solved.
   */
  const lastSettled = steps.findLast((step) => !step.pending);
  const stuck = !running && issues > 0 && lastSettled?.failed === true;
  const stuckReason = lastSettled?.reason?.slice(0, 200) ?? firstIssue;
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      <ToolLine
        actions={stuck ? <BrowserRecovery reason={stuckReason} /> : undefined}
        label={
          running
            ? ui.browsing
            : pages
              ? ui.browsedPages(pages)
              : ui.browserActivity
        }
        detail={
          // The first issue's own sentence on the folded line, so what went wrong is read without
          // opening it ("1 issue" alone hid a refused click and a page that never loaded). Once the
          // card under the line says it, the line keeps the count.
          issues
            ? `${ui.issues(issues)}${firstIssue && !stuck ? `: ${firstIssue}` : ""}`
            : undefined
        }
        running={running}
      >
        <ol className="space-y-2 py-1">
          {steps.map((step) => (
            <li key={step.id} className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-muted-foreground">
                  {ui.browserSteps[step.name] ?? step.label}
                </span>
                {step.href ? (
                  <a
                    href={step.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
                  >
                    {step.title ?? step.href}
                  </a>
                ) : null}
                {step.pending && (
                  <span className="text-muted-foreground">
                    {active ? ui.inProgress : ui.notCompleted}
                  </span>
                )}
              </div>
              {step.failed && (
                <p className="mt-0.5 text-destructive">
                  {step.reason ?? ui.stepFailed}
                </p>
              )}
              {step.neutral && (
                <p
                  className="mt-0.5 text-muted-foreground"
                  data-neutral={step.neutral}
                >
                  {step.neutral === "person-control"
                    ? ui.personHadControl
                    : ui.pageChanged}
                </p>
              )}
            </li>
          ))}
        </ol>
      </ToolLine>
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
      <PausedTaskCard
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}

/** Take over and Open screen under a group whose browsing ended on a failure. */
function BrowserRecovery({ reason }: { reason?: string }) {
  const ui = useUiStrings();
  const screen = useBotScreen(useActiveBotId());
  return (
    <RecoveryCard
      compact
      detail={reason}
      onOpenScreen={screen.openScreen}
      onTakeOver={() => void screen.takeOver()}
      title={ui.browserProblem}
      {...(screen.taking ? { busy: "takeOver" as const } : {})}
    />
  );
}
