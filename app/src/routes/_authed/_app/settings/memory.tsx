import { createFileRoute } from "@tanstack/react-router";
import { MemorySection } from "@/components/settings/memory-section";
import { SettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authed/_app/settings/memory")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SettingsPage
      description="Review what your Bots remember, and choose which connected apps can contribute facts."
      title="Memory"
    >
      <MemorySection />
    </SettingsPage>
  );
}
