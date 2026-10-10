import { AccessSection } from "@/components/agents/agent-dialog";
import { RecordedWorkflows } from "@/components/computer/demonstration-recorder";
import { FilesSection } from "./files-section";

/**
 * What this Bot has to work with: its files, the workflows recorded on its screen, then the
 * connectors and skills it may reach.
 *
 * Files lead, as in Grok's Library: what was attached in its conversations and what it saved on its
 * computer, newest first (`FilesSection`). The access list already exists in the Bot's dialog; this
 * draws it beside the conversation, where "what can it do" is asked. Recorded workflows are made in
 * the screen viewer (Record your steps) and kept here. The routines moved to Details, beside the
 * other things the Bot does for you.
 */
export function LibraryTab({ agentId }: { agentId: string }) {
  return (
    <div className="flex w-full flex-col gap-6">
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Files
        </h2>
        <FilesSection agentId={agentId} />
      </section>
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recorded workflows
        </h2>
        <RecordedWorkflows botId={agentId} />
      </section>
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Access
        </h2>
        <AccessSection agentId={agentId} />
      </section>
    </div>
  );
}
