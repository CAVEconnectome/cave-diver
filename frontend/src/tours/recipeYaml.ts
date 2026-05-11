/**
 * Hand-rolled YAML emitter for `Recipe` objects. The output mirrors the
 * operator schema in `services/datastack_config.py` exactly so a user can
 * paste it under `recipes:` in `config/datastacks/<ds>.yaml` without
 * editing.
 *
 * Why not js-yaml: ~30KB dep for a write-only path. The Recipe shape is
 * shallow (strings, string arrays, one array of small objects with
 * primitive fields), so a focused emitter is tractable. If a YAML *parser*
 * is needed on the frontend later, revisit.
 *
 * Output is intentionally close to what an operator would hand-write —
 * block-style sequences for lists, folded scalars for descriptions
 * containing newlines, dotted-table-column references quoted (matching
 * the convention in docs/tours.md and the shipped YAML).
 */
import type { Recipe, TourPlot, TourPlotBindings } from "../api/types";

export function recipeToYaml(recipe: Recipe): string {
  // Wrap as the single-recipe-in-a-recipes-list shape so a paste-in lands
  // under the right key.
  const lines: string[] = [];
  lines.push("recipes:");
  emitRecipe(recipe, lines, 2);
  return lines.join("\n") + "\n";
}

function emitRecipe(recipe: Recipe, lines: string[], indent: number): void {
  const pad = " ".repeat(indent);
  // First field of a list item is on the dash line.
  lines.push(`${" ".repeat(indent - 2)}- id: ${quoteIfNeeded(recipe.id)}`);
  lines.push(`${pad}title: ${quoteIfNeeded(recipe.title)}`);
  if (recipe.description) {
    emitDescription(recipe.description, lines, indent);
  }
  if (recipe.decoration_tables.length > 0) {
    lines.push(`${pad}decoration_tables:`);
    for (const t of recipe.decoration_tables) {
      lines.push(`${pad}  - ${quoteIfNeeded(t)}`);
    }
  }
  if (recipe.plots.length > 0) {
    lines.push(`${pad}plots:`);
    for (const plot of recipe.plots) {
      emitPlot(plot, lines, indent + 2);
    }
  }
  if (recipe.cells) {
    lines.push(`${pad}cells: ${quoteIfNeeded(recipe.cells)}`);
  }
  for (const key of ["hide", "show", "coll"] as const) {
    const list = recipe[key];
    if (list && list.length > 0) {
      lines.push(`${pad}${key}:`);
      for (const item of list) {
        lines.push(`${pad}  - ${quoteIfNeeded(item)}`);
      }
    }
  }
}

function emitPlot(plot: TourPlot, lines: string[], indent: number): void {
  const pad = " ".repeat(indent);
  // First field on the dash line.
  let firstWritten = false;
  if (plot.id) {
    lines.push(`${" ".repeat(indent - 2)}- id: ${quoteIfNeeded(plot.id)}`);
    firstWritten = true;
  }
  if (plot.summary_kind) {
    if (!firstWritten) {
      lines.push(`${" ".repeat(indent - 2)}- summary_kind: ${quoteIfNeeded(plot.summary_kind)}`);
      firstWritten = true;
    } else {
      lines.push(`${pad}summary_kind: ${quoteIfNeeded(plot.summary_kind)}`);
    }
  }
  if (plot.bindings && hasAnyBinding(plot.bindings)) {
    if (!firstWritten) {
      lines.push(`${" ".repeat(indent - 2)}- bindings:`);
      firstWritten = true;
    } else {
      lines.push(`${pad}bindings:`);
    }
    emitBindings(plot.bindings, lines, indent + 2);
  }
  if (plot.unfiltered) {
    if (!firstWritten) {
      lines.push(`${" ".repeat(indent - 2)}- unfiltered: true`);
    } else {
      lines.push(`${pad}unfiltered: true`);
    }
  }
}

function emitBindings(b: TourPlotBindings, lines: string[], indent: number): void {
  const pad = " ".repeat(indent);
  for (const k of ["x", "y", "hue", "size", "weight", "scope"] as const) {
    const v = b[k];
    if (typeof v === "string" && v.length > 0) {
      lines.push(`${pad}${k}: ${quoteIfNeeded(v)}`);
    }
  }
  if (b.show_cell_depth === false) {
    lines.push(`${pad}show_cell_depth: false`);
  }
}

function emitDescription(text: string, lines: string[], indent: number): void {
  const pad = " ".repeat(indent);
  // Single-line descriptions inline; multi-line use the folded `>` block
  // scalar which joins lines and preserves paragraph breaks at blank lines.
  if (!text.includes("\n") && text.length < 80) {
    lines.push(`${pad}description: ${quoteIfNeeded(text)}`);
    return;
  }
  lines.push(`${pad}description: >`);
  for (const line of text.split("\n")) {
    lines.push(`${pad}  ${line}`);
  }
}

function hasAnyBinding(b: TourPlotBindings): boolean {
  return Boolean(
    b.x || b.y || b.hue || b.size || b.weight || b.scope || b.show_cell_depth === false,
  );
}

/** Quote the value if YAML would otherwise misparse it. Conservative
 *  rules: anything containing `:` (ambiguous with key separator), `#`
 *  (comment), leading `-` (list marker), `?` (complex key marker),
 *  starting with a digit (would parse as int/float), `null` / `true` /
 *  `false` (booleans), or whitespace gets double-quoted. Otherwise
 *  bare. */
function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  if (/[:#?\[\]{},&*!|>'%@`]/.test(value)) return doubleQuote(value);
  if (/^\s|\s$/.test(value)) return doubleQuote(value);
  if (/^-/.test(value)) return doubleQuote(value);
  if (/^[0-9]/.test(value)) return doubleQuote(value);
  if (/^(null|true|false|yes|no|on|off|~)$/i.test(value)) return doubleQuote(value);
  return value;
}

function doubleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
