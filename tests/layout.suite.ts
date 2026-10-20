import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as L from "../admin/lib/layout";
import { makeSection, makeWidget, cloneWithNewIds } from "../shared/widgets";
import type { PageLayout } from "../shared/types";

/** Two sections: [A, B] in one column, then two columns [C] [D]. */
function fixture() {
  const a = makeWidget("heading", { text: "A" });
  const b = makeWidget("text", { html: "B" });
  const c = makeWidget("button", { label: "C" });
  const d = makeWidget("image", { src: "D" });
  const layout: PageLayout = { sections: [makeSection([12], [[a, b]]), makeSection([6, 6], [[c], [d]])] };
  return { layout, a, b, c, d };
}
const ids = (l: PageLayout) => l.sections.map((s) => s.columns.map((c) => c.widgets.map((w) => w.props.text ?? w.props.html ?? w.props.label ?? w.props.src)));

describe("locate", () => {
  it("finds sections, columns and widgets", () => {
    const { layout, b, d } = fixture();
    assert.deepEqual(L.locate(layout, b.id), { kind: "widget", s: 0, c: 0, w: 1 });
    assert.deepEqual(L.locate(layout, d.id), { kind: "widget", s: 1, c: 1, w: 0 });
    assert.equal(L.locate(layout, layout.sections[1].columns[1].id)!.kind, "column");
    assert.equal(L.locate(layout, layout.sections[1].id)!.kind, "section");
    assert.equal(L.locate(layout, "missing"), null);
    assert.equal(L.locate(layout, null), null);
  });
});

describe("immutable updates", () => {
  it("never mutates the input layout", () => {
    const { layout, a } = fixture();
    const before = JSON.stringify(layout);
    L.updateNodeProps(layout, a.id, { text: "changed" });
    L.removeNode(layout, a.id);
    L.duplicateNode(layout, a.id);
    L.moveNode(layout, a.id, 1);
    L.insertWidget(layout, makeWidget("spacer"), null, null);
    assert.equal(JSON.stringify(layout), before);
  });

  it("updates widget and section props", () => {
    const { layout, a } = fixture();
    const next = L.updateNodeProps(L.updateNodeProps(layout, a.id, { text: "A2" }), layout.sections[0].id, { background: "dark" });
    assert.equal(next.sections[0].columns[0].widgets[0].props.text, "A2");
    assert.equal(next.sections[0].props.background, "dark");
  });
});

describe("inserting", () => {
  it("inserts into a column at an index, or as a new section", () => {
    const { layout } = fixture();
    const x = makeWidget("quote", { text: "X" });
    const inCol = L.insertWidget(layout, x, layout.sections[0].columns[0].id, 1);
    assert.deepEqual(ids(inCol)[0], [["A", "X", "B"]]);
    const asSection = L.insertWidget(layout, x, null, null, 1);
    assert.equal(asSection.sections.length, 3);
    assert.deepEqual(ids(asSection)[1], [["X"]]);
  });

  it("inserts relative to the selection", () => {
    const { layout, a } = fixture();
    const x = () => makeWidget("quote", { text: "X" });
    assert.deepEqual(ids(L.insertNearSelection(layout, x(), a.id))[0], [["A", "X", "B"]]);
    assert.deepEqual(ids(L.insertNearSelection(layout, x(), layout.sections[1].columns[1].id))[1], [["C"], ["D", "X"]]);
    assert.deepEqual(ids(L.insertNearSelection(layout, x(), layout.sections[1].id))[1], [["C", "X"], ["D"]]);
    assert.equal(L.insertNearSelection(layout, x(), null).sections.length, 3);
  });

  it("inserts an empty section with the given column widths", () => {
    const { layout } = fixture();
    const r = L.insertSection(layout, [4, 4, 4], 0);
    assert.equal(r.layout.sections[0].id, r.id);
    assert.deepEqual(r.layout.sections[0].columns.map((c) => c.width), [4, 4, 4]);
  });
});

describe("removing", () => {
  it("removes widgets and sections", () => {
    const { layout, b } = fixture();
    assert.deepEqual(ids(L.removeNode(layout, b.id))[0], [["A"]]);
    assert.equal(L.removeNode(layout, layout.sections[0].id).sections.length, 1);
  });

  it("merges a removed column's widgets and width into its neighbour", () => {
    const { layout } = fixture();
    const next = L.removeNode(layout, layout.sections[1].columns[1].id);
    assert.equal(next.sections[1].columns.length, 1);
    assert.equal(next.sections[1].columns[0].width, 12);
    assert.deepEqual(ids(next)[1], [["C", "D"]]);
  });

  it("removes the whole section when its only column is removed", () => {
    const { layout } = fixture();
    assert.equal(L.removeNode(layout, layout.sections[0].columns[0].id).sections.length, 1);
  });
});

describe("duplicating", () => {
  it("copies widgets and sections with fresh ids", () => {
    const { layout, a } = fixture();
    const w = L.duplicateNode(layout, a.id);
    assert.ok(w.newId && w.newId !== a.id);
    assert.deepEqual(ids(w.layout)[0], [["A", "A", "B"]]);
    const s = L.duplicateNode(layout, layout.sections[1].id);
    const [orig, copy] = [s.layout.sections[1], s.layout.sections[2]];
    assert.equal(copy.id, s.newId);
    const allIds = (sec: typeof orig) => [sec.id, ...sec.columns.flatMap((c) => [c.id, ...c.widgets.map((x) => x.id)])];
    assert.equal(allIds(orig).filter((id) => allIds(copy).includes(id)).length, 0, "copied section must not share any ids");
  });

  it("refuses to duplicate a column", () => {
    const { layout } = fixture();
    assert.equal(L.duplicateNode(layout, layout.sections[1].columns[0].id).newId, null);
  });

  it("deep-clones with new ids via cloneWithNewIds", () => {
    const { layout } = fixture();
    const copy = cloneWithNewIds(layout.sections[0]);
    assert.notEqual(copy.columns[0].widgets[0].id, layout.sections[0].columns[0].widgets[0].id);
    copy.columns[0].widgets[0].props.text = "changed";
    assert.equal(layout.sections[0].columns[0].widgets[0].props.text, "A");
  });
});

describe("moving", () => {
  it("moves widgets within a column and hops into the next section at the edges", () => {
    const { layout, a, b } = fixture();
    assert.deepEqual(ids(L.moveNode(layout, a.id, 1))[0], [["B", "A"]]);
    const hopped = L.moveNode(layout, b.id, 1);
    assert.deepEqual(ids(hopped), [[["A"]], [["B", "C"], ["D"]]]);
    assert.equal(L.moveNode(layout, a.id, -1), layout, "no-op at the very top");
  });

  it("moves sections up and down", () => {
    const { layout } = fixture();
    const next = L.moveNode(layout, layout.sections[1].id, -1);
    assert.equal(next.sections[0].id, layout.sections[1].id);
  });

  it("drags a widget to another column, adjusting the index within the same column", () => {
    const { layout, a, b } = fixture();
    const toOther = L.moveWidgetTo(layout, a.id, layout.sections[1].columns[1].id, 0, 0);
    assert.deepEqual(ids(toOther), [[["B"]], [["C"], ["A", "D"]]]);
    const sameColDown = L.moveWidgetTo(layout, a.id, layout.sections[0].columns[0].id, 2, 0);
    assert.deepEqual(ids(sameColDown)[0], [["B", "A"]]);
    const toNewSection = L.moveWidgetTo(layout, b.id, null, null, 2);
    assert.deepEqual(ids(toNewSection), [[["A"]], [["C"], ["D"]], [["B"]]]);
  });

  it("drags a section to a new position", () => {
    const { layout } = fixture();
    const [s0, s1] = layout.sections;
    assert.deepEqual(L.moveSectionTo(layout, s0.id, 2).sections.map((s) => s.id), [s1.id, s0.id]);
    assert.deepEqual(L.moveSectionTo(layout, s1.id, 0).sections.map((s) => s.id), [s1.id, s0.id]);
    assert.deepEqual(L.moveSectionTo(layout, s0.id, 0).sections.map((s) => s.id), [s0.id, s1.id]);
  });
});

describe("changing columns", () => {
  it("keeps widgets when switching to fewer columns", () => {
    const { layout } = fixture();
    const one = L.setSectionColumns(layout.sections[1], [12]);
    assert.equal(one.columns.length, 1);
    assert.deepEqual(one.columns[0].widgets.map((w) => w.props.label ?? w.props.src), ["C", "D"]);
  });

  it("adds empty columns and keeps existing column ids when switching to more", () => {
    const { layout } = fixture();
    const three = L.setSectionColumns(layout.sections[1], [4, 4, 4]);
    assert.deepEqual(three.columns.map((c) => c.width), [4, 4, 4]);
    assert.equal(three.columns[0].id, layout.sections[1].columns[0].id);
    assert.equal(three.columns[2].widgets.length, 0);
  });

  it("replaces a section in the layout", () => {
    const { layout } = fixture();
    const next = L.replaceSection(layout, L.setSectionColumns(layout.sections[0], [6, 6]));
    assert.equal(next.sections[0].columns.length, 2);
    assert.equal(L.findParentSectionId(next, next.sections[0].columns[0].widgets[0].id), next.sections[0].id);
  });
});
