---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: HTML visual pattern contracts
  last_verified: 2026-07-19
  sources: [src/context_room.mjs, docs/features/html-visual-documents.md, docs/context-room-visual-components.html, docs/context-room-data-visual-components.html]
---

# HTML Visual Patterns

Use HTML when spatial structure makes a complex subject easier to understand. See the [diagram catalog](../context-room-visual-components.html) and [data catalog](../context-room-data-visual-components.html).

## Do Not Diagram Simple Ideas

Use prose, bullets, or a short comparison when the subject has fewer than three meaningful relationships. A diagram is justified when it clarifies several dependencies, branches, actors, states, boundaries, layers, or feedback effects.

Every diagram must answer one explicit question. If removing the layout preserves the same clarity, use Markdown instead.

## Diagram Grammar

Build diagrams from these reusable primitives:

- Canvas: `.cr-diagram` inside `.cr-diagram-scroll`; set `--cr-cols` when twelve columns are not suitable.
- Node: `.cr-diagram-node`; position it with `--col`, `--row`, `--span`, and `--rows`.
- Node kinds: `data-kind="external|state|decision|event|store"`.
- Horizontal link: `.cr-diagram-edge[data-dir="h"]`; position it with `--col`, `--row`, and `--span`.
- Vertical link: `.cr-diagram-edge[data-dir="v"]`; position it with `--col`, `--row`, and `--rows`.
- Link label: visible text inside the edge. Name any relationship that is not self-evident.
- Group: `.cr-diagram-group` for a conceptual cluster.
- Boundary: `.cr-diagram-boundary` for ownership, trust, process, or deployment boundaries.
- Lane: `.cr-diagram-lane` for an actor or responsibility row.
- Junction: `.cr-diagram-junction` where links branch or merge.
- Note: `.cr-diagram-note` for a constraint or exception that changes interpretation.
- Legend: `.cr-diagram-legend` when line color or style carries meaning.

Keep node labels short. Put detailed explanation before or after the diagram, not inside every node.

## Five Canonical Diagrams

Choose by the question the reader must answer:

1. **System landscape** — `.cr-system-landscape`: what exists, what is inside the boundary, and how the parts exchange information or authority.
2. **Causal chain** — `.cr-causal-chain-map`: why an outcome occurs, through which mechanisms, and which effect reinforces the problem.
3. **Branching decision** — `.cr-branching-decision`: which path to choose from explicit conditions and outcomes.
4. **Actor sequence** — `.cr-actor-sequence`: who acts, in what order, and where responsibility changes hands.
5. **Reasoning map** — `.cr-reasoning-map`: what supports a claim, what challenges it, and what conclusion follows.

Adapt these five with the shared primitives instead of creating another near-duplicate template.

## Interaction

Use native, keyboard-accessible interaction when it helps the reader explore the visual:

- Switch between a small number of views with radio inputs and visible labels.
- Use `<details>` and `<summary>` to reveal secondary explanation inside a node.
- Keep the primary meaning visible before interaction.
- Give controls literal labels and a visible focus state.
- Preserve a useful static reading order in the source.

Do not require hover, animation, or hidden state to understand the document. Preview scripts remain blocked; use semantic HTML and CSS rather than embedding JavaScript.

## Large Maps

- Treat a large HTML visual as a complete document: state the scenario, decision or question, and represented scale before the map; summarize the primary reading, risk, and next question after it.
- Keep the map inside a bounded, focusable `.cr-diagram-scroll` viewport instead of expanding the whole page.
- Prefer a full-size scrollable canvas over shrinking labels until they become hard to read.
- Expand the grid to sixteen columns when twelve cannot separate clusters and crossings clearly.
- Keep the main path directional and group related nodes before adding more space.
- Split the subject when one view exceeds fifteen meaningful nodes or link crossings obscure the reading order.

The same primitives must also work for a small subject. Use three to five nodes without forced scrolling; do not pad a small idea to imitate the large examples.

## Diagram Quality Rules

- Show five to fifteen nodes in one diagram. Split larger subjects by boundary or question.
- Keep one direction for the main reading path: left to right or top to bottom.
- Avoid crossing links. Reposition nodes or split the diagram when crossings accumulate.
- Name actors, states, boundaries, and non-obvious links.
- Use color only as a secondary signal and include a legend when it changes meaning.
- Do not use a diagram as decoration around a sentence.

## Quantitative And Operational Patterns

The original forty patterns remain available in the [data catalog](../context-room-data-visual-components.html).

- Summary: `.cr-metrics`, `.cr-kpi-grid`, `.cr-stat-strip`, `.cr-scorecard`, `.cr-progress-list`, `.cr-bullet-chart`, `.cr-gauge`, `.cr-ring`, `.cr-delta-grid`, `.cr-status-summary`.
- Comparison: `.cr-comparison`, `.cr-before-after`, `.cr-pros-cons`, `.cr-decision-matrix`, `.cr-feature-matrix`, `.cr-quadrant`, `.cr-spectrum`, `.cr-ranking`, `.cr-benchmark`, `.cr-distribution`.
- Charts: `.cr-bar-chart`, `.cr-grouped-bars`, `.cr-stacked-bar`, `.cr-diverging-bars`, `.cr-lollipop-chart`, `.cr-dot-plot`, `.cr-histogram`, `.cr-sparkline`, `.cr-heatmap`, `.cr-waterfall`.
- Operations: `.cr-timeline`, `.cr-roadmap`, `.cr-swimlane`, `.cr-flow`, `.cr-cycle`, `.cr-funnel`, `.cr-pyramid`, `.cr-tree`, `.cr-dependency-chain`, `.cr-status-board`.
