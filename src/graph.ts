import type { Commit, GraphRow, LogRow, Segment, Stub } from './protocol';

/** Edges spanning more rows than this are drawn as short stubs instead of lanes. */
export const LONG_EDGE = 30;

/**
 * Lays commits out on lanes, top to bottom, one row at a time. Commits must
 * arrive children-before-parents (git log --date-order / --topo-order).
 *
 * Each row is drawn in two halves: the top half joins the lanes entering the
 * row to the commit's node, the bottom half joins the node and the
 * pass-through lanes to the lanes leaving the row. Freed lanes are compacted
 * away in the bottom half, so lines to the right of a closed branch slide left.
 *
 * An edge to a parent more than LONG_EDGE rows below gets no lane: the child
 * gets a stub pointing down, the parent one pointing up. Without this, every
 * merged feature branch holds a lane open across the whole log.
 *
 * The state survives between pages, so a second page continues the graph.
 */
export class GraphLayout {
  private lanes: (string | null)[] = [];
  private colors: number[] = [];
  private nextColor = 0;
  /** Hidden edges waiting for their parent row: parent hash -> stubs. */
  private incoming = new Map<string, Stub[]>();

  constructor(readonly known?: Set<string>, private readonly longEdge = LONG_EDGE) {}

  add(commits: Commit[]): LogRow[] {
    const pos = new Map<string, number>();
    commits.forEach((c, i) => pos.set(c.hash, i));
    return commits.map((c, i) => ({ ...c, graph: this.row(c, i, pos, commits.length) }));
  }

  private newColor(): number {
    return this.nextColor++;
  }

  /** Whether the edge from row i to parent p should be hidden. */
  private isLong(i: number, p: string, pos: Map<string, number>, pageLength: number): boolean {
    if (!this.longEdge) return false;
    const j = pos.get(p);
    if (j !== undefined) return j - i > this.longEdge;
    // Parent not in this page: certainly long if the rest of the page is already longer.
    return pageLength - i > this.longEdge;
  }

  private row(c: Commit, index: number, pos: Map<string, number>, pageLength: number): GraphRow {
    const top = this.lanes;
    const topColors = this.colors;
    const parents = this.known ? c.parents.filter((p) => this.known!.has(p)) : c.parents;

    let lane = top.indexOf(c.hash);
    let color: number;
    const mid = top.slice();
    const midColors = topColors.slice();
    const up = this.incoming.get(c.hash);
    this.incoming.delete(c.hash);
    if (lane < 0) {
      lane = mid.indexOf(null);
      if (lane < 0) lane = mid.length;
      // A commit reached only by hidden edges keeps the colour of the first one.
      color = up?.length ? up[0].color : this.newColor();
    } else {
      color = topColors[lane];
    }

    const topSegs: Segment[] = [];
    for (let j = 0; j < top.length; j++) {
      const h = top[j];
      if (h === null) continue;
      if (h === c.hash) {
        topSegs.push({ a: j, b: lane, color: topColors[j] });
        mid[j] = null;
      } else {
        topSegs.push({ a: j, b: j, color: topColors[j] });
      }
    }
    while (mid.length <= lane) {
      mid.push(null);
      midColors.push(0);
    }
    mid[lane] = null;

    // Edges leaving the node, as lane indexes in `mid`.
    const edges: { to: number; color: number }[] = [];
    const created = new Set<number>();
    const down: Stub[] = [];
    parents.forEach((p, i) => {
      const k = mid.indexOf(p);
      if (k >= 0) {
        edges.push({ to: k, color: i === 0 ? color : midColors[k] });
        return;
      }
      if (this.isLong(index, p, pos, pageLength)) {
        const stub: Stub = { to: p, color: i === 0 ? color : this.newColor() };
        down.push(stub);
        this.incoming.set(p, [...(this.incoming.get(p) ?? []), { to: c.hash, color: stub.color }]);
        return;
      }
      if (i === 0) {
        mid[lane] = p;
        midColors[lane] = color;
        edges.push({ to: lane, color });
        return;
      }
      let slot = -1;
      for (let s = 0; s < mid.length; s++) {
        if (mid[s] === null && s !== lane) {
          slot = s;
          break;
        }
      }
      if (slot < 0) {
        slot = mid.length;
        mid.push(null);
        midColors.push(0);
      }
      const nc = this.newColor();
      mid[slot] = p;
      midColors[slot] = nc;
      created.add(slot);
      edges.push({ to: slot, color: nc });
    });

    // Compact: drop null lanes.
    const remap: number[] = [];
    const next: (string | null)[] = [];
    const nextColors: number[] = [];
    for (let j = 0; j < mid.length; j++) {
      if (mid[j] === null) continue;
      remap[j] = next.length;
      next.push(mid[j]);
      nextColors.push(midColors[j]);
    }

    const bottomSegs: Segment[] = [];
    for (let j = 0; j < mid.length; j++) {
      if (mid[j] === null || created.has(j) || j === lane) continue;
      bottomSegs.push({ a: j, b: remap[j], color: midColors[j] });
    }
    for (const e of edges) bottomSegs.push({ a: lane, b: remap[e.to], color: e.color });

    this.lanes = next;
    this.colors = nextColors;

    const width = Math.max(top.length, mid.length, lane + 1);
    const row: GraphRow = { lane, color, top: topSegs, bottom: bottomSegs, width };
    if (down.length) row.down = down;
    if (up?.length) row.up = up;
    return row;
  }
}
