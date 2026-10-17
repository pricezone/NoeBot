import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { SelfProfileCard } from "@/components/chat-cards/self-profile-card";
import { SELF_PROFILE_TOOL } from "../../../../shared/self-profile";

/**
 * How a Bot naming itself reads in the transcript.
 *
 * RENDER ONLY, like `escalation-tool.tsx`: `update_my_profile` runs on the server, through the same
 * write as the profile form. Drawn as a raw call with its arguments as JSON, a rename would be easy
 * to miss and impossible to take back from where it happened.
 */
const parameters = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
});

export function SelfProfileTool() {
  useRenderTool({
    name: SELF_PROFILE_TOOL,
    parameters,
    render: ({ parameters: given, result, status, toolCallId }) => (
      <SelfProfileCard
        name={given?.name}
        result={result}
        running={status !== "complete" && result === undefined}
        toolCallId={toolCallId}
      />
    ),
  });

  return null;
}
