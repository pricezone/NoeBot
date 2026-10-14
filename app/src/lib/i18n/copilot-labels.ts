import type { CopilotChatLabels } from "@copilotkit/react-core/v2";
import { useMemo } from "react";
import { useTranslation } from "./index";

/**
 * The CopilotKit chat's own words, in the interface's language.
 *
 * The SDK draws some text itself (the packaged chat's placeholder, its toolbars, its disclaimer) and
 * takes them as `labels`. Every label is listed, not a partial set: a CopilotKit upgrade that adds a
 * label is then a type error here rather than a stray English word in a Greek interface. The English
 * keys are the SDK's own defaults, so English reads as it always did.
 */
export function useCopilotChatLabels(): CopilotChatLabels {
  const { t } = useTranslation();
  return useMemo(
    (): Record<keyof CopilotChatLabels, string> => ({
      chatInputPlaceholder: t("Type a message..."),
      chatInputToolbarStartTranscribeButtonLabel: t("Transcribe"),
      chatInputToolbarCancelTranscribeButtonLabel: t("Cancel"),
      chatInputToolbarFinishTranscribeButtonLabel: t("Finish"),
      chatInputToolbarAddButtonLabel: t("Add attachments"),
      chatInputToolbarToolsButtonLabel: t("Tools"),
      assistantMessageToolbarCopyCodeLabel: t("Copy"),
      assistantMessageToolbarCopyCodeCopiedLabel: t("Copied"),
      assistantMessageToolbarCopyMessageLabel: t("Copy"),
      assistantMessageToolbarInspectorLabel: t("View in Inspector"),
      assistantMessageToolbarInspectorDescription: t(
        "Open this message in the Inspector",
      ),
      assistantMessageToolbarInspectorLocalOnlyLabel: t("Local only"),
      assistantMessageToolbarInspectorLocalOnlyDescription: t(
        "Only visible on localhost or loopback hosts in development. Never shown in production.",
      ),
      assistantMessageToolbarInspectorTitle: t("CopilotKit Inspector"),
      assistantMessageToolbarInspectorHideLabel: t("Hide this icon"),
      assistantMessageToolbarInspectorHideDescription: t(
        "Until you reload this page",
      ),
      assistantMessageToolbarThumbsUpLabel: t("Good response"),
      assistantMessageToolbarThumbsDownLabel: t("Bad response"),
      assistantMessageToolbarReadAloudLabel: t("Read aloud"),
      assistantMessageToolbarRegenerateLabel: t("Regenerate"),
      userMessageToolbarCopyMessageLabel: t("Copy"),
      userMessageToolbarEditMessageLabel: t("Edit"),
      chatDisclaimerText: t(
        "AI can make mistakes. Please verify important information.",
      ),
      chatToggleOpenLabel: t("Open chat"),
      chatToggleCloseLabel: t("Close chat"),
      modalHeaderTitle: t("CopilotKit Chat"),
      welcomeMessageText: t("How can I help you today?"),
    }),
    [t],
  );
}
