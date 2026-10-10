import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCalendarRepeat,
  IconPlug,
  IconWorldSearch,
} from "@tabler/icons-react";
import type * as React from "react";

/**
 * The mark each catalogue vendor is drawn with, on every screen that lists one.
 *
 * The catalogue carries no logo of its own on the wire — only a brokered row does — so the mark
 * is chosen here, by key. Three screens used to hold this table apiece, two icons each, and a
 * vendor added to the catalogue appeared on all three as a plug until somebody noticed. One
 * table, imported by all of them, is the fix; it lives beside the plugin components rather than
 * in a route file so the Marketplace can read it without pulling a settings page into its chunk.
 *
 * A brand mark where Tabler ships one, a generic mark that says what the vendor does where it
 * does not: both Parallel entries are web search, and Routines is a schedule. Anything the table
 * has never heard of — a server an administrator added by URL, or a vendor newer than this file —
 * draws as a plug.
 */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
  parallel: IconWorldSearch,
  "parallel-oauth": IconWorldSearch,
  "parallel-authenticated": IconWorldSearch,
  routines: IconCalendarRepeat,
};

/** The mark for one catalogue key, or a plug for a key this table does not know. */
export function catalogueMarkFor(
  key: string,
): React.ComponentType<{ className?: string }> {
  return MARKS[key] ?? IconPlug;
}
