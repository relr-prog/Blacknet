"use strict";

// Letterboxing math. The point of the feature is that the page's viewport lands
// on a small set of sizes regardless of the exact window, so the tests are about
// the grid and the fallback, not about pixels.

const test = require("node:test");
const assert = require("node:assert");

const { snap, box } = require("../src/main/letterbox");

test("a length snaps down to the nearest whole step", () => {
  assert.equal(snap(1354, 200), 1200);
  assert.equal(snap(200, 200), 200, "an exact multiple is unchanged");
  assert.equal(snap(595, 100), 500);
});

test("a length below one step is not blown up to a step", () => {
  assert.equal(snap(199, 200), 0);
  assert.equal(snap(50, 100), 0);
});

test("a step that is missing or trivial leaves the length as it is", () => {
  assert.equal(snap(1354, undefined), 1354);
  assert.equal(snap(1354, 1), 1354);
  assert.equal(snap(1354, 0), 1354);
});

test("bad input is zero, not a throw", () => {
  assert.equal(snap(NaN, 200), 0);
  assert.equal(snap(-5, 200), 0);
  assert.equal(snap(0, 200), 0);
});

test("the box rounds down and centers the leftover", () => {
  const framed = box(1354, 503, { widthStep: 200, heightStep: 100 });
  assert.deepEqual(framed, { x: 77, y: 1, width: 1200, height: 500 });
});

test("two near-identical windows land on the same viewport", () => {
  const a = box(1354, 503, { widthStep: 200, heightStep: 100 });
  const b = box(1340, 505, { widthStep: 200, heightStep: 100 });
  assert.equal(a.width, b.width, "a 14px width difference is not a distinguishing bit");
  assert.equal(a.height, b.height);
});

test("a window smaller than a step keeps its real size", () => {
  assert.deepEqual(box(150, 80, { widthStep: 200, heightStep: 100 }), {
    x: 0,
    y: 0,
    width: 150,
    height: 80,
  });
});

test("no grid configured means no letterbox", () => {
  assert.deepEqual(box(1354, 503, {}), { x: 0, y: 0, width: 1354, height: 503 });
});

test("the box never exceeds the area it was given", () => {
  for (const [w, h] of [
    [1354, 503],
    [200, 100],
    [640, 480],
    [1920, 1000],
  ]) {
    const framed = box(w, h, { widthStep: 200, heightStep: 100 });
    assert.ok(framed.width <= w && framed.height <= h, `${w}x${h} -> ${framed.width}x${framed.height}`);
    assert.ok(framed.x >= 0 && framed.y >= 0);
  }
});
