import { AccessSection } from "@/components/agents/agent-dialog";
import { RecordedWorkflows } from "@/components/computer/demonstration-recorder";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * What this Bot has to work with: its routines, the workflows recorded on its screen, then the
 * connectors and skills it may reach.
 *
 * The routines and access lists already exist in the Bot's dialog; this draws them beside the
 * conversation, where "what can it do" is asked. `embedded` on the routines list drops the page
 * section's own top margin, which is somebody else's spacing here as it is in the dialog. Recorded
 * workflows are made in the screen viewer (Record your steps) and kept here.
 */
export function LibraryTab({ agentId }: { agentId: string }) {
  return (
    <div className="flex w-full flex-col gap-6">
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Routines
        </h2>
        <RoutinesList agentId={agentId} embedded />
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
