import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { type FoundKey, parse } from "./scan";

/**
 * This deployment's own content, as keys of the `content` namespace: the words it ships as data
 * rather than as code, translated where the app shows them (`useContentText`).
 *
 * The data stays English, because the model reads it and the package compares it. What is ours to
 * translate:
 * - the Bot templates' titles, summaries, descriptions and routines (`examples/noebot/templates.yaml`);
 *   a template's name is a proper name and stays as it is;
 * - the skills' titles and summaries (`examples/noebot/skills.yaml`);
 * - the stock Bots' titles (`examples/noebot/agents.yaml`, `examples/noebot/agents/*.yaml`);
 * - the catalogue's summaries (`server/src/plugins/catalogue.ts`); its titles are product names;
 * - the template categories (`shared/templates.ts`), the avatar colours and faces (`shared/avatar.ts`,
 *   each face named as `faceLabel` names it) and the face picker's groups (`anim/catalog.ts`).
 *
 * Third-party words (Composio's directory, the Cursor index, a server's tool descriptions) are not
 * here, and a text the catalog does not hold is shown as it is.
 */

type Found = { key: string; file: string; line: number };

function yamlStrings(
  file: string,
  text: string,
  pick: (document: unknown) => unknown[],
): Found[] {
  const lines = text.split("\n");
  const lineOf = (value: string) => {
    const head = value.slice(0, 30);
    const index = lines.findIndex((line) => line.includes(head));
    return index === -1 ? 1 : index + 1;
  };
  return pick(parseYaml(text))
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    .map((key) => ({ key, file, line: lineOf(key) }));
}

type Template = {
  title?: string;
  summary?: string;
  description?: string;
  routines?: { name?: string; summary?: string }[];
};
type Skill = { title?: string; summary?: string };
type Agent = { title?: string };

const fromTemplates = (document: unknown) =>
  ((document as { templates?: Template[] }).templates ?? []).flatMap(
    (template) => [
      template.title,
      template.summary,
      template.description,
      ...(template.routines ?? []).flatMap((routine) => [
        routine.name,
        routine.summary,
      ]),
    ],
  );

const fromSkills = (document: unknown) =>
  ((document as { skills?: Skill[] }).skills ?? []).flatMap((skill) => [
    skill.title,
    skill.summary,
  ]);

const fromAgents = (document: unknown) => {
  const value = document as { agents?: Agent[] } & Agent;
  return value.agents
    ? value.agents.map((agent) => agent.title)
    : [value.title];
};

/** String values of `property` anywhere in a TypeScript file, or the strings of an `as const` list. */
function tsStrings(
  file: string,
  source: ts.SourceFile,
  match: (node: ts.Node) => ts.Expression[],
): Found[] {
  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    for (const value of match(node))
      if (
        ts.isStringLiteral(value) ||
        ts.isNoSubstitutionTemplateLiteral(value)
      )
        found.push({
          key: value.text,
          file,
          line:
            source.getLineAndCharacterOfPosition(value.getStart(source)).line +
            1,
        });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const property = (name: string) => (node: ts.Node) =>
  ts.isPropertyAssignment(node) &&
  ts.isIdentifier(node.name) &&
  node.name.text === name
    ? [node.initializer]
    : [];

const listNamed = (name: string) => (node: ts.Node) => {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    node.name.text !== name ||
    !node.initializer
  )
    return [];
  let value: ts.Expression = node.initializer;
  if (ts.isAsExpression(value)) value = value.expression;
  return ts.isArrayLiteralExpression(value) ? [...value.elements] : [];
};

export function scanContent(root: string): FoundKey[] {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const found: Found[] = [
    ...yamlStrings(
      "examples/noebot/templates.yaml",
      read("examples/noebot/templates.yaml"),
      fromTemplates,
    ),
    ...yamlStrings(
      "examples/noebot/skills.yaml",
      read("examples/noebot/skills.yaml"),
      fromSkills,
    ),
    ...yamlStrings(
      "examples/noebot/agents.yaml",
      read("examples/noebot/agents.yaml"),
      fromAgents,
    ),
    ...[...new Glob("examples/noebot/agents/*.yaml").scanSync(root)]
      .sort()
      .flatMap((file) => yamlStrings(file, read(file), fromAgents)),
  ];
  const catalogue = "server/src/plugins/catalogue.ts";
  found.push(
    ...tsStrings(
      catalogue,
      parse(catalogue, read(catalogue)),
      property("summary"),
    ),
  );
  const templates = "shared/templates.ts";
  found.push(
    ...tsStrings(
      templates,
      parse(templates, read(templates)),
      listNamed("TEMPLATE_CATEGORIES"),
    ),
  );
  const avatar = "shared/avatar.ts";
  const avatarSource = parse(avatar, read(avatar));
  found.push(...tsStrings(avatar, avatarSource, property("label")));
  // As `faceLabel` (anim/catalog.ts) shows a face: "in-love" is "In love".
  found.push(
    ...tsStrings(avatar, avatarSource, listNamed("AVATAR_EXPRESSIONS")).map(
      (face) => {
        const words = face.key.split("-").join(" ");
        return {
          ...face,
          key: words.charAt(0).toUpperCase() + words.slice(1),
        };
      },
    ),
  );
  const faces = "app/src/components/noe-bot/anim/catalog.ts";
  const facesSource = parse(faces, read(faces));
  found.push(
    ...tsStrings(faces, facesSource, property("label")),
    ...tsStrings(faces, facesSource, listNamed("sections")),
  );
  return found.map(({ key, file, line }) => ({
    key,
    namespace: "content",
    plural: false,
    file,
    line,
  }));
}
