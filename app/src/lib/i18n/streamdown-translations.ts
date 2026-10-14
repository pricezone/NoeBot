import { useMemo } from "react";
import type { StreamdownTranslations } from "streamdown";
import { useTranslation } from "./index";

/**
 * Streamdown's own words (the copy and download buttons on code, tables and diagrams, the external
 * link warning), in the interface's language. Every one listed, so a Streamdown upgrade that adds a
 * label is a type error here. Format names (CSV, PNG, Markdown) are names, the same in every
 * language.
 */
export function useStreamdownTranslations(): StreamdownTranslations {
  const { t } = useTranslation();
  return useMemo(
    (): Record<keyof StreamdownTranslations, string> => ({
      close: t("Close"),
      copied: t("Copied"),
      copyCode: t("Copy Code"),
      copyLink: t("Copy link"),
      copyTable: t("Copy table"),
      copyTableAsCsv: t("Copy table as CSV"),
      copyTableAsMarkdown: t("Copy table as Markdown"),
      copyTableAsTsv: t("Copy table as TSV"),
      downloadDiagram: t("Download diagram"),
      downloadDiagramAsMmd: t("Download diagram as MMD"),
      downloadDiagramAsPng: t("Download diagram as PNG"),
      downloadDiagramAsSvg: t("Download diagram as SVG"),
      downloadFile: t("Download file"),
      downloadImage: t("Download image"),
      downloadTable: t("Download table"),
      downloadTableAsCsv: t("Download table as CSV"),
      downloadTableAsMarkdown: t("Download table as Markdown"),
      exitFullscreen: t("Exit fullscreen"),
      externalLinkWarning: t("You're about to visit an external website."),
      imageNotAvailable: t("Image not available"),
      mermaidFormatMmd: "MMD",
      mermaidFormatPng: "PNG",
      mermaidFormatSvg: "SVG",
      openExternalLink: t("Open external link?"),
      openLink: t("Open link"),
      resetView: t("Reset zoom and pan"),
      tableFormatCsv: "CSV",
      tableFormatMarkdown: "Markdown",
      tableFormatTsv: "TSV",
      viewFullscreen: t("View fullscreen"),
      zoomIn: t("Zoom in"),
      zoomOut: t("Zoom out"),
    }),
    [t],
  );
}
