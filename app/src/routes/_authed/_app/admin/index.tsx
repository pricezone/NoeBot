import {
  IconBuildingBank,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { msg, useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    title: msg("What Bots can reach"),
    description: msg(
      "Everything a Bot can touch outside this app, and the limits on it.",
    ),
    items: [
      {
        title: msg("Credentials"),
        description: msg("Keys and tokens held for this deployment."),
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: msg("Boundaries"),
        description: msg("Rules that decide what a Bot may never do."),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: msg("Computers"),
        description: msg("The machines Bots run their tools on."),
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: msg("What Bots can do"),
    description: msg(
      "Capabilities and interface pieces available across Bots.",
    ),
    items: [
      {
        title: msg("Plugins"),
        description: msg(
          "The services this deployment can reach, and which Bots may.",
        ),
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: msg("Skills"),
        description: msg("Named instructions anybody can invoke with a slash."),
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: msg("Automatic Learning"),
        description: msg(
          "Learn from completed conversations and review proposed skills.",
        ),
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: msg("UI Components"),
        description: msg("Custom pieces a Bot can draw in a conversation."),
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: msg("Playground"),
        description: msg("Write a component and watch it render as you type."),
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: msg("Who can get in"),
    description: "",
    items: [
      {
        title: msg("People"),
        description: msg(
          "Everybody who has signed in, who administers this deployment, and whose access has been removed.",
        ),
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: msg("Enterprise controls"),
        description: msg(
          "Capabilities by role and group, SSO required, SCIM, network policy, MCP and model allowlists, Action Recording.",
        ),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/enterprise" },
      },
      {
        title: msg("Identity providers"),
        description: msg(
          "A company's own SAML or OpenID Connect provider, routed by email domain.",
        ),
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    title: msg("What happened"),
    description: "",
    items: [
      {
        title: msg("Audit"),
        description: msg("Every action taken in this deployment, and by whom."),
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

function RouteComponent() {
  const { t } = useTranslation("admin");
  return (
    <PageShell
      description={t(
        "Settings that apply to everybody in this deployment. Anything here affects every person and every Bot, which is what separates it from your own preferences.",
      )}
      title={t("Admin")}
    >
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description ? t(section.description) : undefined}
          key={section.title}
          title={t(section.title)}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia>
                    <item.icon className="size-4 text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{t(item.title)}</ItemTitle>
                    <ItemDescription>{t(item.description)}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
