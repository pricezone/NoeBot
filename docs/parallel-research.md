# Public-web research with Parallel

Parallel provides public-web search and extraction for OpenBot. When both its `web_search` and `web_fetch` tools are granted to a Bot, the built-in Bot guidance describes them to it for public-web research, alongside whatever other tools it holds. The shipped Research Desk example also includes a public-web research skill. This configuration is conditional on ordinary authorization: no existing Bot receives new access automatically.

## Enable research

Any signed-in person turns it on from **Connect apps → Marketplace → Apps**, with no administrator step:

- **Parallel Search** — press **Enable**. No account and no key: anonymous access for light use, at `https://search.parallel.ai/mcp`, with its tools discovered when it is added.
- **Parallel Search (your account)** — press **Connect**, which opens the app's page under Settings and then Parallel's own consent screen. The deployment registers itself with Parallel over dynamic client registration, so there is no client to paste, and the tools are listed on the first person's connection. Each call then runs on the asker's own Parallel account.

Either way the app is offered to every Bot, existing and future, so the shipped **Research Desk** holds **web_search** and **web_fetch** at once; its `research-public-web` skill declares those tools, and the declaration alone grants nothing. An administrator can narrow the offer on the app's Plugins page — **Offered to every Bot** off, then grant the two tools per Bot — and a member's Enable or Connect cannot undo that. The **Connect apps** capability turns self-service off for a role or the whole organization.

Then ask the Bot to research a topic. It should search, read selected sources, and cite their URLs. Run `/research-public-web` to explicitly select the example skill if your deployment has many tools.

For production or higher limits on a key the deployment holds, an administrator instead adds **Parallel Search (API key)** from the Plugins page — it runs on a deployment key, so the Marketplace refuses to enable it — with the Parallel API key stored through the existing deployment credential flow, and grants its two tools per Bot. Both use the official endpoint; the authenticated entry sends the key as a Bearer token. If both are granted, the guidance selects the authenticated connector. Keys remain in the server-side credential vault.

## Choice and controls

Administrators can revoke either tool, remove the connector, or grant another provider. Users can explicitly request a different authorized provider. Existing tool selection, action policies, audit records, vendor error handling, and background-run authorization are unchanged. Every call goes through `PluginStore.callTool`; no raw MCP server is added to the agent configuration.

The provider receives model-selected objectives, search queries, requested public URLs and a conversation session identifier. These arguments can contain information from the user's request: avoid sending private context that is not needed for public research. Full conversations are not automatically forwarded. Free anonymous access has provider-managed limits; failures remain visible and are not silently retried through another provider. Source URLs and excerpts use the existing tool-result rendering; this change adds no custom source-card UI.

See [Parallel's official Search MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp) for the two tools, free access, API-key authentication and limits.
