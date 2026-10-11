import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { addTemplateMutationOptions } from "@/lib/agents/mutations";
import {
  type BotTemplate,
  templateListQueryOptions,
} from "@/lib/agents/queries";

/**
 * A Bot template's page, over the Marketplace: Grok Bot's bot page, as a dialog.
 *
 * A 72px mark, the name, "By Creator", the description with Show more, and "Add Bot"; then the
 * four tabs Grok Bot captions the same way — how it should work, the playbooks it runs, the jobs
 * that run on their own, the apps it uses. An app row says whether this deployment has it, and
 * leads to the Apps tab searched by its name where it does not.
 */
const SECTIONS = [
  {
    id: "instructions",
    name: "Instructions",
    caption: "How this Bot should work",
  },
  { id: "skills", name: "Skills", caption: "Playbooks it can run" },
  { id: "routines", name: "Routines", caption: "Jobs that run on their own" },
  { id: "apps", name: "Apps", caption: "Apps it can use" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SHORT_DESCRIPTION = 220;

export function TemplateDialog({
  templateId,
  open,
  onClose,
  onAdded,
}: {
  templateId: string | null;
  open: boolean;
  onClose: () => void;
  onAdded: (agentId: string) => void;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[680px] md:max-w-[640px]">
        {templateId ? (
          <TemplateDialogBody
            key={templateId}
            onAdded={onAdded}
            templateId={templateId}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TemplateDialogBody({
  templateId,
  onAdded,
}: {
  templateId: string;
  onAdded: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const templates = useQuery(templateListQueryOptions());
  const [section, setSection] = useState<SectionId>("instructions");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    ...addTemplateMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: (agent) => onAdded(agent.id),
  });

  const template: BotTemplate | undefined = templates.data?.find(
    (candidate) => candidate.id === templateId,
  );
  if (templates.isPending) return null;
  if (!template) {
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        That template is not here any more.
      </p>
    );
  }
  const long = template.description.length > SHORT_DESCRIPTION;
  const description =
    long && !expanded
      ? `${template.description.slice(0, SHORT_DESCRIPTION).trimEnd()}…`
      : template.description;

  return (
    <div className="flex max-h-[85svh] flex-col overflow-y-auto p-6">
      <div className="flex items-start gap-4">
        <NoeBotAvatar
          color={template.avatar.color}
          expression={template.avatar.expression}
          name={template.name}
          seed={template.id}
          size={72}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle className="text-xl font-semibold">
            {template.name}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">By {template.creator}</p>
        </div>
        <Button
          disabled={add.isPending}
          onClick={() => {
            setError(null);
            add.mutate(template.id);
          }}
          size="sm"
          type="button"
        >
          {add.isPending ? "Adding…" : "Add Bot"}
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-4 text-sm text-pretty">
        {description}
        {long ? (
          <button
            className="ml-1 text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </p>

      <Tabs
        className="mt-6"
        onValueChange={(value) => setSection(value as SectionId)}
        value={section}
      >
        <TabsList activateOnFocus variant="underline">
          {SECTIONS.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {SECTIONS.map((item) => (
          <TabsPanel className="pt-4" key={item.id} value={item.id}>
            <p className="mb-3 text-xs font-medium text-muted-foreground">
              {item.caption}
            </p>
            {item.id === "instructions" ? (
              <pre className="whitespace-pre-wrap rounded-lg bg-muted/60 p-4 text-sm">
                {template.instructions}
              </pre>
            ) : item.id === "skills" ? (
              template.skills.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm">
                  {template.skills.map((slug) => (
                    <li key={slug}>
                      <code>/{slug}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No playbooks: it works from its instructions alone.
                </p>
              )
            ) : item.id === "routines" ? (
              template.routines.length > 0 ? (
                <ul className="flex flex-col gap-2 text-sm">
                  {template.routines.map((routine) => (
                    <li key={routine.name}>
                      <span className="font-medium">{routine.name}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {routine.summary}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No standing jobs. Ask it to set one up once it is yours.
                </p>
              )
            ) : template.apps.length > 0 ? (
              <ul className="flex flex-col gap-2 text-sm">
                {template.apps.map((app) => (
                  <li className="flex items-center gap-3" key={app.key}>
                    <span className="flex size-8 items-center justify-center rounded-lg bg-muted/60 [&_img]:size-5 [&_svg]:size-4">
                      <PluginLogo logo={app.logoUrl} />
                    </span>
                    <span className="flex-1">{app.title}</span>
                    {app.installed ? (
                      <span className="text-xs text-muted-foreground">
                        Here
                      </span>
                    ) : (
                      <Link
                        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                        search={{ tab: "apps", q: app.title }}
                        to="/marketplace"
                      >
                        Add from Apps
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No apps: it works from what you tell it.
              </p>
            )}
          </TabsPanel>
        ))}
      </Tabs>
    </div>
  );
}
