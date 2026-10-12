# Keys

**Settings › Keys** gathers every secret a deployment runs on, laid out like Hermes Agent's dashboard Keys page: the model's key, the keys you paste for connectors, the accounts you sign in to, and for an administrator the deployment's own credentials.

## The model's key

The Bots answer with one provider and model (`model.yaml` in the package; `BOT_PROVIDER`/`BOT_MODEL` on a hosted instance). The key is resolved on every call: the credential vault's live row for `(kind "model", provider, keyId)` first — `keyId` is the package's `credential_secret_ref`, `model-api-key` on Noë Bot — and the environment's `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` otherwise.

So an administrator can **Replace key** in place: the page writes a `model` credential through `POST /api/admin/credentials`, which revokes the previous live row in the same step, and the next call uses it. **Use the deployment's key again** revokes the vault row, and the environment's key is back in force. Nothing restarts.

`GET /api/settings/model-key` tells the page which is in force. Everybody learns the provider and the model; an administrator also learns the source (`vault`, `environment` or `none`) and the vault row's id. The secret is never on the wire.

On a **metered** deployment the model is reached through the platform's gateway, which authenticates the deployment's own token, so no personal key applies: the page shows "HyperNoesis API" and the link to the plan.

Signing in to a model provider with a subscription (ChatGPT, Claude) is not offered: the hosted image runs the built-in agent on a provider key, and the two OAuth-to-model paths in this repository are desktop-only or need the harness containers the image does not run.

## Your API keys and your accounts

The same controls the Marketplace offers, in one place: **Add key** / **Replace** / **Remove** for a plugin's `header` connector (`POST /api/plugins/servers/:id/connect` with the variables; `DELETE …/connection`), and **Connect** / **Disconnect** for an app you sign in to at the vendor. A brokered app Composio reaches with an API key links to its own page. Every row also links to the account's page under Settings › Apps.

## Deployment credentials

For an administrator, the count of live credentials the deployment itself holds for vendors, and the link to Admin › Credentials, where they are added, rotated and revoked.
