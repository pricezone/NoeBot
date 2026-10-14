import type { RoutineStatus } from "./api";
import { intlLocale, msg, t } from "./i18n";
import { colors } from "./ui";

/** Run history in the words the routine page uses: Running, Succeeded, Failed. English keys, said with `t`. */
export const RUN_LABELS: Record<RoutineStatus, string> = {
  running: msg("Running"),
  succeeded: msg("Succeeded"),
  failed: msg("Failed"),
  skipped: msg("Skipped"),
  waiting: msg("Waiting for you"),
};
export const RUN_COLORS: Record<RoutineStatus, string> = {
  running: colors.link,
  succeeded: colors.success,
  failed: colors.error,
  skipped: colors.muted,
  waiting: colors.warning,
};
export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(intlLocale()) : t("Not yet");
/** "Add routine" opens the Bot's conversation with this sentence started for the person to finish. */
export const ADD_ROUTINE_DRAFT = msg("Set up a routine to ");
