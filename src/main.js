// Flight Control V2 — boot entry.
// Phase 2 scaffold: renders a placeholder only. The real boot sequence
// (theme → profile → roster source → router → render) arrives in Phase 3.
// See docs/PLAN.md §A for the target module layout.

const app = document.getElementById('app');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

app.replaceChildren(
  el('div', 'eyebrow', 'Flight Control · V2'),
  el('h1', null, 'Adaptive Aviation'),
  el('p', null, 'Scaffold build. The roster experience is under construction on the v2-redesign branch.'),
);
