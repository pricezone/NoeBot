import { RecordedWorkflows } from "@/components/computer/demonstration-recorder";
import { useTranslation } from "@/lib/i18n";
import { FilesSection } from "./files-section";

/**
 * What this Bot has to work with: its files and the workflows recorded on its screen.
 *
 * Files lead, as in Grok's Library: what was attached in its conversations and what it saved on its
 * computer, newest first (`FilesSection`). Recorded workflows are made in the screen viewer (Record
 * your steps) and kept here. The routines moved to Details, beside the other things the Bot does
 * for you; the connectors and skills it may reach (Access) live in Bot Settings.
 */
export function LibraryTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-6">
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Files")}
        </h2>
        <FilesSection agentId={agentId} />
      </section>
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Recorded workflows")}
        </h2>
        <RecordedWorkflows botId={agentId} />
      </section>
    </div>
  );
}
