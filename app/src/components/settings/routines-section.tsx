import { RoutinesList } from "@/components/routines/routines-list";

/**
 * A person's own standing instructions: what runs on a schedule, and a switch to stop one.
 *
 * THERE IS DELIBERATELY NO CREATE AND NO EDIT FORM HERE. Turning a sentence into a cron expression
 * and a channel is conversational work — ask a Bot in a channel, "every weekday at 9, post the
 * standup notes here" — and that is exactly what a conversation is for. This block answers a
 * narrower question: what is standing right now, and does it stay standing. It shows and it stops;
 * it does not compose. Absent on purpose, not an omission.
 *
 * The last block of Settings › Bots (`/settings/bots#routines`); it used to be the `/routines` page.
 * `embedded` drops the list's own page-section margin, since the block supplies the spacing.
 */
export function RoutinesSection() {
  return <RoutinesList embedded />;
}
