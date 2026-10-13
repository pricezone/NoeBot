import type { TranscriptItem } from "@/components/channels/browser-activity";
import type { BrowserStep } from "./director";
import { isBrowserTool } from "./tool-map";

const okOf = (result: string | undefined): boolean => {
  if (result === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      parsed.ok === true
    );
  } catch {
    return false;
  }
};

/**
 * The browser steps of the turn in flight, newest last, for the director: every `computer_*`
 * browser call since the person last spoke, whether the transcript folded it into a browser group
 * or drew it on its own line (a sign-in request, a step the group does not list). `browsing` says
 * whether the newest one is the last thing in the transcript.
 */
export function browserActivityOf(
  items: readonly TranscriptItem[],
  limit = 16,
): { steps: BrowserStep[]; browsing: boolean } {
  const steps: BrowserStep[] = [];
  let browsing = false;
  for (let i = items.length - 1; i >= 0 && steps.length < limit; i--) {
    const item = items[i];
    if (
      !item ||
      item.kind === "attachments" ||
      (item.kind === "text" && item.role === "user")
    )
      break;
    const calls =
      item.kind === "browser" ? item.steps : item.kind === "tool" ? [item] : [];
    for (let j = calls.length - 1; j >= 0 && steps.length < limit; j--) {
      const call = calls[j];
      const tool = call?.toolCall.function.name;
      if (!call || !tool || !isBrowserTool(tool)) continue;
      if (steps.length === 0 && i === items.length - 1) browsing = true;
      steps.push({
        id: call.id,
        tool,
        running: call.result === undefined,
        ok: okOf(call.result),
      });
    }
  }
  return { steps: steps.reverse(), browsing };
}
