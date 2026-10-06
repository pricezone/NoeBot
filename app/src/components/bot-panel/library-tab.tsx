import { AccessSection } from "@/components/agents/agent-dialog";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * What this Bot has to work with: its routines, then the connectors and skills it may reach.
 *
 * Both lists already exist in the Bot's dialog; this draws them beside the conversation, where
 * "what can it do" is asked. `embedded` on the routines list drops the page section's own top
 * margin, which is somebody else's spacing here as it is in the dialog.
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
          Access
        </h2>
        <AccessSection agentId={agentId} />
      </section>
    </div>
  );
}
