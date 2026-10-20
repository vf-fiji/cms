import type { PageLayout, SectionNode, WidgetNode } from "../../shared/types";
import { cloneWithNewIds, makeSection } from "../../shared/widgets";

export type NodeKind = "section" | "column" | "widget";
export interface Loc {
  kind: NodeKind;
  s: number;
  c: number;
  w: number;
}

export function locate(layout: PageLayout, id: string | null): Loc | null {
  if (!id) return null;
  for (let s = 0; s < layout.sections.length; s++) {
    const sec = layout.sections[s];
    if (sec.id === id) return { kind: "section", s, c: -1, w: -1 };
    for (let c = 0; c < sec.columns.length; c++) {
      const col = sec.columns[c];
      if (col.id === id) return { kind: "column", s, c, w: -1 };
      const w = col.widgets.findIndex((x) => x.id === id);
      if (w >= 0) return { kind: "widget", s, c, w };
    }
  }
  return null;
}

const clone = (l: PageLayout): PageLayout => structuredClone(l);

export function getWidget(layout: PageLayout, id: string): WidgetNode | null {
  const l = locate(layout, id);
  return l?.kind === "widget" ? layout.sections[l.s].columns[l.c].widgets[l.w] : null;
}

export function updateNodeProps(layout: PageLayout, id: string, patch: Record<string, any>): PageLayout {
  const l = locate(layout, id);
  if (!l) return layout;
  const next = clone(layout);
  if (l.kind === "section") next.sections[l.s].props = { ...next.sections[l.s].props, ...patch };
  else if (l.kind === "column") next.sections[l.s].columns[l.c].props = { ...next.sections[l.s].columns[l.c].props, ...patch };
  else {
    const w = next.sections[l.s].columns[l.c].widgets[l.w];
    w.props = { ...w.props, ...patch };
  }
  return next;
}

export function insertWidget(layout: PageLayout, widget: WidgetNode, columnId: string | null, index: number | null, sectionIndex?: number): PageLayout {
  const next = clone(layout);
  const l = locate(next, columnId);
  if (l?.kind === "column") {
    const col = next.sections[l.s].columns[l.c];
    col.widgets.splice(index ?? col.widgets.length, 0, widget);
  } else {
    next.sections.splice(sectionIndex ?? next.sections.length, 0, makeSection([12], [[widget]]));
  }
  return next;
}

/** Insert relative to the current selection: after a widget, into a column, into a section's first column, or as a new section. */
export function insertNearSelection(layout: PageLayout, widget: WidgetNode, selectedId: string | null): PageLayout {
  const l = locate(layout, selectedId);
  if (!l) return insertWidget(layout, widget, null, null);
  if (l.kind === "widget") return insertWidget(layout, widget, layout.sections[l.s].columns[l.c].id, l.w + 1);
  if (l.kind === "column") return insertWidget(layout, widget, selectedId, null);
  return insertWidget(layout, widget, layout.sections[l.s].columns[0].id, null);
}

export function removeNode(layout: PageLayout, id: string): PageLayout {
  const l = locate(layout, id);
  if (!l) return layout;
  const next = clone(layout);
  if (l.kind === "section") next.sections.splice(l.s, 1);
  else if (l.kind === "widget") next.sections[l.s].columns[l.c].widgets.splice(l.w, 1);
  else if (l.kind === "column") {
    const sec = next.sections[l.s];
    if (sec.columns.length === 1) next.sections.splice(l.s, 1);
    else {
      const [removed] = sec.columns.splice(l.c, 1);
      const target = sec.columns[Math.max(0, l.c - 1)];
      target.widgets.push(...removed.widgets);
      target.width = Math.min(12, target.width + removed.width);
    }
  }
  return next;
}

export function duplicateNode(layout: PageLayout, id: string): { layout: PageLayout; newId: string | null } {
  const l = locate(layout, id);
  if (!l || l.kind === "column") return { layout, newId: null };
  const next = clone(layout);
  if (l.kind === "section") {
    const copy = cloneWithNewIds(next.sections[l.s]);
    next.sections.splice(l.s + 1, 0, copy);
    return { layout: next, newId: copy.id };
  }
  const col = next.sections[l.s].columns[l.c];
  const copy = cloneWithNewIds(col.widgets[l.w]);
  col.widgets.splice(l.w + 1, 0, copy);
  return { layout: next, newId: copy.id };
}

export function moveNode(layout: PageLayout, id: string, dir: -1 | 1): PageLayout {
  const l = locate(layout, id);
  if (!l) return layout;
  const next = clone(layout);
  if (l.kind === "section") {
    const j = l.s + dir;
    if (j < 0 || j >= next.sections.length) return layout;
    [next.sections[l.s], next.sections[j]] = [next.sections[j], next.sections[l.s]];
    return next;
  }
  if (l.kind === "widget") {
    const col = next.sections[l.s].columns[l.c];
    const j = l.w + dir;
    if (j >= 0 && j < col.widgets.length) {
      [col.widgets[l.w], col.widgets[j]] = [col.widgets[j], col.widgets[l.w]];
      return next;
    }
    // hop to the neighbouring section
    const sj = l.s + dir;
    if (sj < 0 || sj >= next.sections.length) return layout;
    const [w] = col.widgets.splice(l.w, 1);
    const targetCol = next.sections[sj].columns[Math.min(l.c, next.sections[sj].columns.length - 1)];
    if (dir < 0) targetCol.widgets.push(w);
    else targetCol.widgets.unshift(w);
    return next;
  }
  return layout;
}

export function moveWidgetTo(layout: PageLayout, id: string, columnId: string | null, index: number | null, sectionIndex: number): PageLayout {
  const l = locate(layout, id);
  if (!l || l.kind !== "widget") return layout;
  const next = clone(layout);
  const srcCol = next.sections[l.s].columns[l.c];
  const [w] = srcCol.widgets.splice(l.w, 1);
  const target = locate(next, columnId);
  if (target?.kind === "column") {
    const col = next.sections[target.s].columns[target.c];
    let idx = index ?? col.widgets.length;
    if (col.id === srcCol.id && l.w < idx) idx--;
    col.widgets.splice(Math.max(0, idx), 0, w);
  } else {
    next.sections.splice(sectionIndex, 0, makeSection([12], [[w]]));
  }
  return next;
}

export function moveSectionTo(layout: PageLayout, id: string, index: number): PageLayout {
  const from = layout.sections.findIndex((s) => s.id === id);
  if (from < 0) return layout;
  const next = clone(layout);
  const [s] = next.sections.splice(from, 1);
  next.sections.splice(from < index ? index - 1 : index, 0, s);
  return next;
}

export function insertSection(layout: PageLayout, widths: number[], index: number): { layout: PageLayout; id: string } {
  const next = clone(layout);
  const s = makeSection(widths);
  next.sections.splice(index, 0, s);
  return { layout: next, id: s.id };
}

/** Change a section's column layout, keeping widgets (extras merge into the last column). */
export function setSectionColumns(section: SectionNode, widths: number[]): SectionNode {
  const next = structuredClone(section);
  const fresh = makeSection(widths).columns;
  const cols = widths.map((w, i) => (next.columns[i] ? { ...next.columns[i], width: w } : fresh[i]));
  for (let i = widths.length; i < next.columns.length; i++) cols[cols.length - 1].widgets.push(...next.columns[i].widgets);
  next.columns = cols;
  return next;
}

export function replaceSection(layout: PageLayout, section: SectionNode): PageLayout {
  const next = clone(layout);
  const i = next.sections.findIndex((s) => s.id === section.id);
  if (i >= 0) next.sections[i] = section;
  return next;
}

export function findParentSectionId(layout: PageLayout, id: string): string | null {
  const l = locate(layout, id);
  return l ? layout.sections[l.s].id : null;
}
