import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { NoeBotIcon } from "@/components/noe-bot/noe-bot-face";
import { appConfig } from "@/lib/generated/application-config";

/**
 * The one place the product's name and face come from.
 *
 * The name is the tenant package's (`examples/noebot/brand.yaml`, baked in by
 * `scripts/generate-app-config.ts`), so a screen that says "Noë Bot" says it because the
 * deployment does, not because somebody typed it. The mark and the avatar are the 16-grid Noë
 * mascot, which is the only bot face this app draws. Import this rather than the mascot components
 * or the generated config directly, so a rebrand is one file.
 */
export const brand = {
  productName: appConfig.brand.productName,
  /** The mascot standing for the product or for Bots in general. */
  Mark: NoeBotIcon,
  /** One Bot's face, keyed by its avatar seed. */
  Avatar: NoeBotAvatar,
} as const;
