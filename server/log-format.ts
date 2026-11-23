/**
 * log-format.ts — prints activity-log rows in a terminal.
 *
 * The browser shows log rows as an expandable list (step 10). ask.ts,
 * compare.ts and the scorecard show the same rows as lines of text, and
 * this is the one place that decides what a line looks like:
 *
 *   retrieval  model  Search: "late return fee" · hybrid · heading+context · 41 candidates
 *              ^ the actor: who decided this happened
 *
 * With `verbose`, the row's detail (the full request body, the candidate
 * list) follows as indented JSON, which is long but complete. Without it,
 * one line per row: enough to follow a turn, with the details a flag away.
 */

import type { LogEvent } from "../shared/types.js";

/** One row as text. */
export function formatRow(event: LogEvent, verbose = false): string {
  const level = event.level.padEnd(9);
  const actor = (event.actor ?? "").padEnd(5);
  const because = event.because && verbose ? `\n${" ".repeat(18)}because ${event.because}` : "";
  const line = `  ${level} ${actor}  ${event.label}${because}`;
  if (!verbose || event.detail === undefined) return line;
  const json = JSON.stringify(event.detail, null, 2)
    .split("\n")
    .map((l) => `${" ".repeat(18)}${l}`)
    .join("\n");
  return `${line}\n${json}`;
}
