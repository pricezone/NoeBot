import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { AVATAR_COLORS, avatarSchemeOf } from "../../../../shared/avatar";
import { hairlineClassName } from "@/components/noe-bot/hairline";
import {
  type AvatarChoice,
  type AvatarScheme,
  avatarLook,
} from "@/components/noe-bot/pixel-art";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";

/**
 * The two bubbles a conversation draws, written once so the single-Bot transcript and the group
 * chat cannot drift apart.
 *
 * As Grok draws them: the Bot's words in a grey bubble on the left, the person's in the
 * conversation Bot's own avatar colour on the right, so whose conversation this is shows in every
 * line of it. The same colours in both themes, like the avatar they come from.
 */

/**
 * The person's colour where there is no one Bot to take it from: a group. The wordmark's
 * near-black with white ink, which reads as "you" against the grey Bot bubbles in either theme.
 */
export const GROUP_PERSON_SCHEME: AvatarScheme =
  avatarSchemeOf("#18181b") ?? AVATAR_COLORS[1];

/**
 * The colour of the person's bubbles in a conversation with these Bots.
 *
 * One Bot: its avatar colour, the chosen one when there is one and the seed's otherwise, exactly
 * as its avatar is drawn — so the two always match. None or several: the group colour, because a
 * conversation with three Bots has no one colour to borrow and borrowing the first one's would
 * claim it was theirs.
 */
export function personBubbleScheme(
  bots: readonly AvatarChoice[],
): AvatarScheme {
  const [only, ...others] = bots;
  return only && others.length === 0
    ? avatarLook(only).scheme
    : GROUP_PERSON_SCHEME;
}

/**
 * What the person said, in the conversation's colour.
 *
 * The colour arrives as two custom properties on the bubble (`variant="custom"`), and the content
 * keeps the border every bubble reserves so the two colours that nearly vanish into one theme's
 * page can have a hairline there. Chips inside it should draw in `currentColor`, since the ink is
 * white on most of the palette and black on the rest.
 */
export function PersonBubble({
  scheme,
  align = "end",
  className,
  children,
}: {
  scheme: AvatarScheme;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Bubble
      align={align}
      className={className}
      style={
        {
          "--bubble": scheme.background,
          "--bubble-foreground": scheme.ink,
        } as CSSProperties
      }
      variant="custom"
    >
      <BubbleContent className={hairlineClassName(scheme.background, "border")}>
        {children}
      </BubbleContent>
    </Bubble>
  );
}

/**
 * What a Bot said, in the muted grey.
 *
 * As wide as its words, up to the bubble's 80% of the column, rather than the whole column the
 * Bot's prose used to take when it had no bubble. Block content is the exception and widens it to
 * that limit: a code block is drawn with `content-visibility: auto`, so off screen it measures a
 * placeholder 200px wide and a shrink-to-fit bubble would jump when it scrolled in; a table and a
 * diagram size themselves from the width they are given, which a shrink-to-fit box never gives.
 *
 * Inside the grey, the two things Streamdown draws in that same grey would vanish: inline code
 * takes a shade of the text colour instead, and a code block the page's own background.
 */
export function BotBubble({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Bubble>, "variant" | "align"> & {
  children: ReactNode;
}) {
  return (
    <Bubble
      align="start"
      className={cn(
        "has-[[data-streamdown=code-block],[data-streamdown=table-wrapper],[data-streamdown=mermaid-block]]:w-full",
        className,
      )}
      variant="muted"
      {...props}
    >
      <BubbleContent className="w-full [&_[data-streamdown=code-block]]:bg-background [&_[data-streamdown=inline-code]]:bg-foreground/8">
        {children}
      </BubbleContent>
    </Bubble>
  );
}
