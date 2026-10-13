import type { ComputerGateway } from "./gateway";
import type { PageFrameStore } from "./page-frames";

/**
 * Showing the person what the Bot has on screen, as a picture in the conversation.
 *
 * Grok Bot posts a screenshot of a form's preview before it asks whether to submit it, so the person
 * decides on the page itself rather than on the Bot's retelling of it. A Bot here had no way to do
 * that: told to "show the preview (a screenshot)", it rebuilt the page as a generated interface
 * instead, which drew raw JSON and a loading skeleton in the gov.gr run (O19).
 *
 * The picture is kept as the tool call's page frame, the same row a navigation keeps, so the
 * transcript reads it back through the route it already has, a reload shows it, and it goes when
 * the profile is wiped or the frame retention window passes. Nothing about the picture travels back
 * to the Bot but where it was taken: a screenshot in a tool result would be sent to the model on
 * every later turn.
 */

export type ShowScreenResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export async function showScreen(
  deps: {
    gateway: Pick<ComputerGateway, "status" | "screenshot" | "provider">;
    pageFrames?: PageFrameStore;
  },
  botId: string,
  toolCallId: string,
): Promise<ShowScreenResult> {
  const { gateway, pageFrames } = deps;
  if (!pageFrames) {
    return {
      ok: false,
      reason:
        "This deployment keeps no pictures of pages, so the screen cannot be shown in the chat. Describe what the page says instead.",
    };
  }
  /*
   * Only a computer that is up. A screenshot resumes a suspended one, and a picture of a browser
   * that has just started shows its start page rather than the form the Bot meant to show.
   */
  const status = await gateway.status(botId);
  if (status.state !== "ready") {
    return {
      ok: false,
      reason: `Your computer is ${status.state}, so there is nothing on screen to show. Open the page first.`,
    };
  }
  const shot = await gateway.screenshot(botId);
  if (shot.url === "about:blank") {
    return {
      ok: false,
      reason: "Nothing is open in your browser yet. Open the page first.",
    };
  }
  /*
   * On one computer shared by every Bot, a picture that does not say which page it is of could be
   * another Bot's: the same guard the navigation frame applies.
   */
  if (shot.url === undefined && gateway.provider.isolation !== "per-bot") {
    return {
      ok: false,
      reason:
        "This computer is shared and the screenshot did not say which page it is of, so it was not shown.",
    };
  }
  const url = shot.url ?? "this page";
  await pageFrames.save({
    computerId: botId,
    toolCallId,
    url,
    frame: shot.base64,
  });
  // The store refuses an oversized frame with a log line and no error, so ask it what it kept.
  if (!(await pageFrames.load(botId, toolCallId))) {
    return {
      ok: false,
      reason:
        "The picture of this page could not be kept, so it was not shown. Describe what the page says instead.",
    };
  }
  return { ok: true, url };
}
