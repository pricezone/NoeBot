import { and, asc, eq, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { sidebarSections } from "../db/schema";

/**
 * The headings somebody files their conversations under in the sidebar.
 *
 * One person's own and nobody else's, like a pin: every read and write here is scoped to the
 * caller, and a section id from somebody else's sidebar answers exactly as an id that does not
 * exist. Which conversation sits under which heading is the channel store's half
 * (`ChannelStore.setSection` in ./routes.ts), because it is a fact about a membership.
 */
export type SidebarSection = {
  id: string;
  name: string;
  /** Drawn smallest first. Dense from 0 after a reorder; a gap left by a delete is harmless. */
  position: number;
};

export type SidebarSectionStore = {
  /** The caller's sections, in the order the sidebar draws them. */
  listSections(actor: AgentActor): Promise<SidebarSection[]>;
  /** A new section, drawn after every section the caller already has. */
  createSection(actor: AgentActor, name: string): Promise<SidebarSection>;
  /** Throws SectionNotFoundError for a section that is not the caller's. */
  renameSection(
    actor: AgentActor,
    sectionId: string,
    name: string,
  ): Promise<SidebarSection>;
  /**
   * Remove a section. Its conversations are not touched: their placements cascade away with it, so
   * they fall back into the ungrouped list. Throws SectionNotFoundError for one not the caller's.
   */
  deleteSection(actor: AgentActor, sectionId: string): Promise<void>;
  /**
   * Draw the caller's sections in exactly this order. The list must name each of their sections
   * once, or SectionOrderError: an order that leaves one out says nothing about where it goes, and
   * one naming a section deleted in another tab was made from a sidebar that is out of date.
   */
  reorderSections(
    actor: AgentActor,
    sectionIds: string[],
  ): Promise<SidebarSection[]>;
};

/** How long a section's name may be, in code points: a heading in a 280px column, not a sentence. */
export const MAX_SECTION_NAME_CODE_POINTS = 60;

export class SectionNotFoundError extends Error {
  constructor(id: string) {
    super(`Section ${id} was not found.`);
    this.name = "SectionNotFoundError";
  }
}

export class SectionOrderError extends Error {
  constructor() {
    super("A section order must name each of your sections exactly once.");
    this.name = "SectionOrderError";
  }
}

const SECTION_COLUMNS = {
  id: sidebarSections.id,
  name: sidebarSections.name,
  position: sidebarSections.position,
};

export function createSidebarSectionStore(
  database: Database,
): SidebarSectionStore {
  const listSections = (actor: AgentActor) =>
    database
      .select(SECTION_COLUMNS)
      .from(sidebarSections)
      .where(eq(sidebarSections.userId, actor.id))
      // Ties only from two creates landing together; the age and then the id settle them the same
      // way on every read, so the sidebar never swaps two headings between refetches.
      .orderBy(
        asc(sidebarSections.position),
        asc(sidebarSections.createdAt),
        asc(sidebarSections.id),
      );

  return {
    listSections,

    async createSection(actor, name) {
      const [created] = await database
        .insert(sidebarSections)
        .values({
          id: `section_${crypto.randomUUID()}`,
          userId: actor.id,
          name,
          // After the last one, computed in the statement rather than read first, so there is no
          // gap between asking and writing for a second create to land in.
          position: sql`(select coalesce(max(${sidebarSections.position}) + 1, 0) from ${sidebarSections} where ${sidebarSections.userId} = ${actor.id})`,
        })
        .returning(SECTION_COLUMNS);
      if (!created) throw new Error("Creating a section returned no row.");
      return created;
    },

    async renameSection(actor, sectionId, name) {
      const [renamed] = await database
        .update(sidebarSections)
        .set({ name })
        .where(
          and(
            eq(sidebarSections.id, sectionId),
            eq(sidebarSections.userId, actor.id),
          ),
        )
        .returning(SECTION_COLUMNS);
      if (!renamed) throw new SectionNotFoundError(sectionId);
      return renamed;
    },

    async deleteSection(actor, sectionId) {
      const deleted = await database
        .delete(sidebarSections)
        .where(
          and(
            eq(sidebarSections.id, sectionId),
            eq(sidebarSections.userId, actor.id),
          ),
        )
        .returning({ id: sidebarSections.id });
      if (deleted.length === 0) throw new SectionNotFoundError(sectionId);
    },

    async reorderSections(actor, sectionIds) {
      await database.transaction(
        async (transaction) => {
          // Locked, so a create or delete in another tab cannot slip in between the check and the
          // rewrite and leave a section with no position in the order this call promised.
          const existing = await transaction
            .select({ id: sidebarSections.id })
            .from(sidebarSections)
            .where(eq(sidebarSections.userId, actor.id))
            .for("update");
          const owned = new Set(existing.map((row) => row.id));
          if (
            sectionIds.length !== owned.size ||
            new Set(sectionIds).size !== sectionIds.length ||
            sectionIds.some((id) => !owned.has(id))
          ) {
            throw new SectionOrderError();
          }
          for (const [position, id] of sectionIds.entries()) {
            await transaction
              .update(sidebarSections)
              .set({ position })
              .where(
                and(
                  eq(sidebarSections.id, id),
                  eq(sidebarSections.userId, actor.id),
                ),
              );
          }
        },
        { isolationLevel: "read committed" },
      );
      return listSections(actor);
    },
  };
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A section name as somebody typed it, made into one line a heading can draw.
 *
 * Control characters become spaces and runs of whitespace one space, the way a roster line is
 * flattened (`oneLine` in ./text.ts), but nothing is cut: a name that is too long is refused rather
 * than shortened, because a heading quietly saved as something other than what was typed is a
 * heading the person no longer recognises.
 */
export function parseSectionName(input: unknown): ParseResult<string> {
  const error = `A section name must be text between 1 and ${MAX_SECTION_NAME_CODE_POINTS} characters.`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Section input must be a JSON object." };
  }
  const { name } = input as { name?: unknown };
  if (typeof name !== "string") return { ok: false, error };
  const flattened = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const length = Array.from(flattened).length;
  if (length === 0 || length > MAX_SECTION_NAME_CODE_POINTS) {
    return { ok: false, error };
  }
  return { ok: true, value: flattened };
}

/** `{ sectionIds: string[] }`, the whole order, as `reorderSections` takes it. */
export function parseSectionOrder(input: unknown): ParseResult<string[]> {
  const error = "Section ids must be an array of section ids.";
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Section order must be a JSON object." };
  }
  const { sectionIds } = input as { sectionIds?: unknown };
  if (!Array.isArray(sectionIds)) return { ok: false, error };
  if (
    sectionIds.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    return { ok: false, error };
  }
  return { ok: true, value: sectionIds as string[] };
}

/**
 * `/api/channels/sections`: list, create, rename, delete and reorder the caller's sections.
 *
 * Mounted by `createChannelRoutes` ahead of `/:channelId`, or "sections" would be read as a channel
 * id. Moving a conversation into a section is not here but on the conversation,
 * `PUT /api/channels/:channelId/section`, beside its pin and its read marker.
 */
export function createSectionRoutes(
  store: SidebarSectionStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const sections = await store.listSections(context.var.actor);
    return context.json({ sections });
  });

  routes.post("/", requireUser, async (context) => {
    const parsed = parseSectionName(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const section = await store.createSection(context.var.actor, parsed.value);
    return context.json({ section }, 201);
  });

  // Before `/:sectionId`, or "order" is read as a section id.
  routes.put("/order", requireUser, async (context) => {
    const parsed = parseSectionOrder(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      const sections = await store.reorderSections(
        context.var.actor,
        parsed.value,
      );
      return context.json({ sections });
    } catch (error) {
      return mapSectionError(context, error);
    }
  });

  routes.patch("/:sectionId", requireUser, async (context) => {
    const parsed = parseSectionName(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      const section = await store.renameSection(
        context.var.actor,
        context.req.param("sectionId"),
        parsed.value,
      );
      return context.json({ section });
    } catch (error) {
      return mapSectionError(context, error);
    }
  });

  routes.delete("/:sectionId", requireUser, async (context) => {
    try {
      await store.deleteSection(
        context.var.actor,
        context.req.param("sectionId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapSectionError(context, error);
    }
  });

  return routes;
}

/** The section refusals as answers. Anything else is not ours to explain, and goes up. */
export function mapSectionError(context: Context, error: unknown): Response {
  if (error instanceof SectionNotFoundError) {
    return context.json({ error: "Section not found." }, 404);
  }
  if (error instanceof SectionOrderError) {
    return context.json(
      {
        error:
          "Your sections changed since this list was drawn. Reload and try again.",
      },
      409,
    );
  }
  throw error;
}
