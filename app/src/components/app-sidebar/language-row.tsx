import { IconChevronRight, IconLanguage } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { LanguageOptions } from "@/components/language-options";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslation } from "@/lib/i18n";
import { useLocale } from "@/lib/i18n/use-locale";
import { LOCALE_LABELS } from "../../../../shared/i18n/locales";
import { rowClassName } from "./account-menu-row";

/**
 * The account menu's Language row: the current language on the right, and a small menu beside it
 * with every language this deployment offers.
 *
 * A popover of its own inside the account menu's popover, rather than a `Menu` submenu, because the
 * account menu is a card of links and not a menu (see `ui/popover.tsx`); Base UI keeps a nested
 * popover as part of its parent, so choosing here does not close the account menu. It opens beside
 * the row and moves above or below it where there is no room, as on a phone.
 *
 * Choosing closes the small menu and leaves the account menu open, redrawn in the new language, with
 * focus back on this row, so the person sees at once what they changed. Drawn only where there is a
 * choice to make: a deployment that offers one language has no row.
 */
export function LanguageRow() {
  const { t } = useTranslation();
  const { locale, enabled, setLocale, syncFailed } = useLocale();
  const [open, setOpen] = useState(false);
  const checkedRef = useRef<HTMLButtonElement | null>(null);

  if (enabled.length < 2) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={rowClassName}
          openOnHover
          delay={150}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <IconLanguage />
          <span className="min-w-0 flex-1 truncate">{t("Language")}</span>
          <span lang={locale} className="shrink-0 text-muted-foreground">
            {LOCALE_LABELS[locale]}
          </span>
          <IconChevronRight className="size-4!" />
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-48 min-w-0"
          initialFocus={checkedRef}
        >
          <LanguageOptions
            label={t("Language")}
            locale={locale}
            enabled={enabled}
            checkedRef={checkedRef}
            onBack={() => setOpen(false)}
            onSelect={(next) => {
              setOpen(false);
              if (next !== locale) void setLocale(next);
            }}
          />
        </PopoverContent>
      </Popover>
      {syncFailed ? (
        <p role="status" className="px-3 pb-1 text-xs text-muted-foreground">
          {t("Saved on this browser only.")}
        </p>
      ) : null}
    </>
  );
}
