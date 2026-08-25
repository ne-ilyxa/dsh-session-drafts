# dsh-session-drafts

[![CI](https://github.com/ne-ilyxa/dsh-session-drafts/actions/workflows/ci.yml/badge.svg)](https://github.com/ne-ilyxa/dsh-session-drafts/actions/workflows/ci.yml)

Cursor-style **draft chats** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): every New Session click mints a **fresh durable draft chat** that lives in the sidebar tree **as an ordinary row** — with its own unsent-text preview title, creation time, a pencil mark and a gray tint — and stays there across page reloads and host restarts, exactly like Cursor's (or Telegram's) chat list. No popup, no drafts menu.

The stock web shell reuses a workspace's single blank session (one empty chat per workspace, silently) and hides every other blank from the tree. This plugin removes the cap and moves the drafts **into the tree itself**.

## What it does

1. **Fresh drafts, never reuse.** `workspaces.startSession` — the one service entry behind every New Session surface (sidebar button, folder ＋, workspace picker) — is patched on the live `WorkspaceRuntime` instance to always call `session.create` (which persists the Session entity host-side) and open the result. The stock target policy is preserved: explicit workspace → current session's workspace → recent workspace; no workspace at all still clears into the pure New Session view.
2. **Drafts as tree rows (the v0.2 model).** The stock tree hides blank sessions other than the current one, so the plugin overlays the **data** instead of the renderer: `sessions.list.getSnapshot` is shadowed on the live store object (identity-stable, HMR-safe) to project every blank non-subagent session with `blank: false` and a draft title. The stock tree then renders each draft as a first-class row under its workspace — creation time in the trailing cell, the full row menu (**Rename** to pin a title, **Fork**, **Archive** = discard), click to open. The first sent message flips `blank` on the host and the row becomes an ordinary chat, untouched by the overlay. The same overlay feeds `connectWorkspace`'s blank-reuse scan (it reads the same list), so picking a workspace from the empty-state hero also mints a fresh draft instead of reusing the old blank.
3. **Live preview titles.** A draft's row title is its unsent composer text (Telegram-style, whitespace-collapsed, 60 chars), read live through `conversation.input` and mirrored to `localStorage` so previews survive reloads; an empty composer shows the localized *New Session*; an explicit rename always wins.
4. **Visual draft identity.** Draft rows get a gray title (theme-aware design token — gray-next-to-white in dark, muted-next-to-black in light) and a pencil icon in the row's empty status slot, painted by a MutationObserver + CSS marker. Purely cosmetic and self-healing: if the DOM shape drifts, the rows keep working and only lose the tint (in the flat "In one list" view the slot is absent, so flat rows keep the gray tint without the icon).
5. **Zero core edits.** Instance-level property shadowing guarded by `Symbol.for` markers (idempotent across HMR), restored on plugin unload, falling back to the stock behavior on any synchronous failure. No harness files are modified — install the plugin and it works.

## Install

```bash
dsh plugin --profile web add link:/path/to/dsh-session-drafts
# or from a published copy:
dsh plugin --profile web add @ne-ilyxa/dsh-session-drafts
```

Then restart the DSH web host (a profile boot composes the client bundle into the boot graph; hot activation is not attempted by this plugin).

### Release channels

- **npm** — `@ne-ilyxa/dsh-session-drafts`; published from CI via [trusted publishing (OIDC)](https://docs.npmjs.com/publishing-packages/publishing-with-trusted-publishing): no stored tokens, no 2FA prompts. Pushing a `v*` tag runs [release.yml](.github/workflows/release.yml): tests → prebuilt tarball attached to the GitHub Release → `npm publish --provenance`. The one-time setup is on npmjs.com: Account Settings → Publishing access → Add trusted publisher (repository `ne-ilyxa/dsh-session-drafts`, workflow `release.yml`, environment `release`).
- **Prebuilt tarball** — every GitHub Release carries `dsh-session-drafts.tgz` (built by `prepack`, installable without npm and without pnpm's `allowBuilds` build approval).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+N` | Mint a fresh draft from anywhere (works with zero drafts too; layout-independent — matches the physical KeyN, Russian layouts included) |

(The v0.1 `Ctrl+Alt+D` popover toggle died with the popover.)

## Verify it works

1. Click **New Session** twice — two draft rows appear under the workspace (pencil mark, gray tint, creation time), the previous one stays put.
2. Type in one and click **New Session** again — the first row's title is now your unsent text; refresh the page — everything is still there.
3. Hover a draft row → **⋯** → **Archive session** to discard it; send a message in one and it graduates into an ordinary chat row.
4. Host truth: each click produced a `session.create` — sessions survive a page refresh and the host restart.

## Screenshots

The v0.1 screenshots below show the retired popover model. v0.2 renders drafts as ordinary tree rows (see *Verify it works*); screenshots pending.

![Drafts popover listing four blank sessions](assets/drafts-popover.png)

![Draft switched, current marker moved](assets/drafts-switched.png)

## Development

```bash
pnpm install
pnpm run check     # typecheck + build + node --test tests/*.test.mjs
pnpm run build     # host no-op + browser bundle (lib/client.js, module-loader wrapped)
pnpm test:e2e      # full UI flow on an isolated DSH host (needs a harness checkout + Chrome)
```

The E2E smoke boots a throwaway DSH web host (its own `DSH_HOME` scratch profile with this checkout installed), drives the real UI in headless Chrome, and asserts host-side session truth plus the tree DOM. It skips with exit 0 when the environment is missing — configure via `E2E_DSH_ROOT` (harness checkout, default `/home/ilya/deepseek-harness`) and `CHROME_PATH` (default `/usr/bin/google-chrome`).

Layout:

- `src/index.ts` — host half, a deliberate no-op (the package must be a loadable Profile Bundle; all behavior is browser-side).
- `src/client/index.tsx` — browser half: the `startSession` patch, the `sessions.list` draft projection (`projectDraftList`), the live preview mirror, the DOM row marker, the hotkey, zh/en dictionaries. No React, no slots — the stock tree renders the drafts.
- `tests/` — pure-logic tests over the built bundle (VM-loaded) + package-layout guards; `tests/e2e/` — the isolated-host UI smoke.

## Compatibility

- DSH client runtime `0.1.0-rc.8`-era service shapes (`workspaces.startSession`, `sessions.list`, `sessions.create`, `conversation.input`).
- The patches degrade loudly-but-safely: if the runtime shape ever drifts, a console warning fires and the corresponding piece stays stock.

## License

BSD-3-Clause © ne-ilyxa
