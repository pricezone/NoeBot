import { ActivityLog } from "@/components/computer/activity-log";
import { ComputerView } from "@/components/computer/computer-view";
import { noteComputerActivity } from "@/lib/computers/use-computer-sleep";

/**
 * The Bot's screen, live, with what it has been doing underneath.
 *
 * The card is the existing `ComputerView` as a preview: the screen and its caption, with no wheel
 * of its own (`controls={false}`). Clicking it opens the full-window viewer, where Take control and
 * Record your steps are; when the Bot asks for help the card says so and offers Open screen. It is
 * sized by the panel rather than by its own minimums, so a 320px panel gets a 16:10 card that
 * fits. `paused` stops the frame polling while another tab is in front: the panel keeps this
 * mounted so a switch back is instant, and a hidden card must not keep a request a second going.
 *
 * `openExpanded` opens the viewer without the click — the Skills tab's "Record skill" arrives
 * that way, so the person lands with Record your steps in front of them — and `onOpened` says
 * when it has, so the page can drop the request from its address.
 *
 * The card SLEEPS when nobody is using the computer (`sleeps`, see `use-computer-sleep.ts`): it
 * stops asking for frames and shows the Bot dozing with a Wake button. A click or a key anywhere in
 * this tab is somebody using it, and so is the viewer it opens, which is inside this tree for React
 * events even though it is portalled to the body.
 */
export function ComputerTab({
  agentId,
  name,
  paused,
  openExpanded,
  onOpened,
}: {
  agentId: string;
  name: string;
  paused: boolean;
  openExpanded?: boolean;
  onOpened?: () => void;
}) {
  const used = () => noteComputerActivity(agentId);
  return (
    <section
      aria-label="Computer sidebar"
      className="flex flex-col gap-6"
      onClickCapture={used}
      onKeyDownCapture={used}
    >
      <ComputerView
        active
        caption={`${name}'s screen`}
        computerId={agentId}
        controls={false}
        minHeight={0}
        minWidth={0}
        name={name}
        onExpandedOnce={onOpened}
        openExpanded={openExpanded}
        paused={paused}
        sleeps
      />
      <div>
        <h3 className="mb-2 font-medium text-sm">Activity</h3>
        <ActivityLog computerId={agentId} />
      </div>
    </section>
  );
}
