# Inside DéjàML

A scroll-driven 3D explainer of how DéjàML works, published at
<https://aayushbhat07.github.io/dejaml/>. It follows one real study, the ROCKET
paper's 0.906 test accuracy on UCR ECG200, room by room through DéjàML's
Research Campus:

1. **Upload:** hash the PDF and find the repository.
2. **Seal:** the paper's value is sealed under a SHA-256 commitment.
3. **Analyse:** the Paper Analyst and Repository Analyst work apart.
4. **Plan:** the Reproduction Planner writes a plan, which passes a deterministic policy gate.
5. **Prepare:** inputs are verified by hash.
6. **Run:** Lab Engineers run it in sealed Docker labs with no network.
7. **Review:** the measurement is locked and judged blind.
8. **Reveal:** the seal is opened and the numbers compared in code.
9. **Clean up:** every lab is destroyed and the receipts filed.

Things a visitor can try:

- **The seal is real.** The page seals the claim in the visitor's browser with
  DéjàML's own `sealTarget()` algorithm (canonical JSON, 32-byte nonce,
  SHA-256), then recomputes and verifies it at the reveal.
- **The policy gate is interactive.** Tick a rule (GPU, unlisted host, over
  budget, unreviewed adapter, stated expected result) and the plan is blocked.
- **The Supervisor ladder** shows that a verdict can be lowered but never raised.
- **Agents are inspectable.** Hover any agent in 3D to see its tools and budget.

Every number on the page comes from the root README,
`acceptance/cases/rocket-ecg200.json` and the source code.

## Files

| Path | What it is |
|---|---|
| `index.src.html` | Markup and CSS. The head material comes first, then the page from the skip link on. |
| `js/10_page.js` | Page logic: the live seal, policy gate, Supervisor ladder, study strip and no-WebGL fallback. |
| `js/20_campus.js` | The 3D Research Campus: scene, agents, labels, camera stations and the scroll-driven story. |
| `models/RobotExpressive.glb` | The agents' robot (CC0, see `models/RobotExpressive-README.md`), embedded into the page at build time. |
| `build.mjs` | Concatenates `js/NN_*.js` into one module and writes `dist/index.html`. |

## The Research Road

`research-paper/` on the site is a second page: DéjàML's timeline as one raised
walkway on the same model table, with a robot that walks it as you scroll. The
indigo line is drawn up to "now":

1. **The hackathon brief** that started it.
2. **The plan**: architecture, roadmap and three principles (28 Sep).
3. **The first working slice**: one curated paper, end to end.
4. **A shortcut taken back out** after review (29 Sep).
5. **The blind agent team** with the sealed target (PR #4, 2 Oct).
6. **Three real results**, each Partially reproduced.
7. **Showing the work**: the live campus, the README and this site.
8. **Any lightweight paper**: the open-paper work in review.
9. **The research question**: does seeing the number bias the agent? Four
   lanes fork off the road for blind, sighted, sighted + rule and decoy.
10. **The smoke test**: 12 runs, blind and decoy, no drift (30 Oct).
11. **The 39-run pilot**: no guard rail, a reward for matching, two new papers,
    weaker models and the Urban seed sweep (30 Oct).
12. **Draft and review**: run records published, citations checked, a
    five-perspective review and a reframe (31 Oct).
13. **Now**: the first paper is submitted to Empirical Software Engineering
    and under review (31 Oct).

Past "now" the road is a dashed plan with see-through models: the full study.
Edit `research/progress.json` as the study moves (`now` is the stop where the
line ends; `smoke`, `pilot` and `paper` fill the cards), then rebuild.

| Path | What it is |
|---|---|
| `research/index.src.html` | Markup and CSS. Head material, then `<!--BODY-->`, then the page. |
| `research/js/10_page.js` | The stops, the progress line in the top bar, and the cards filled from `progress.json`. |
| `research/js/20_road.js` | The 3D road: scene, stops and their models, the robots, camera views and pins. |
| `research/progress.json` | Where the study stands. |
| `research/build.mjs` | Writes `dist/research-paper/index.html`. `site/build.mjs` runs it. |

## Build and preview

```bash
node site/build.mjs        # → site/dist/index.html + site/dist/research-paper/index.html
npx serve site/dist        # open http://localhost:3000
```

The page needs no install. three.js r169 loads from jsDelivr and the fonts
(Newsreader, Schibsted Grotesk, JetBrains Mono) from Google Fonts, so previews
need a network connection. The explainer's "Research paper" links point at
`research-paper/`; `--paper=URL` points them elsewhere and `--paper=none` hides
them.

## Publishing

`.github/workflows/site.yml` builds the page and publishes it to GitHub Pages on
every push to `main` that touches `site/`. It can also be run by hand from the
Actions tab. GitHub Pages must be set to deploy from **GitHub Actions** once, in
the repository's Settings → Pages.
