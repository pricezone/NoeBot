import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { brand } from "@/lib/brand";
import { setPreviewing } from "@/lib/i18n/detect";
import { startI18nBoot } from "@/lib/i18n/set-locale";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

/*
 * `?i18n-preview=1` offers every interface language in this browser before the deployment offers
 * them, for reviewing translations on a live instance; `?i18n-preview=0` stops. Read before the
 * language is chosen, so the visit that sets it already speaks the result.
 */
const preview = new URLSearchParams(window.location.search).get("i18n-preview");
if (preview === "1" || preview === "0") setPreviewing(preview === "1");

// The remembered language starts loading now, while the router resolves the first route.
void startI18nBoot();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error(
    `${brand.productName} could not find the application root element.`,
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
