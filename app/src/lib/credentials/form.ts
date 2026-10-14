import { z } from "zod";
import { msg } from "@/lib/i18n";

export const credentialFormSchema = z.object({
  kind: z.enum(["model", "connector"]),
  provider: z.string().trim().min(1, msg("Provider is required.")),
  keyId: z.string().trim().min(1, msg("Key ID is required.")),
  plaintext: z.string().min(1, msg("Secret is required.")),
});

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
