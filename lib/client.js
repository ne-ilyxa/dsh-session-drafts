window.__ModuleLoader__.load({ id: "@ne-ilyxa/dsh-session-drafts", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * dsh-session-drafts, browser half.
 *
 * Cursor-style drafts, fully in-tree (no popover, no popup menu):
 *
 * 1. Never stack empty drafts — `workspaces.startSession` (every New Session
 *    surface: the sidebar button, the folder ＋, the workspace picker) is
 *    patched on the live WorkspaceRuntime instance with the Cursor rule: a
 *    click first jumps to the workspace's existing EMPTY draft (a blank
 *    session whose composer carries no unsent text) and only mints a fresh
 *    durable session (`session.create` persists the Session entity before
 *    any message) when every draft is occupied. Typed drafts stay put as
 *    their own chats; empty placeholders never multiply.
 *
 * 2. Draft projection — the stock tree hides blank sessions other than the
 *    current one (`sessionVisible`: blank ⇒ visible only when current), so
 *    several drafts can never render as rows. Instead of fighting the
 *    renderer, the plugin overlays the DATA: `sessions.list.getSnapshot` is
 *    shadowed on the live store object (identity-stable — every reader that
 *    already holds the observable keeps working, HMR included) to project
 *    each blank non-subagent session with `blank: false` and a draft title.
 *    The stock tree then renders every draft as a first-class row under its
 *    workspace: creation time on the trailing cell (updatedAt of a blank
 *    session is its creation time — nothing moves it), and click to open.
 *    A draft is a placeholder, not a chat: its stock ⋯ menu
 *    (Rename/Fork/Archive) is muted and a single × discards it (see 3).
 *    The same
 *    overlay feeds `workspaces.connectWorkspace`'s reuse scan (it reads
 *    `sessions.list` too), so the hero workspace picker also stops reusing
 *    the workspace's old blank and mints a fresh draft — Cursor semantics.
 *
 *    The draft title is the unsent composer text (live preview, Telegram
 *    style) when one exists — read through `conversation.input` shells and
 *    mirrored to localStorage so previews survive reloads — the explicit
 *    rename when the user pinned one, and the localized "New Session"
 *    otherwise. The moment the first message is sent, the host flips
 *    `blank` itself; the overlay stops touching the row and it becomes an
 *    ordinary chat.
 *
 * 3. Draft look — the row renderer is bundle-internal (no slots exist at
 *    row level), so the visual draft identity (gray title, pencil icon in
 *    the empty status slot) is painted by a MutationObserver that marks
 *    matching `[role="treeitem"]` rows with a class; theme-aware DSH
 *    design tokens do the coloring. Purely cosmetic and self-healing: if
 *    the DOM shape changes, rows keep working and just lose the tint.
 *
 * 4. Ctrl+Alt+N mints a new draft from anywhere (kept from v0.1; the
 *    Ctrl+Alt+D popover toggle died with the popover).
 *
 * Patch discipline: instance-level property shadowing guarded by
 * `Symbol.for` markers (idempotent across HMR), restored on fiber unload,
 * falling back to the stock behavior on any synchronous failure. No core
 * files are modified — the plugin is self-contained and portable.
 * @module @ne-ilyxa/dsh-session-drafts/client
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.matchDraftsHotkey = matchDraftsHotkey;
exports.draftPreview = draftPreview;
exports.draftTitleOf = draftTitleOf;
exports.projectDraftList = projectDraftList;
exports.draftRowTitles = draftRowTitles;
exports.matchDraftRow = matchDraftRow;
exports.classifyDraftRow = classifyDraftRow;
exports.draftRegistry = draftRegistry;
exports.resolveTargetWorkspaceId = resolveTargetWorkspaceId;
exports.findReusableEmptyDraft = findReusableEmptyDraft;
exports.installFreshSessions = installFreshSessions;
exports.installDraftProjection = installDraftProjection;
exports.findSessionId = findSessionId;
exports.installDraftMarker = installDraftMarker;
exports.apply = apply;
/**
 * Match the draft hotkey: Ctrl+Alt+N mints a new draft. Matching is by
 * physical key code first — `event.key` follows the keyboard layout, so a
 * Russian layout yields 'т' for the N key and a key-based matcher silently
 * dies there. `event.key` stays as the fallback for engines without codes.
 * Ctrl+Alt avoids the browser's own single-modifier shortcuts; an open IME
 * composition is skipped — but the legacy keyCode-229-alone signal
 * deliberately is NOT (under Linux IBus every keydown of a layout switch
 * carries 229). There is deliberately NO AltGraph guard: Firefox on Linux
 * reports AltGraph=true for EVERY Ctrl+Alt combination (X11 maps AltGr to
 * Ctrl+Alt), so such a guard — however well-meant for European layouts —
 * kills the hotkey for every Firefox user on Linux. (The Ctrl+Alt+D toggle
 * died with the popover in v0.2.)
 */
function matchDraftsHotkey(event) {
    if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey)
        return null;
    if (event.isComposing === true)
        return null;
    // A held key auto-repeats every ~30ms — each repeat would fire startSession
    // inside the same in-flight mint window the stock dedupe collapses only
    // per call. Reject repeats outright.
    if (event.repeat === true)
        return null;
    if (event.code === 'KeyN')
        return 'new';
    if (event.code !== undefined)
        return null;
    return event.key.toLowerCase() === 'n' ? 'new' : null;
}
// ---------------------------------------------------------------------------
// Pure draft derivation (exported for tests; no React, no context, no DOM).
// ---------------------------------------------------------------------------
/**
 * One-line preview of a draft's unsent composer text: whitespace collapsed,
 * capped at {@link max} chars with an ellipsis. Blank input previews as
 * undefined (nothing to show). Pure projection of the input state's draft.
 */
function draftPreview(text, max = 60) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed === '')
        return undefined;
    return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}
/** Whether a summary row is a projectable draft (blank, not a subagent child). */
function isDraft(summary) {
    return summary.blank && summary.origin !== 'subagent';
}
/** Overlay title of one draft: live preview, then pinned title, then stock. */
function draftTitleOf(summary, previews, fallbackTitle) {
    if (summary.title !== undefined)
        return summary.displayTitle ?? fallbackTitle;
    return previews.get(summary.id) ?? fallbackTitle;
}
/**
 * Project the STOCK session-list snapshot into the drafts view: every blank
 * non-subagent session becomes a first-class row (`blank: false`) carrying
 * its draft title, so the stock tree renders it — under its workspace, with
 * the creation-time cell and the × discard affordance (the stock ⋯ menu is
 * muted for drafts — Rename/Fork/Archive are chat verbs). Subagent
 * blanks keep their flag (stock hides them by design); rows that need no
 * change keep their object identity, and when nothing changes the SNAPSHOT
 * reference is returned untouched — getSnapshot must stay referentially
 * stable between mutations or every uSES reader re-renders forever.
 */
function projectDraftList(stock, previews, fallbackTitle) {
    let changed = false;
    const byId = { ...stock.byId };
    for (const id of stock.ids) {
        const summary = stock.byId[id];
        if (summary === undefined || !isDraft(summary))
            continue;
        byId[id] = { ...summary, blank: false, displayTitle: draftTitleOf(summary, previews, fallbackTitle) };
        changed = true;
    }
    // Referential stability: no projectable drafts — pass the stock snapshot
    // through untouched.
    if (!changed)
        return stock;
    // The spread keeps every other member (phase, current, …) by reference.
    return { ...stock, byId };
}
/** sessionId → overlay title for every projectable draft (DOM marker feed). */
function draftRowTitles(stock, previews, fallbackTitle, archived) {
    const titles = new Map();
    for (const id of stock.ids) {
        const summary = stock.byId[id];
        if (summary === undefined || !isDraft(summary))
            continue;
        // A discarded draft stays blank:true in the host list forever (the
        // archive is a hide set); its preview must stop feeding the marker —
        // including the text fallback, whose only failure mode is exactly this
        // pollution (a stale preview prefixing an unrelated row's label).
        if (archived?.has(summary.id) === true)
            continue;
        titles.set(id, draftTitleOf(summary, previews, fallbackTitle));
    }
    return titles;
}
/**
 * Whether a rendered tree row's visible text is one of the draft titles.
 * The row's textContent is `title + trailing time label` (menus and hover
 * cards are portaled away), so a prefix match is the rule. Titles shorter
 * than 3 characters never match: a 1–2 char preview prefixing an unrelated
 * workspace label would paint a row that is not a draft.
 */
function matchDraftRow(rowText, titles) {
    for (const title of titles) {
        if (title.length >= 3 && rowText.startsWith(title))
            return true;
    }
    return false;
}
/**
 * Classify one rendered tree row against the draft set — the marker's entire
 * decision, extracted pure for tests. IDENTITY decides wherever it can: a
 * fiber-resolved session id compared against the draft-id set can never
 * misclassify (workspace-header fibers carry no `node` prop; a graduated
 * chat's id left the set). The text-prefix fallback is TINT-ONLY: text can
 * collide (a workspace label or a graduated title prefixing a draft's
 * preview), and a false 'full' would mute a real row's ⋯ and inject a
 * working × — functional breakage. A false 'tint' costs a gray color that
 * the next scan (or the preview changing) corrects.
 */
function classifyDraftRow(rowId, rowText, draftIds, draftTitles) {
    if (rowId !== undefined)
        return draftIds.has(rowId) ? 'full' : 'none';
    return matchDraftRow(rowText, draftTitles) ? 'tint' : 'none';
}
const REGISTRY_KEY = Symbol.for('@ne-ilyxa/dsh-session-drafts/registry');
/** The process-wide draft registry (created once, shared across HMR loads). */
function draftRegistry() {
    const holder = globalThis;
    if (holder[REGISTRY_KEY] === undefined) {
        holder[REGISTRY_KEY] = {
            previews: new Map(),
            titles: new Map(),
            version: 0,
            listeners: new Set(),
            cache: { input: undefined, version: -1, title: '', output: { ids: [], byId: {}, current: undefined } },
            stockGet: undefined,
            restoreStore: undefined,
            overlayRefs: 0,
            rescan: undefined,
            persistTimer: undefined,
        };
    }
    return holder[REGISTRY_KEY];
}
/** localStorage seat of the preview mirror (best-effort; failures ignore). */
const PREVIEW_STORAGE_KEY = 'dsh.plugin.session-drafts.previews';
/** Stored previews cap and shelf life — drafts archive long before either. */
const PREVIEW_STORAGE_CAP = 200;
const PREVIEW_STORAGE_TTL_MS = 45 * 86_400_000;
/** Load persisted previews into the registry (fail-soft, idempotent). */
function loadPersistedPreviews(registry) {
    // Skip when the registry already carries previews (the HMR reinstall case):
    // the persisted copy lags the debounced write by up to 400ms, and reloading
    // it would resurrect entries deleted since the last flush.
    if (registry.previews.size > 0)
        return;
    try {
        const raw = localStorage.getItem(PREVIEW_STORAGE_KEY);
        if (raw === null)
            return;
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return;
        const now = Date.now();
        let count = 0;
        for (const [id, value] of Object.entries(parsed)) {
            if (count >= PREVIEW_STORAGE_CAP)
                break;
            if (typeof value !== 'object' || value === null)
                continue;
            const { p, at } = value;
            if (typeof p !== 'string' || p === '' || typeof at !== 'number')
                continue;
            if (now - at > PREVIEW_STORAGE_TTL_MS)
                continue;
            registry.previews.set(id, p);
            count += 1;
        }
    }
    catch {
        // Quota/private mode/corrupt JSON: persistence silently disables.
    }
}
/** Debounced write of the preview map (fail-soft, capped, last-write-wins). */
function schedulePersist(registry) {
    if (registry.persistTimer !== undefined)
        return;
    registry.persistTimer = setTimeout(() => {
        registry.persistTimer = undefined;
        try {
            const now = Date.now();
            const entries = [...registry.previews.entries()].slice(-PREVIEW_STORAGE_CAP);
            const payload = {};
            for (const [id, preview] of entries)
                payload[id] = { p: preview, at: now };
            localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(payload));
        }
        catch {
            // Same contract as a storage failure in the stock persist layer.
        }
    }, 400);
}
// ---------------------------------------------------------------------------
// New Session patch: reuse the empty draft, mint only when all are occupied.
// ---------------------------------------------------------------------------
/** Instance marker making the patches idempotent across HMR generations. */
const START_SESSION_PATCH = Symbol.for('@ne-ilyxa/dsh-session-drafts/startSession');
/** Resolve the New Session target exactly like the stock policy (minus reuse). */
function resolveTargetWorkspaceId(workspaces, sessions) {
    const current = sessions.current;
    const currentWorkspaceId = current === undefined
        ? undefined
        : workspaces.items.find(item => item.sessionIds.includes(current))?.workspaceId;
    return currentWorkspaceId ?? workspaces.recentWorkspaceId;
}
/**
 * Find the draft New Session should JUMP to instead of minting: the newest
 * EMPTY draft of the target workspace. A draft is empty when its composer
 * carries no unsent text — exactly the absence of a live preview
 * ({@link DraftRegistry.previews}, kept in sync with the input shells and
 * persisted across reloads). Occupied drafts (typed text) are skipped: they
 * stay put as their own chats and the click mints a fresh one — the Cursor
 * rule that empty placeholders never stack. Membership follows the host's
 * own account (sessionIds), the stock reuse guards apply (same cwd when both
 * are known, never an archived session), and subagent blanks are ignored as
 * everywhere in this plugin. Newest first, id as the deterministic tiebreak.
 */
function findReusableEmptyDraft(stock, workspaces, previews, workspaceId) {
    const workspace = workspaces.items.find(item => item.workspaceId === workspaceId);
    if (workspace === undefined)
        return undefined;
    const archived = new Set(workspaces.archivedSessionIds ?? []);
    const members = new Set(workspace.sessionIds);
    let best;
    for (const id of stock.ids) {
        const summary = stock.byId[id];
        if (summary === undefined || !summary.blank || summary.origin === 'subagent')
            continue;
        if (!members.has(summary.id) || archived.has(summary.id))
            continue;
        // Same cwd guard as the stock reuse scan, applied whenever the account
        // knows its path: a mismatch (or an absent cwd) means the session was
        // minted elsewhere (the host cwd) and merely landed in this account.
        if (workspace.path !== undefined && summary.cwd !== workspace.path)
            continue;
        if (previews.has(summary.id))
            continue; // occupied: unsent composer text
        if (best === undefined
            || summary.updatedAt > best.updatedAt
            || (summary.updatedAt === best.updatedAt && summary.id < best.id))
            best = summary;
    }
    return best;
}
/**
 * Patch one live WorkspaceRuntime instance with the Cursor New Session rule:
 * **never stack empty drafts** — on EVERY mint path, not just the button.
 *
 * `connectWorkspace` is the funnel the stock runtime uses for all of them
 * (stock `startSession`, the boot initial selection, the hero workspace
 * picker), so THAT is the seat the rule patches: connect first looks for the
 * workspace's existing EMPTY draft (no unsent composer text — see
 * {@link findReusableEmptyDraft}) and resolves it; only when every draft is
 * occupied does it fall through to the stock connect, which mints a fresh
 * durable session (`session.create` persists the Session entity host-side).
 * The mint path stays the stock method on purpose: its per-workspace
 * in-flight dedupe map collapses a rapid double-click into ONE mint. The
 * patched `startSession` just resolves the target Workspace (stock policy:
 * explicit → current Session's workspace → recent; clear the selection when
 * none exists) and routes through the patched connect + open. The stock
 * method, by contrast, reused the workspace's blank session regardless of
 * typed text — one empty chat per workspace, silently discarding the draft
 * you were writing — while the v0.3 button-only patch still let the boot and
 * picker paths stack empties.
 *
 * The reuse scan reads the STOCK list snapshot: the public `getSnapshot` is
 * shadowed by the draft projection once {@link installDraftProjection} is
 * live (blank drafts carry `blank: false` there and would be invisible to
 * the scan), so the registry's stock seat is preferred with the public face
 * as the pre-install fallback.
 * @returns disposer restoring both stock methods (no-op when unsupported;
 * `connectWorkspace` alone missing degrades to the startSession-only rule).
 */
function installFreshSessions(deps) {
    const { workspaces, sessions } = deps;
    if (typeof workspaces.startSession !== 'function' || typeof sessions.create !== 'function') {
        console.warn('[session-drafts] runtime shape unsupported — New Session left stock');
        return () => { };
    }
    const target = workspaces;
    if (target[START_SESSION_PATCH] !== undefined)
        return () => { };
    const registry = draftRegistry();
    const stockSnapshot = () => registry.stockGet !== undefined ? registry.stockGet() : sessions.list.getSnapshot();
    /** The shared empty-draft rule over the stock snapshot. */
    const reusableOf = (workspaceId) => findReusableEmptyDraft(stockSnapshot(), workspaces.list.getSnapshot(), registry.previews, workspaceId);
    // ------------------------------------------------------------------ connect
    const stockConnect = typeof target.connectWorkspace === 'function' ? target.connectWorkspace.bind(target) : undefined;
    let patchedConnect;
    let restoreConnect;
    if (stockConnect !== undefined) {
        const wasOwnConnect = Object.hasOwn(target, 'connectWorkspace');
        patchedConnect = (workspaceId) => {
            const reusable = reusableOf(workspaceId);
            if (reusable !== undefined)
                return Promise.resolve(reusable.id);
            return stockConnect(workspaceId);
        };
        restoreConnect = () => {
            if (target[START_SESSION_PATCH]?.connectWorkspace.patched !== target.connectWorkspace)
                return;
            if (wasOwnConnect)
                target.connectWorkspace = stockConnect;
            else
                delete target.connectWorkspace;
        };
    }
    // ------------------------------------------------------------------ start
    const wasOwn = Object.hasOwn(target, 'startSession');
    const original = workspaces.startSession.bind(workspaces);
    const patched = (workspaceId) => {
        try {
            const resolved = workspaceId
                ?? resolveTargetWorkspaceId(workspaces.list.getSnapshot(), sessions.list.getSnapshot());
            if (resolved === undefined) {
                sessions.clear();
                return;
            }
            const connect = patchedConnect ?? (typeof target.connectWorkspace === 'function'
                ? target.connectWorkspace.bind(target)
                : undefined);
            if (connect !== undefined) {
                void connect(resolved).then((sessionId) => { sessions.open(sessionId); }, (reason) => {
                    console.warn('[session-drafts] new session failed, falling back:', reason);
                    original(workspaceId);
                });
                return;
            }
            // No connectWorkspace on this runtime shape: the direct v0.3 path.
            const reusable = reusableOf(resolved);
            if (reusable !== undefined) {
                sessions.open(reusable.id);
                return;
            }
            void sessions.create({ workspaceId: resolved }).then((sessionId) => { sessions.open(sessionId); }, (reason) => {
                console.warn('[session-drafts] new session failed, falling back:', reason);
                original(workspaceId);
            });
        }
        catch (error) {
            console.warn('[session-drafts] new session threw, falling back:', error);
            original(workspaceId);
        }
    };
    target[START_SESSION_PATCH] = {
        startSession: { original, patched },
        connectWorkspace: {
            original: stockConnect ?? (() => Promise.reject(new Error('no stock connect'))),
            patched: patchedConnect ?? (() => Promise.reject(new Error('no stock connect'))),
        },
    };
    target.startSession = patched;
    if (patchedConnect !== undefined)
        target.connectWorkspace = patchedConnect;
    return () => {
        const record = target[START_SESSION_PATCH];
        if (record === undefined || record.startSession.patched !== target.startSession)
            return;
        // Own-property methods restore by assignment; prototype methods by
        // deleting the shadow so the prototype shows through again.
        if (wasOwn)
            target.startSession = record.startSession.original;
        else
            delete target.startSession;
        restoreConnect?.();
        delete target[START_SESSION_PATCH];
    };
}
// ---------------------------------------------------------------------------
// Draft projection: shadow sessions.list's two read faces on the live store
// object (identity-stable), feed live composer previews into the titles.
// ---------------------------------------------------------------------------
/** Instance marker making the store shadow idempotent across HMR. */
const LIST_OVERLAY_PATCH = Symbol.for('@ne-ilyxa/dsh-session-drafts/list-overlay');
/**
 * Install the draft projection on the live sessions service:
 *
 * - `getSnapshot` is shadowed to run {@link projectDraftList} over the stock
 *   snapshot, memoized on (stock identity, overlay version) so the uSES
 *   contract — same reference between mutations — holds for every reader;
 * - `subscribe` is shadowed to ALSO notify on overlay-version bumps (the
 *   stock observable fires on host list changes only; a preview typed into a
 *   draft changes no host state, yet the row title must move live);
 * - composer previews: every draft with a materialized input shell (opened
 *   at least once this page life; scopes of listed sessions persist) is
 *   subscribed through `conversation.input`, mirrored into the registry and
 *   localStorage, and pruned the moment the session stops being a draft
 *   (first send flips `blank` on the host);
 * - the stock store is observed once so freshly minted drafts recompute the
 *   DOM marker's title set without waiting for a version bump.
 *
 * Everything lives in the Symbol.for registry, so an HMR-reloaded plugin
 * generation re-attaches to a store shadowed by the previous one and the
 * data survives the reload.
 * @returns disposer restoring the stock read faces (no-op when unsupported).
 */
function installDraftProjection(deps) {
    const { sessions, conversation, fallbackTitle, archivedIds } = deps;
    const store = sessions.list;
    if (typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
        console.warn('[session-drafts] sessions.list shape unsupported — drafts stay stock-hidden');
        return () => { };
    }
    const registry = draftRegistry();
    loadPersistedPreviews(registry);
    // ------------------------------------------------------------------ store
    registry.overlayRefs += 1; // this generation lives over the shadow (own or adopted)
    if (store[LIST_OVERLAY_PATCH] === undefined) {
        const record = { getSnapshot: store.getSnapshot, subscribe: store.subscribe };
        const wasOwnGet = Object.hasOwn(store, 'getSnapshot');
        const wasOwnSub = Object.hasOwn(store, 'subscribe');
        const originalGet = record.getSnapshot.bind(store);
        const originalSubscribe = record.subscribe.bind(store);
        const projectedGet = () => {
            const stock = originalGet();
            const title = fallbackTitle();
            // The title rides the memo key: a locale switch changes neither the
            // stock identity nor the overlay version, and without the key the
            // projected rows would keep the old-language "New Session" until some
            // unrelated change flushed the memo.
            if (registry.cache.input === stock
                && registry.cache.version === registry.version
                && registry.cache.title === title) {
                return registry.cache.output;
            }
            const output = projectDraftList(stock, registry.previews, title);
            registry.cache = { input: stock, version: registry.version, title, output };
            return output;
        };
        const projectedSubscribe = (fn) => {
            registry.listeners.add(fn);
            const off = originalSubscribe(fn);
            return () => {
                registry.listeners.delete(fn);
                off();
            };
        };
        store[LIST_OVERLAY_PATCH] = record;
        store.getSnapshot = projectedGet;
        store.subscribe = projectedSubscribe;
        registry.stockGet = originalGet;
        registry.restoreStore = () => {
            if (store[LIST_OVERLAY_PATCH] !== record)
                return;
            // Restore by reassignment when the faces were own properties of the
            // literal (they always are for createSnapshotStore products).
            if (wasOwnGet)
                store.getSnapshot = record.getSnapshot;
            else
                delete store.getSnapshot;
            if (wasOwnSub)
                store.subscribe = record.subscribe;
            else
                delete store.subscribe;
            delete store[LIST_OVERLAY_PATCH];
        };
    }
    // The registry keeps a stock reader even after a restore: HMR generation
    // N+1 re-installs over the same store and its derivations still need the
    // un-projected snapshot.
    const stockSnapshot = () => registry.stockGet?.() ?? store.getSnapshot();
    // ------------------------------------------------------------------ emit
    /** Recompute the marker's title set from the CURRENT stock snapshot. */
    const retitle = () => {
        const archived = archivedIds?.();
        registry.titles = draftRowTitles(stockSnapshot(), registry.previews, fallbackTitle(), archived === undefined ? undefined : new Set(archived));
    };
    /** Overlay data changed: bump, retitle, wake engines and the marker. */
    const emit = () => {
        registry.version += 1;
        retitle();
        for (const fn of [...registry.listeners])
            fn();
        registry.rescan?.();
    };
    // -------------------------------------------------------------- previews
    const inputOffs = new Map();
    const syncPreview = (id, shellState) => {
        const text = shellState.getSnapshot().draft;
        const preview = typeof text === 'string' ? draftPreview(text) : undefined;
        if (preview === undefined) {
            if (registry.previews.delete(id)) {
                schedulePersist(registry);
                emit();
            }
            return;
        }
        if (registry.previews.get(id) !== preview) {
            registry.previews.set(id, preview);
            schedulePersist(registry);
            emit();
        }
    };
    /** Reconcile shell subscriptions with the current draft set. */
    const syncShells = () => {
        const snapshot = stockSnapshot();
        const wanted = new Set();
        for (const id of snapshot.ids) {
            const summary = snapshot.byId[id];
            if (summary === undefined || !isDraft(summary))
                continue;
            wanted.add(summary.id);
        }
        // Drop previews only on POSITIVE knowledge: the summary EXISTS and the
        // session is no longer a blank draft (the first send flipped `blank` on
        // the host, or it became a subagent child). A merely ABSENT summary —
        // the boot race where the plugin activates before the host list lands,
        // or an RPC gap — keeps the preview: pruning against a pending list
        // would wipe every preview restored from localStorage (and persist the
        // empty map) before the list ever arrives.
        let pruned = false;
        const archivedSet = archivedIds?.();
        for (const id of [...registry.previews.keys()]) {
            const summary = snapshot.byId[id];
            // Positive knowledge, two forms: the summary exists and the session
            // stopped being a draft (first send), or the registry archived it
            // (discard — via the × here, in another tab, or any future surface).
            if ((summary !== undefined && !isDraft(summary)) || archivedSet?.includes(id) === true) {
                if (registry.previews.delete(id))
                    pruned = true;
            }
        }
        for (const id of wanted) {
            if (inputOffs.has(id))
                continue;
            // Subscribe the CURRENT session only: typing happens in the open
            // conversation, so a non-current draft's text cannot change — its
            // mirror copy is frozen and refreshes the next time it opens. This is
            // also a hard safety rule: `sessions.scope(id)` RESOLVES LAZILY (it
            // mints a scope for any listed session) and `conversation.input.for`
            // then mints a fresh EMPTY input shell — whose '' draft would delete
            // the persisted preview of a draft we merely looked at. That exact
            // sequence wiped the restored map on every reload until it was pinned.
            if (id !== snapshot.current)
                continue;
            try {
                const scope = sessions.scope?.(id);
                if (scope === undefined)
                    continue; // not staged yet: no shell to read
                const shell = conversation.input.for(scope);
                const off = shell.state.subscribe(() => { syncPreview(id, shell.state); });
                inputOffs.set(id, off);
                syncPreview(id, shell.state); // seed immediately
            }
            catch {
                // The current session's shell is not materialized yet (boot beats
                // the staging): the next stock change re-runs this reconciliation.
            }
        }
        for (const [id, off] of inputOffs) {
            if (!wanted.has(id)) {
                off();
                inputOffs.delete(id);
            }
        }
        if (pruned) {
            schedulePersist(registry);
            emit();
        }
    };
    // Stock list changes: new drafts minted, blanks flipped by the first
    // send, sessions archived. Retitle for the marker and reconcile shells;
    // no version bump — engines re-read through their own subscription and
    // the getSnapshot memo keys on the new stock identity. Subscribing
    // through the shadowed face ALSO enrolls this callback in emit()'s wake
    // list, so a preview change re-syncs shells too (idempotent, cheap).
    const offStock = store.subscribe(() => {
        retitle();
        registry.rescan?.();
        syncShells();
    });
    retitle();
    syncShells();
    return () => {
        offStock();
        for (const off of inputOffs.values())
            off();
        inputOffs.clear();
        // Last generation out restores the stock faces; an earlier disposer
        // would strand a live HMR generation over an un-projected store.
        registry.overlayRefs = Math.max(0, registry.overlayRefs - 1);
        if (registry.overlayRefs === 0) {
            registry.restoreStore?.();
            registry.restoreStore = undefined;
        }
    };
}
// ---------------------------------------------------------------------------
// Draft marker: paint the visual draft identity onto rendered tree rows and
// swap the stock row menu for a single discard ×.
// ---------------------------------------------------------------------------
/** Class painted on draft rows (see styles below). */
const DRAFT_ROW_CLASS = 'dsd-draft-row';
/** Attribute muting the stock ⋯ menu trigger on draft rows (CSS hides it). */
const MUTE_ATTR = 'data-dsd-muted';
/** Attribute marking our injected × discard button. */
const DISCARD_ATTR = 'data-dsd-discard';
/**
 * Resolve the Session id from a rendered row's React fiber: walk up from the
 * row's host fiber to the SessionNodeItem component fiber, whose props carry
 * the derived `node`. The DOM carries no session id (aria labels are
 * locale-dependent), so the fiber is the only honest address. Bounded hops;
 * any shape drift just returns undefined (the row keeps working, the ×
 * resolves on a later scan). Pure — testable against a fake fiber chain.
 */
function findSessionId(start, maxHops = 12) {
    let fiber = start;
    for (let hops = 0; hops < maxHops && fiber !== null && fiber !== undefined; hops++) {
        const props = fiber.memoizedProps;
        const id = props?.node?.id;
        if (typeof id === 'string' && id !== '')
            return id;
        fiber = fiber.return;
    }
    return undefined;
}
/** The React fiber instance key of a DOM node (`__reactFiber$<renderer>`). */
function reactFiberOf(node) {
    const key = Object.keys(node).find(candidate => candidate.startsWith('__reactFiber$'));
    return key === undefined ? undefined : node[key];
}
/** The row's Session id through its React fiber (undefined on any drift). */
function rowSessionId(row) {
    try {
        return findSessionId(reactFiberOf(row));
    }
    catch {
        return undefined;
    }
}
/** × glyph, 16px native — the same seat and metrics as the stock ⋯ glyph. */
const DISCARD_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">'
    + '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
/** Strip every draft-row mutation (class, mute, × button) from one row. */
function undressRow(row) {
    row.classList.remove(DRAFT_ROW_CLASS);
    for (const trigger of Array.from(row.querySelectorAll(`button[${MUTE_ATTR}]`))) {
        trigger.removeAttribute(MUTE_ATTR);
    }
    for (const discard of Array.from(row.querySelectorAll(`button[${DISCARD_ATTR}]`))) {
        discard.remove();
    }
}
/**
 * Mark rendered draft rows and swap their affordance: a draft is a
 * placeholder, not a chat — the stock ⋯ menu (Rename/Fork/Archive) is muted
 * and a single × (same 16px seat, gray, hover-revealed with the row's action
 * cell) discards it. The row renderer is bundle-internal, so both are painted
 * from the outside: a MutationObserver matches `[role="treeitem"]` rows
 * against the registry's title set, mutes the menu trigger (a data attribute
 * — the CSS hides it locale-independently), and mounts the × inside the same
 * trailing action cell (so the stock hover rule shows/hides it exactly like
 * the ⋯). The click resolves the session id through the row's React fiber
 * and archives (discards) the draft. Cosmetic + one action: if the DOM shape
 * drifts, rows keep working and only lose the swap.
 * @returns disposer stopping the observer and clearing every mutation.
 */
function installDraftMarker(deps) {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined')
        return () => { };
    const { discardLabel, archiveSession } = deps;
    const registry = draftRegistry();
    const undressAll = () => {
        for (const row of Array.from(document.querySelectorAll(`[role="treeitem"].${DRAFT_ROW_CLASS}`))) {
            undressRow(row);
        }
    };
    const onDiscard = (sessionId) => {
        // Drop the preview eagerly: an archived draft stays `blank:true` in the
        // host list forever (the archive is a hide set), so the positive-knowledge
        // prune in the projection never fires for it — without this the entry
        // leaks in memory AND in the persisted mirror.
        if (registry.previews.delete(sessionId))
            schedulePersist(registry);
        void archiveSession(sessionId).catch((reason) => {
            console.warn('[session-drafts] draft discard failed:', reason);
        });
    };
    let frame;
    const scan = () => {
        frame = undefined;
        const values = [...registry.titles.values()];
        if (values.length === 0) {
            undressAll();
            return;
        }
        const draftIds = new Set(registry.titles.keys());
        for (const row of Array.from(document.querySelectorAll('[role="treeitem"]'))) {
            // Identity decides wherever the React fiber resolves the row's session
            // id (see classifyDraftRow): 'full' drafts get the tint AND the × swap;
            // the text-prefix fallback is TINT-ONLY — text can collide with a
            // workspace label or a graduated title, and a false full would mute a
            // real row's ⋯, so the fragile signal never reaches the functional
            // half. 'none' restores the stock affordance (graduation: first send).
            const kind = classifyDraftRow(rowSessionId(row), row.textContent ?? '', draftIds, values);
            if (kind === 'none') {
                if (row.classList.contains(DRAFT_ROW_CLASS))
                    undressRow(row);
                continue;
            }
            row.classList.add(DRAFT_ROW_CLASS);
            if (kind === 'tint') {
                // Fallback classification: color only, never the affordance swap.
                if (row.classList.contains(DRAFT_ROW_CLASS) && row.querySelector(`button[${MUTE_ATTR}]`) !== null) {
                    // A previously full-marked row that lost its fiber id: undress the
                    // functional half so the × cannot fire against an unresolved id.
                    for (const trigger of Array.from(row.querySelectorAll(`button[${MUTE_ATTR}]`))) {
                        trigger.removeAttribute(MUTE_ATTR);
                    }
                    for (const discard of Array.from(row.querySelectorAll(`button[${DISCARD_ATTR}]`))) {
                        discard.remove();
                    }
                }
                continue;
            }
            // The first button inside a session row is the ⋯ menu trigger (the
            // only in-row button; search-result rows carry none — nothing to swap
            // there, they keep their stock affordance).
            const trigger = row.querySelector('button');
            const seat = trigger?.parentElement ?? null;
            if (trigger === null || seat === null)
                continue;
            trigger.setAttribute(MUTE_ATTR, '');
            let discard = seat.querySelector(`button[${DISCARD_ATTR}]`);
            if (discard === null) {
                discard = document.createElement('button');
                discard.type = 'button';
                discard.setAttribute(DISCARD_ATTR, '');
                discard.innerHTML = DISCARD_ICON;
                discard.addEventListener('click', (event) => {
                    // The row's own onClick opens the session — the × must not. The id
                    // resolves FRESH at click time (the cached dataset value is only a
                    // fallback: rows are keyed by session id so reuse should not
                    // happen, but a stale cache must never archive the wrong draft).
                    event.stopPropagation();
                    event.preventDefault();
                    const id = rowSessionId(row) ?? discard?.dataset.dsdSession;
                    if (id === undefined) {
                        console.warn('[session-drafts] discard: session id unresolved — row rescanned');
                        return;
                    }
                    onDiscard(id);
                });
                seat.appendChild(discard);
            }
            // Refreshed every scan: the id lands once the fiber resolves, and the
            // label follows the active locale.
            if (discard.dataset.dsdSession === undefined) {
                const id = rowSessionId(row);
                if (id !== undefined)
                    discard.dataset.dsdSession = id;
            }
            discard.setAttribute('aria-label', discardLabel());
            discard.title = discardLabel();
        }
    };
    const schedule = () => {
        if (frame !== undefined)
            return;
        frame = requestAnimationFrame(scan);
    };
    registry.rescan = schedule;
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
    return () => {
        if (frame !== undefined)
            cancelAnimationFrame(frame);
        observer.disconnect();
        if (registry.rescan === schedule)
            registry.rescan = undefined;
        undressAll();
    };
}
// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------
/** Required services (cordis fiber inject). */
exports.inject = ['sessions', 'workspaces', 'conversation', 'locale'];
/** Shared stylesheet, guarded by a stable data attribute across HMR loads. */
const STYLE_ID = '@ne-ilyxa/dsh-session-drafts';
/**
 * Draft row identity + affordance. The stock tree gives every row a 16px
 * status slot; a draft's slot is empty (no activity), so the pencil lands
 * there without shifting the layout — and in the flat list (no slot) the row
 * keeps just the gray title. A draft is a placeholder, not a chat: the ⋯
 * menu trigger is muted (`data-dsd-muted`) and the injected ×
 * (`data-dsd-discard`) takes its seat — the stock hover rule of the trailing
 * action cell shows/hides it exactly like the ⋯, at the ⋯'s own 16px
 * metrics and gray. Colors ride the theme-aware design tokens: dark theme
 * reads as gray-next-to-white, light theme as muted-next-to-black.
 */
const styles = `
[role="treeitem"].dsd-draft-row{color:var(--dsw-alias-label-secondary)}
[role="treeitem"].dsd-draft-row>span:first-child:empty::after{content:"";display:block;width:14px;height:14px;background-color:var(--dsw-alias-label-tertiary);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L5.2 13.6l-3.2.8.8-3.2z' fill='none' stroke='%23000' stroke-width='1.4' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E") center/12px 12px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L5.2 13.6l-3.2.8.8-3.2z' fill='none' stroke='%23000' stroke-width='1.4' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E") center/12px 12px no-repeat}
[role="treeitem"] button[data-dsd-muted]{display:none!important}
[role="treeitem"] button[data-dsd-discard]{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:none;border-radius:4px;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary)}
[role="treeitem"] button[data-dsd-discard]:hover{color:var(--dsw-alias-label-primary)}
[role="treeitem"] button[data-dsd-discard]:focus-visible{outline:2px solid var(--dsw-alias-border-focus);outline-offset:-2px}
`;
const NS = 'sessionDrafts';
const en = {
    /** Blank draft with no preview text and no pinned title. */
    rowTitle: 'New Session',
    /** The × affordance: discard this draft (aria label + tooltip). */
    discard: 'Discard draft',
};
const zh = {
    rowTitle: '新会话',
    discard: '丢弃草稿',
};
/**
 * Browser plugin entry: stylesheet, dictionaries, the New Session patch, the
 * draft projection (visibility + titles + previews), the row marker, and the
 * Ctrl+Alt+N hotkey. No slots are registered — drafts render through the
 * stock tree.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null)
            return () => { };
        const tag = document.createElement('style');
        tag.dataset.plugin = STYLE_ID;
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = styles;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
    }, 'session-drafts: styles');
    ctx.effect(() => ctx.locale.register(NS, { en: en, zh: zh }), 'session-drafts: dictionaries');
    ctx.effect(() => installFreshSessions({ workspaces: ctx.workspaces, sessions: ctx.sessions }), 'session-drafts: fresh New Session');
    ctx.effect(() => {
        // The overlay title needs the active locale's "New Session"; bind is
        // stable per namespace and reads the locale at call time, so the title
        // follows the app locale on the next projection after a switch.
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined;
        const fallbackTitle = () => {
            try {
                const text = bound?.('rowTitle');
                return typeof text === 'string' && text !== '' ? text : en.rowTitle;
            }
            catch {
                return en.rowTitle;
            }
        };
        return installDraftProjection({
            sessions: ctx.sessions,
            conversation: ctx.conversation,
            fallbackTitle,
            archivedIds: () => ctx.workspaces.list.getSnapshot().archivedSessionIds,
        });
    }, 'session-drafts: draft projection');
    ctx.effect(() => {
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined;
        const text = (key, fallback) => {
            try {
                const value = bound?.(key);
                return typeof value === 'string' && value !== '' ? value : fallback;
            }
            catch {
                return fallback;
            }
        };
        return installDraftMarker({
            discardLabel: () => text('discard', en.discard),
            archiveSession: sessionId => ctx.workspaces.archiveSession(sessionId),
        });
    }, 'session-drafts: draft row marker');
    // Global hotkey: Ctrl+Alt+N mints a fresh draft from anywhere (works with
    // zero drafts too). Registered on WINDOW in the CAPTURE phase: window is
    // the first node of the event path, so no document/container handler can
    // stopPropagation() the event away from us (the dsh-better-sidebar IME
    // guard does exactly that under Linux IBus, where every keydown carries
    // keyCode 229).
    ctx.effect(() => {
        const onKey = (event) => {
            // DOM EventTarget is opaque to the structural matcher (tagName lives
            // on Element); the cast is the documented seam — the matcher narrows.
            if (matchDraftsHotkey(event) === null)
                return;
            event.preventDefault();
            event.stopPropagation();
            ctx.workspaces.startSession();
        };
        window.addEventListener('keydown', onKey, true);
        return () => { window.removeEventListener('keydown', onKey, true); };
    }, 'session-drafts: Ctrl+Alt+N');
}

return module.exports; } });
//# sourceMappingURL=client.js.map
