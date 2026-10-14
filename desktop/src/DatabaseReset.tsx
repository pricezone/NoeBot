import { useState } from "react";
import { useTranslation } from "./i18n";

/** Only rendered when native setup has identified a recoverable leftover database. */
export function DatabaseReset({
  busy,
  onReset,
  volume,
}: {
  busy: boolean;
  volume: string;
  onReset: (volume: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="quiet"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {t("Reset leftover database")}
      </button>
    );
  }
  return (
    <section className="blocker" aria-labelledby="database-reset-title">
      <h2 id="database-reset-title">
        {t("Delete the previous installation’s data?")}
      </h2>
      <p>
        {t(
          "This permanently deletes the local OpenBot database, including saved chats, Bots, and settings. Only continue if you want a fresh installation and do not need that data.",
        )}
      </p>
      <p>
        {t("To keep your data, restore its original encryption key instead.")}
      </p>
      <div className="row">
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          {t("Keep saved data")}
        </button>
        <button type="button" disabled={busy} onClick={() => onReset(volume)}>
          {busy ? t("Deleting saved data…") : t("Delete saved data")}
        </button>
      </div>
    </section>
  );
}
