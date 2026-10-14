import { IconCheck } from "@tabler/icons-react";
import type * as React from "react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { LOCALE_LABELS, type Locale } from "../../../shared/i18n/locales";

/**
 * The interface languages as a short list of choices, the current one ticked.
 *
 * Each language is named in itself ("English", "Ελληνικά") and marked with its own `lang`, so a
 * person who cannot read the interface's current language still recognises theirs, and a screen
 * reader says each name in its own voice.
 *
 * A radio group, read and moved through like one: ↑ and ↓ move between the choices without choosing,
 * Enter or Space chooses, ← hands focus back to whatever opened the list (`onBack`). Moving does not
 * choose, unlike a form's radio buttons, because choosing redraws the whole interface.
 */
export function LanguageOptions({
  locale,
  enabled,
  onSelect,
  onBack,
  checkedRef,
  label,
}: {
  locale: Locale;
  enabled: readonly Locale[];
  onSelect: (locale: Locale) => void;
  onBack?: () => void;
  /** Receives the ticked choice, so a popup can put focus on it when it opens. */
  checkedRef?: React.Ref<HTMLButtonElement>;
  label: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = buttons.current.indexOf(
      document.activeElement as HTMLButtonElement | null,
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = enabled.length;
      const next = (Math.max(current, 0) + step + count) % count;
      buttons.current[next]?.focus();
    } else if (event.key === "ArrowLeft" && onBack) {
      event.preventDefault();
      onBack();
    }
  };

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={handleKeyDown}>
      {enabled.map((option, index) => {
        const checked = option === locale;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a native radio chooses as the arrow keys move, and choosing a language redraws the whole interface, so here moving must not choose.
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            lang={option}
            tabIndex={checked ? 0 : -1}
            ref={(element) => {
              buttons.current[index] = element;
              if (checked && checkedRef) {
                if (typeof checkedRef === "function") checkedRef(element);
                else
                  (
                    checkedRef as React.MutableRefObject<HTMLButtonElement | null>
                  ).current = element;
              }
            }}
            onClick={() => onSelect(option)}
            className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-foreground outline-none hover:bg-muted focus-visible:bg-muted"
          >
            <IconCheck
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-foreground",
                checked ? "opacity-100" : "opacity-0",
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              {LOCALE_LABELS[option]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
