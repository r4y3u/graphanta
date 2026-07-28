# Graphanta repository instructions

## Product intent

Graphanta is a local-first browser application for creating mathematical diagrams, tables, arrays, number lines, text, and structured mathematical expressions. Preserve the current responsive, approachable, precise interaction design. Prefer a systemic fix over a one-off patch whenever the same underlying problem can affect multiple tools or input methods.

## Non-negotiable distribution requirements

- GitHub Pages is published with **Deploy from a branch / `main` / `/(root)`**.
- The application must start from the repository-root `index.html`.
- The repository-root `index.html` must also work when opened directly with `file://`, without a network connection.
- Do not load React, JavaScript, CSS, fonts, icons, or other assets from a CDN or remote URL.
- Do not add `.github/workflows/deploy.yml` or another deployment workflow unless the user explicitly changes the publication method.
- Do not commit `node_modules/`, `dist/`, caches, logs, generated temporary files, or editor metadata.
- Keep all features from the current version unless the task explicitly removes or replaces them.

## Source and generated files

- `app.html` is the Vite development entry point.
- `src/` is the source of truth for application behavior and styling.
- `scripts/build-standalone.mjs` converts the Vite output into the self-contained repository-root `index.html`.
- The repository-root `index.html` is generated and committed because GitHub Pages serves the root branch directly.
- Do not hand-edit bundled application code inside `index.html`. Make changes in `src/`, then run the build so `index.html` is regenerated.
- Keep the `/graphanta/assets/...` to `dist/assets/...` fallback in `build-standalone.mjs` working for repository-name-prefixed GitHub Pages paths.
- When changing the app version, update every visible or build-time version source consistently, including `package.json`, `README.md`, and `APP_VERSION` in `scripts/build-standalone.mjs`.

## Development commands

Use the lockfile and do not replace the package manager.

```bash
npm ci
npm run check
npm run build
npm run verify:repo
```

For interactive development:

```bash
npm run dev
```

Before presenting a completed change, run at minimum:

1. `npm run check`
2. `npm run build`
3. `npm run verify:repo`

Also perform browser interaction checks when the environment permits them. If a required command cannot run, report the exact command, error, and which substitute checks were completed. Never claim a browser or build test passed unless it actually ran.

## Interaction and UI rules

- Preserve mouse, touch, and pen usability. A fix for one input mode must not silently break another.
- Test both wide and narrow/portrait layouts when changing panels, toolbars, dialogs, or positioning.
- Tool-group touch selection must continue to support: press and hold, list opens, drag to a choice, release to confirm.
- Preserve the responsive bottom placement of the tweak/function panels in portrait layouts.
- Use restrained motion that communicates hover, press, selection, and completion. Respect `prefers-reduced-motion`.
- Do not show selection/object bounds during an in-progress freehand stroke; show them only after the stroke is committed.
- Keep tweak values and shared settings synchronized where the existing UI promises linked behavior.
- Keep explanatory text behind the hint control rather than permanently occupying the tweak panel.
- Maintain keyboard focus visibility and avoid pointer-only interactions where a keyboard equivalent is practical.

## Data, history, and compatibility rules

- Do not break existing project files without an explicit migration path.
- Preserve project schema/version handling, duplicate-ID repair, value normalization, two-generation recovery, and safe rejection of malformed or oversized input.
- A user-visible edit should normally create one meaningful undo step, not many low-level steps.
- No-op operations must not consume history.
- Loading, creating, or recovering a project must not carry history from a different project.
- Keep manual-save dirty-state behavior and recovery cleanup consistent.

## Mathematical expression rules

- Preserve the structured math renderer and its current lightweight syntax, including fractions, complex fractions, roots, superscripts, subscripts, and absolute values.
- Treat mathematical expressions as editable objects with correct bounds and hit testing, not as plain unmeasured strings.
- Future syntax changes must retain compatibility with saved expressions whenever feasible.

## Implementation approach

1. Reproduce and identify the root cause.
2. Determine whether the issue belongs in shared geometry, selection, history, input, responsive-layout, storage, or rendering infrastructure.
3. Prefer the shared-layer correction when it prevents the same defect across several tools.
4. Keep the diff focused; do not refactor unrelated areas merely for style.
5. Add or extend deterministic checks when the bug can be tested without a full browser.
6. Regenerate the root `index.html` after source changes.
7. Summarize the root cause, generalized fix, files changed, tests run, and known limitations.

## Git and pull requests

- Work on a task branch. Do not force-push or rewrite `main`.
- Prefer one coherent commit or a small set of logically separated commits.
- Open a pull request rather than pushing directly to `main`.
- In the pull request, state whether the root `index.html` was regenerated and whether offline/static verification passed.
- Do not commit screenshots or diagnostic artifacts unless they are intentional project assets.

## Code review rules

- Flag any remote runtime dependency or asset reference as a release-blocking regression.
- Flag a source change that should affect the app but leaves the committed root `index.html` stale.
- Flag loss of project-file compatibility, undo consistency, autosave recovery, or malformed-input safety.
- Flag interactions that work only with a mouse when the corresponding tool previously supported touch.
- Flag a layout change that causes horizontal overflow or hides the tweak/function panels in portrait mode.
