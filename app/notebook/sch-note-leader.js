"use strict";

// Input is the located anchor from AtriumReviewComments.locate. A leader is
// layout in sheet millimetres, derived again when either owner moves.
globalThis.AtriumSchNoteLeader = (() => {
  const mid = (low, high) => low + (high - low) / 2;

  function route(card, anchor) {
    const [x, y] = anchor.at, target = anchor.live && anchor.box ? anchor.box : [x, y, x, y];
    const xGap = Math.max(target[0] - card[2], card[0] - target[2]);
    const yGap = Math.max(target[1] - card[3], card[1] - target[3]);
    const broken = !anchor.live;
    if (xGap < 0 && yGap < 0) return {points: [], broken, covered: true};

    // Both ends face the separating channel. Every elbow lies outside the
    // target and the note. Swapping axes gives the identical vertical route.
    const axis = xGap >= yGap ? 0 : 1, across = 1 - axis;
    const forward = card[axis + 2] <= target[axis];
    const start = card[axis + (forward ? 2 : 0)], end = target[axis + (forward ? 0 : 2)];
    const lane = mid(start, end);
    const near = mid(card[across], card[across + 2]), far = mid(target[across], target[across + 2]);
    const pair = (a, b) => axis === 0 ? [a, b] : [b, a];
    const points = [pair(start, near)];
    if (near !== far) {
      if (lane !== start) points.push(pair(lane, near));
      if (lane !== end) points.push(pair(lane, far));
    }
    const last = points.at(-1), endpoint = pair(end, far);
    if (last[0] !== endpoint[0] || last[1] !== endpoint[1]) points.push(endpoint);
    return {points, broken, covered: false};
  }

  return Object.freeze({route});
})();
