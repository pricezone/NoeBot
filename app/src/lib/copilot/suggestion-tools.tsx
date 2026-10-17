import { useHumanInTheLoop, useRenderTool } from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import {
  type OfferMarketplaceArgs,
  OfferMarketplaceCard,
  type OfferTemplateArgs,
  OfferTemplateCard,
} from "@/components/chat-cards/offer-cards";
import {
  agentKeys,
  agentQueryOptions,
  templateListQueryOptions,
} from "@/lib/agents/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { useTranslation } from "@/lib/i18n";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import {
  addMarketplaceItem,
  applyTemplate,
  connectPageFor,
  marketplaceItemQueryOptions,
  suggestionKeys,
} from "@/lib/suggestions/offers";
import {
  FIND_BOT_TEMPLATES_TOOL,
  FIND_MARKETPLACE_ITEMS_TOOL,
  OFFER_BOT_TEMPLATE_TOOL,
  OFFER_MARKETPLACE_ITEM_TOOL,
} from "../../../../shared/suggestions";

/**
 * Offering a Bot template or a Marketplace item from inside a conversation.
 *
 * The finders run on the server, where the Bot runs (`server/src/agents/suggestions.ts`), and are
 * only offered to a run when these two cards are registered: finding something there is no way to
 * offer would be a wasted step. The offers are cards because the person decides, and both write
 * through the routes the screens use, as the person, so access and the audit trail are theirs.
 *
 * WHY THE TEMPLATE OFFER WAITS ON `canManage`. Applying rewrites the Bot's instructions, which only
 * its owner or an administrator may do; a Bot the person cannot edit is not offered the tool, so it
 * never puts a card in front of somebody whose Yes would be refused.
 */

const offerTemplateParameters = z.object({
  templateId: z
    .string()
    .describe("The template's id, exactly as find_bot_templates answered it"),
  reason: z
    .string()
    .optional()
    .describe(
      "One short sentence, in the person's language, on why it fits this Bot",
    ),
});

const offerItemParameters = z.object({
  id: z
    .string()
    .describe("The item's id, exactly as find_marketplace_items answered it"),
  reason: z
    .string()
    .describe(
      "One short sentence, in the person's language, on why it fits this Bot's role or the task",
    ),
});

const findParameters = z.object({ query: z.string().optional() });

type OfferProps<A> = {
  args: Partial<A>;
  respond?: (result: unknown) => Promise<void>;
  result?: string;
};

/** The template card, with the template read by id and Apply going to the server as the person. */
function TemplateOffer({
  agentId,
  ...props
}: OfferProps<OfferTemplateArgs> & { agentId: string }) {
  const queryClient = useQueryClient();
  const templates = useQuery(templateListQueryOptions());
  const templateId = props.args.templateId ?? "";
  const template = templates.data
    ? (templates.data.find((candidate) => candidate.id === templateId) ?? null)
    : undefined;
  return (
    <OfferTemplateCard
      apply={async () => {
        const applied = await applyTemplate(templateId, agentId);
        // The Bot's name, avatar and skills just changed under every screen that shows them.
        void queryClient.invalidateQueries({ queryKey: agentKeys.all });
        void invalidatePlugins(queryClient);
        return applied;
      }}
      args={props.args}
      failed={templates.isError}
      respond={props.respond}
      result={props.result}
      template={template}
    />
  );
}

/** The Marketplace card, with the item described by this deployment, never by the model. */
function ItemOffer({
  agentId,
  ...props
}: OfferProps<OfferMarketplaceArgs> & { agentId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = props.args.id ?? "";
  const item = useQuery(marketplaceItemQueryOptions(id, agentId));
  return (
    <OfferMarketplaceCard
      add={async () => {
        if (!item.data) throw new Error(t("That plugin could not be added."));
        try {
          return await addMarketplaceItem(item.data, agentId);
        } finally {
          void invalidatePlugins(queryClient);
          void queryClient.invalidateQueries({
            queryKey: suggestionKeys.item(id, agentId),
          });
        }
      }}
      args={props.args}
      failed={item.isError}
      item={item.data}
      openConnect={() => {
        if (item.data) void navigate(connectPageFor(item.data));
      }}
      respond={props.respond}
      result={props.result}
    />
  );
}

export function SuggestionTools() {
  const { t } = useTranslation();
  const declared = useDeclaredBotId();
  const agentId = declared ?? "";
  const { data: agent } = useQuery({
    ...agentQueryOptions(agentId),
    enabled: agentId.length > 0,
  });

  /*
   * Stabilised with `useMemo` for the reason the gallery's decisions are: the render component is
   * identity-compared, and a fresh function every render remounts the card mid-answer.
   */
  const TemplateCard = useMemo(
    () =>
      function OfferTemplateRender(props: OfferProps<OfferTemplateArgs>) {
        return <TemplateOffer agentId={agentId} {...props} />;
      },
    [agentId],
  );
  const ItemCard = useMemo(
    () =>
      function OfferMarketplaceRender(props: OfferProps<OfferMarketplaceArgs>) {
        return <ItemOffer agentId={agentId} {...props} />;
      },
    [agentId],
  );

  useHumanInTheLoop({
    name: OFFER_BOT_TEMPLATE_TOOL,
    description: [
      "Offer the person a Bot template for this Bot, on a card they answer: apply it, decline, or answer in their own words.",
      "Applying gives this Bot the template's instructions, title and skills, and its avatar and name only where the person has not chosen their own.",
      "Call it with a templateId from find_bot_templates, only when the template clearly fits this Bot's role or the person's goal. Offer once per need and never again after a decline in this conversation.",
      "Mention that connecting the apps the template uses in the Marketplace later unlocks more. You are told what was applied, or that the person declined.",
    ].join(" "),
    parameters: offerTemplateParameters,
    available: agent?.canManage === true,
    render: TemplateCard,
  });

  useHumanInTheLoop({
    name: OFFER_MARKETPLACE_ITEM_TOOL,
    description: [
      "Offer the person a Marketplace item for this Bot, on a card they answer.",
      "A ready or optional item they can add to this Bot at once; for a needs-account item the card opens the page where they connect their account, and nothing is added from the chat.",
      "Call it with an id from find_marketplace_items, only when it clearly fits this Bot's role or the current task (writing code: Superpowers). Offer once per need and never again after a decline in this conversation.",
      "Say that configuring it later in the Marketplace, such as connecting an account, unlocks more. You are told what was added, that the connect page was offered, or that the person declined.",
    ].join(" "),
    parameters: offerItemParameters,
    available: agentId.length > 0,
    render: ItemCard,
  });

  /*
   * The finders run on the server; these only draw them, as one quiet line rather than a raw call
   * and a block of JSON. What was found is the Bot's to say, or to offer on a card.
   */
  useRenderTool({
    name: FIND_BOT_TEMPLATES_TOOL,
    parameters: findParameters,
    render: ({ status, result }) => (
      <ToolLine
        label={t("Looked through the Bot templates")}
        running={status !== "complete" && result === undefined}
      />
    ),
  });
  useRenderTool({
    name: FIND_MARKETPLACE_ITEMS_TOOL,
    parameters: findParameters,
    render: ({ status, result }) => (
      <ToolLine
        label={t("Looked through the Marketplace")}
        running={status !== "complete" && result === undefined}
      />
    ),
  });

  return null;
}
