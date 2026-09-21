// Turns a creator-written orchestrator-instructions.md into the fixed scan state. The mandate format is stable
// (# Mandate preamble, ## Intent prose, ## Constraints bullets, ## Shape of success bullets, ## Budget), so the
// state shape is stable too: every passage gets a path (`constraints[2]`) that questions can target.

export type ScanState = { intent: string[]; constraints: string[]; shape_of_success: string[] };

const SECTIONS: Record<keyof ScanState, string> = { intent: "## Intent", constraints: "## Constraints", shape_of_success: "## Shape of success" };

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`Mandate has no "${heading}" section`);
  const body = markdown.slice(start + heading.length + 2);
  const end = body.search(/\n## /);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

/** Sentence split for Korean/English prose: after `.`/`。`/`!`/`?` followed by whitespace. Indices are stable for a fixed text. */
export function sentences(prose: string): string[] {
  return prose.replace(/\s+/g, " ").split(/(?<=[.。!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function bullets(block: string): string[] {
  return block.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
}

export function parseMandate(markdown: string): ScanState {
  return {
    intent: sentences(section(markdown, SECTIONS.intent)),
    constraints: bullets(section(markdown, SECTIONS.constraints)),
    shape_of_success: bullets(section(markdown, SECTIONS.shape_of_success)),
  };
}

/** Every passage as (path, text): the candidate set scan judges. */
export function passages(state: ScanState): { path: string; domain: keyof ScanState; text: string }[] {
  return (Object.keys(SECTIONS) as (keyof ScanState)[]).flatMap((domain) => state[domain].map((text, i) => ({ path: `${domain}[${i}]`, domain, text })));
}
