import { ActivityLog } from "@/components/computer/activity-log";
import { ComputerView } from "@/components/computer/computer-view";

/**
 * The Bot's screen, live, with what it has been doing underneath.
 *
 * The card is the existing `ComputerView` — its footer keeps the wheel, and clicking the frame
 * opens the full-size viewer — sized by the panel rather than by its own minimums, so a 320px
 * panel gets a 16:10 card that fits. `paused` stops the frame polling while another tab is in
 * front: the panel keeps this mounted so a switch back is instant, and a hidden card must not
 * keep a request a second going.
 */
export function ComputerTab({
  agentId,
  name,
  paused,
}: {
  agentId: string;
  name: string;
  paused: boolean;
}) {
  return (
    <section aria-label="Computer sidebar" className="flex flex-col gap-6">
      <ComputerView
        active
        caption={`${name}'s screen`}
        computerId={agentId}
        minHeight={0}
        minWidth={0}
        name={name}
        paused={paused}
      />
      <div>
        <h3 className="mb-2 font-medium text-sm">Activity</h3>
        <ActivityLog computerId={agentId} />
      </div>
    </section>
  );
}
