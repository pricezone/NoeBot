# Skills

A skill is a named instruction a person invokes with `/` and a Bot follows. It adds no capability: it can only ask a Bot to use tools that Bot already holds, and every one of those calls is still decided, policy-checked and recorded.

## Three kinds, on one tab

The Marketplace's **Skills** tab lists them in two sections, drawn as the Apps tab draws its rows, every skill behind the same lightning mark.

- **Your skills** are the ones you wrote: **New skill** writes one in the panel beside the list, **Record skill** records one on a Bot's computer (below), and **Edit** opens the panel where the text and the delete live.
- **Workspace skills** are the deployment's — what the package ships, what a Marketplace plugin brought, and what an administrator wrote for everybody. Members open them with **View**.

### Default skills are not editable

A **package skill** (`examples/<package>/skills.yaml`) is rewritten by the package on every boot and re-seeded when deleted, so the server refuses a save or a delete over its slug — for an administrator too — with a 409 that says to change it in the package or write a new skill. A **plugin's skill** goes with its plugin: it is replaced or removed from the plugin's page in the Marketplace. The panel shows both to read, and says why.

What an administrator does decide about any deployment skill is its **Settings**, under the text in the same panel (and on Admin › Skills): whether every Bot is offered it, and which Bots carry it by name. A deployment-wide skill an administrator wrote keeps its form and its delete.

### Writing one for everybody

**New skill** offers an administrator a switch, **For everyone on this deployment**. On, the skill is saved with `global: true` — the same request Admin › Skills makes — and lands under Workspace skills for every member.

## Record skill

Teach a Bot a task by showing it: on the Skills tab, **Record skill** opens the Bot's computer full-window with **Record your steps** in front of you. One Bot you may use and it goes straight to that Bot's newest conversation (or a fresh one) with `?panel=computer&record=true`; several, and it asks which Bot's computer records. Nothing is pressed for you — taking over the Bot's browser is your press. Record, work through the task once (ten minutes or two hundred steps at most), stop, name the workflow, and review the draft skill before it is saved and granted to that Bot.

## The package's skills

`examples/noebot/skills.yaml` ships 28: the eight on connectors (web research, Drive, Notion), the seven written for the Bot templates, and thirteen for everyday jobs — replies for the inbox, meeting prep, a morning brief, a postponed decision, account research and outreach, candidate sourcing, campaign spend, expense reconciliation, a performance regression, a bug reproduction pack, an account-health watch list, a document summary, the weekly report. Each says when it applies, what it needs, the sequence, how to check the result, what to return, and what needs the person's approval; none sends, enrols, changes or pays on its own.
