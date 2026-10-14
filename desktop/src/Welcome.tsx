import { useTranslation } from "./i18n";

/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="sheet">
      <div className="lockup">
        <div className="orb" aria-hidden="true" />
        {/* i18n-ignore: the product's name */}
        <span>OpenBot</span>
      </div>
      <h1>{t("Your own AI coworkers, on this computer.")}</h1>
      <p className="lede big">
        {t(
          "They answer questions, use the tools you connect, and can work in a browser for you.",
        )}
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          {t("Set up OpenBot")}
        </button>
      </div>
      <p className="footnote">
        {t(
          "Takes a few minutes. OpenBot installs what it needs first, then asks you to sign in to the AI plan you already have.",
        )}
      </p>
    </div>
  );
}
