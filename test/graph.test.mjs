import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Git } = require('../dist/core/git.js');
const { GraphLayout } = require('../dist/core/graph.js');

import { testRepo } from './fixture.mjs';
const REPO = testRepo();

// Follow every lane from row to row and check it lands on the commit it claims to lead to.
function checkContinuity(rows) {
  const pendingUp = new Set();
  let lanes = []; // hash expected on each lane entering the row
  for (const [i, r] of rows.entries()) {
    const g = r.graph;
    const tops = g.top.map((s) => s.a).sort((a, b) => a - b);
    const entering = lanes.map((h, j) => (h ? j : -1)).filter((j) => j >= 0);
    assert.deepEqual(tops, entering, `row ${i}: top segments must start at every open lane`);
    for (const s of g.top) {
      if (lanes[s.a] === r.hash) assert.equal(s.b, g.lane, `row ${i}: lane for this commit must end at its node`);
      else assert.equal(s.b, s.a, `row ${i}: pass-through must stay put in the top half`);
    }
    // Rebuild the lanes leaving this row from the bottom segments.
    const next = [];
    for (const s of g.bottom) {
      if (s.a === g.lane) continue;
      next[s.b] = lanes[s.a];
    }
    const fromNode = g.bottom.filter((s) => s.a === g.lane).map((s) => s.b);
    const hidden = new Set((g.down ?? []).map((s) => s.to));
    for (const s of g.down ?? []) pendingUp.add(`${s.to}<${r.hash}`);
    for (const s of g.up ?? []) assert.ok(pendingUp.delete(`${r.hash}<${s.to}`), `row ${i}: arrow up without a matching arrow down`);
    const shown = r.parents.filter((p) => !hidden.has(p) || lanes.includes(p));
    assert.equal(fromNode.length + hidden.size, r.parents.length, `row ${i}: one edge or arrow per parent`);
    for (const [k, b] of fromNode.entries()) {
      const p = shown[k];
      assert.ok(next[b] === undefined || next[b] === p, `row ${i}: edge to parent must join a lane already heading there`);
      next[b] = p;
    }
    lanes = Array.from({ length: next.length }, (_, j) => next[j] ?? null);
    assert.ok(!lanes.includes(null), `row ${i}: lanes are compacted`);
  }
  return { rows };
}

function maxWidth(rows) {
  const w = rows.map((r) => r.graph.width).sort((a, b) => a - b);
  return { median: w[w.length >> 1], max: w[w.length - 1] };
}

test('graph is continuous over the whole history', async () => {
  const git = new Git(REPO);
  for (const order of ['date', 'topo']) {
    const commits = await git.log({}, order, 0, 100000);
    const layout = new GraphLayout();
    const rows = layout.add(commits);
    checkContinuity(rows);
  }
});

test('graph continues across pages', async () => {
  const git = new Git(REPO);
  const all = await git.log({}, 'date', 0, 100000);
  const layout = new GraphLayout();
  const rows = [];
  for (let skip = 0; skip < all.length; skip += 997) rows.push(...layout.add(await git.log({}, "date", skip, 997)));
  assert.equal(rows.length, all.length);
  checkContinuity(rows);
});

test('merge commits get one change group per parent', async () => {
  const git = new Git(REPO);
  const merges = (await git.log({}, 'date', 0, 100000)).filter((c) => c.parents.length > 1);
  if (!merges.length) return;
  const m = merges[0];
  const { groups } = await git.commitChanges(m.hash, m.parents, new Map());
  assert.equal(groups.length, m.parents.length);
  assert.deepEqual(groups.map((g) => g.base), m.parents);
});
