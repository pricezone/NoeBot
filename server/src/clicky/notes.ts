import type { ClickySession } from "../../../shared/clicky";
import { PERSON_INITIATOR } from "../audit";
import type { ComputerGateway } from "../computer/gateway";

/**
 * Clicky's notes: what the person and Clicky did together, written into the Bot's workspace so the
 * Bot (and the person) can read it later. One Markdown file per session and day, under
 * `clicky-notes/` in the workspace, written through the gateway's file path like any workspace
 * write, so the boundary and the audit trail see it.
 *
 * The notes hold the goal, the steps and how far they got, the conversation, and what Clicky did.
 * Never anything typed: an action is described by its label and kind, not its text.
 */

export const CLICKY_NOTES_FOLDER = "clicky-notes";

export function notesPath(session: ClickySession, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${CLICKY_NOTES_FOLDER}/${day}-${session.id}.md`;
}

/** One line of Markdown, so a step title or a turn cannot start a heading or break the list. */
function line(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function notesMarkdown(
  session: ClickySession,
  actions: readonly {
    at: string;
    label: string;
    kind: string;
    outcome: string;
  }[],
  now: number,
): string {
  const parts: string[] = [
    `# Clicky notes, ${new Date(now).toISOString().slice(0, 10)}`,
    "",
  ];
  const walkthrough = session.walkthrough;
  if (walkthrough) {
    parts.push(`## Goal`, "", line(walkthrough.goal), "", "## Steps", "");
    walkthrough.steps.forEach((step, index) => {
      const mark =
        step.status === "done" ? "x" : step.status === "skipped" ? "-" : " ";
      parts.push(
        `${index + 1}. [${mark}] ${line(step.title)}${step.status === "current" ? " (current)" : ""}${step.detail ? ` — ${line(step.detail)}` : ""}`,
      );
    });
    parts.push("");
  }
  if (session.transcript.length > 0) {
    parts.push("## Conversation", "");
    for (const turn of session.transcript)
      parts.push(
        `- ${turn.at} **${turn.role === "person" ? "Person" : "Clicky"}:** ${line(turn.text)}`,
      );
    parts.push("");
  }
  if (actions.length > 0) {
    parts.push("## What Clicky did", "");
    for (const action of actions)
      parts.push(
        `- ${action.at} ${action.kind}: ${line(action.label)} (${action.outcome})`,
      );
    parts.push("");
  }
  if (!walkthrough && session.transcript.length === 0 && actions.length === 0)
    parts.push("Nothing happened in this session yet.", "");
  return parts.join("\n");
}

export async function writeNotes(input: {
  gateway: Pick<ComputerGateway, "writeFile">;
  userId: string;
  botId: string;
  session: ClickySession;
  actions: readonly {
    at: string;
    label: string;
    kind: string;
    outcome: string;
  }[];
  now: number;
}): Promise<string> {
  const path = notesPath(input.session, input.now);
  await input.gateway.writeFile(
    input.botId,
    { id: input.userId, userId: input.userId, initiator: PERSON_INITIATOR },
    { path, contents: notesMarkdown(input.session, input.actions, input.now) },
  );
  return path;
}
