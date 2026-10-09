"use strict";

// Letterboxing, the way Tor Browser does it.
//
// A page can read its own viewport size (innerWidth/innerHeight, or media
// queries) and use a near-unique width x height as a fingerprint. Tor's answer
// is to round the page's content area down to a fixed grid, so two windows a few
// pixels apart report the same size; the leftover pixels become a plain
// background margin - the "letterbox". The shell keeps the address bar at the
// full window width and only boxes the page below it.

// Round a length down to a whole number of steps. Never returns more than the
// input, so a window smaller than one step is not blown up past its own edge;
// the caller falls back to the raw size in that case.
function snap(length, step) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(step) || step <= 1) return Math.floor(length);
  return Math.floor(length / step) * step;
}

// The content box inside a window: width x height, centered. Steps default to
// Tor's 200 x 100 grid. A dimension that cannot hold a full step is left at its
// raw size, so very small windows are not boxed to nothing.
function box(width, height, { widthStep, heightStep } = {}) {
  const w = widthStep > 1 ? snap(width, widthStep) : Math.floor(width);
  const h = heightStep > 1 ? snap(height, heightStep) : Math.floor(height);
  const innerWidth = w > 0 ? w : Math.floor(width);
  const innerHeight = h > 0 ? h : Math.floor(height);
  return {
    x: Math.floor((width - innerWidth) / 2),
    y: Math.floor((height - innerHeight) / 2),
    width: innerWidth,
    height: innerHeight,
  };
}

module.exports = { snap, box };
