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
 *    A draft is a placeholder, not a chat: its stock row controls
 *    (⋯ menu, archive/pin row buttons) are muted and a single × discards
 *    it (see 3). The same
 *    overlay feeds `uiWorkspace.connectWorkspace`'s reuse scan (it reads
 *    `sessions.list` too), so the hero workspace picker also stops reusing
 *    the workspace's old blank and mints a fresh draft — Cursor semantics.
 *
 *    The draft title is the unsent composer text (live preview, Telegram
 *    style) when one exists — read through `conversation.input` shells and
 *    mirrored to localStorage so previews survive reloads — the explicit
 *    rename when the user pinned one, and the localized "New Session"
 *    otherwise. The title is written to BOTH summary faces the tree reads:
 *    `title` (the renderer's row label since the 0.2 refactor:
 *    `node.title || t('session.untitled')`) and `displayTitle` (the
 *    archive-confirm and hover-copy surfaces). The moment the first message
 *    is sent, the host flips `blank` itself; the overlay stops touching the
 *    row and it becomes an ordinary chat.
 *
 * 3. Draft look — the row renderer is bundle-internal (no slots exist at
 *    row level), so the visual draft identity (gray title, pencil icon in
 *    the empty status slot) is painted by a MutationObserver that marks
 *    matching `[role="treeitem"]` rows with a class; theme-aware DSH
 *    design tokens do the coloring. Row identity is read from the explicit
 *    `data-row-key="session:<id>"` attribute (0.2-era rows carry it), with
 *    the React-fiber walk (`SessionNodeItem.props.node`) as the fallback.
 *    The gray tint targets the title span directly: since 0.2 the stock
 *    `.sessionRow .title` rule carries its own explicit color, so a color
 *    on the row element alone no longer shows through. Purely cosmetic and
 *    self-healing: if the DOM shape changes, rows keep working and just
 *    lose the tint.
 *
 * 4. Ctrl+Alt+N mints a new draft from anywhere (kept from v0.1; the
 *    Ctrl+Alt+D popover toggle died with the popover). Since the 0.2
 *    refactor the mint flow lives on the `uiWorkspace` navigation service
 *    (`ctx.uiWorkspace.startSession` → `openWorkspace` → `connectWorkspace`);
 *    the empty-draft rule patches THAT `connectWorkspace` — the funnel every
 *    mint path (button, folder ＋, hotkey, boot selection, hero picker)
 *    goes through.
 *
 * Patch discipline: instance-level property shadowing guarded by
 * `Symbol.for` markers (idempotent across HMR), restored on fiber unload,
 * falling back to the stock behavior on any synchronous failure. No core
 * files are modified — the plugin is self-contained and portable.
 * @module @ne-ilyxa/dsh-session-drafts/client
 */
/** Session-list row facts the draft projection reads and rewrites. */
export interface SessionRowLike {
    readonly id: string;
    readonly blank: boolean;
    readonly cwd?: string;
    readonly updatedAt: number;
    readonly origin?: string;
    /** Explicit user title (the rename gesture); present only when pinned. */
    readonly title?: string;
    /** Stock display projection (explicit title → cwd basename → id). */
    readonly displayTitle?: string;
    /**
     * Local main-view retention counts; the CURRENT session is the row with
     * `retainedBy.mainView > 0` (the 0.2 face — the snapshot's own `current`
     * field is gone). Optional for the 0.1-era snapshots that still carried
     * `current`.
     */
    readonly retainedBy?: {
        readonly mainView?: number;
    };
    /**
     * Host-computed projection values riding the row; the plugin reads the
     * `sessionListMetadata` block — the host's honest "the folded prefix
     * contains no turn" fact (the 0.2 client `blank` bit no longer means
     * that: retention and opening flip it).
     */
    readonly projectionValues?: {
        readonly sessionListMetadata?: {
            readonly blank?: boolean;
        } | undefined;
    } | undefined;
}
/** sessions.list snapshot facts the draft projection reads. */
interface SessionListLike {
    readonly ids: readonly string[];
    readonly byId: Readonly<Record<string, SessionRowLike | undefined>>;
    /** Legacy 0.1-era current-session field; superseded by retainedBy (see mainSessionIdOf). */
    readonly current?: string | undefined;
}
/**
 * The snapshot store behind `sessions.list`: a plain object literal from
 * `createSnapshotStore` (never frozen — dev-freeze applies to the STATE,
 * not the store), so both read faces can be shadowed with own properties
 * while the object identity — what every already-bound reader holds —
 * stays the same.
 */
interface SnapshotStoreLike<T> {
    getSnapshot(): T;
    subscribe(fn: () => void): () => void;
}
/** The sessions service face the projection and the mirror use. */
interface SessionsLike {
    readonly list: SnapshotStoreLike<SessionListLike>;
    /**
     * Create (or adopt, with a preallocated `sessionId`) a Host session —
     * the single mint/adoption primitive the patched connect uses.
     */
    create(opts: {
        workspaceId?: string;
        cwd?: string;
        sessionId?: string;
    }): Promise<string>;
    /** Session scope for facade access (undefined until the session is retained). */
    scope?(sessionId: string): unknown | undefined;
}
/** Per-session composer input face (ui-conversation's conversation.input). */
interface ConversationInputLike {
    for(scope: unknown): {
        readonly state: SnapshotStoreLike<{
            readonly draft?: string;
        }>;
    };
}
/** The workspaces controller face the projection and the discard wiring use. */
interface WorkspacesLike {
    readonly list: {
        getSnapshot(): WorkspaceListLike;
    };
    /** Archive (discard) a session: the row hides, the session log remains. */
    archiveSession(sessionId: string): Promise<void>;
}
/**
 * The uiWorkspace navigation service face (the 0.2 home of the mint flow —
 * it moved off the workspace controller). Every New Session surface funnels
 * through {@link connectWorkspace}: stock `startSession` → `openWorkspace`,
 * the boot initial selection, and the hero workspace picker all land here.
 */
export interface UiWorkspaceLike {
    /** New Session flow: resolve the target Workspace, connect, open. */
    startSession(workspaceId?: string): void;
    /** Reuse-or-create the Workspace's blank session (the patch seat). */
    connectWorkspace(workspaceId: string): Promise<string>;
    /** Archive with main-selection cleanup when the archived one is current. */
    archiveSession?(sessionId: string, options?: {
        readonly stopActivity?: boolean;
    }): Promise<void>;
}
/** Workspace row facts the empty-draft reuse scan reads. */
interface WorkspaceLike {
    readonly workspaceId: string;
    /** Backing directory (cwd of its minted drafts); absent in stripped shapes. */
    readonly path?: string;
    readonly sessionIds: readonly string[];
}
/** workspaces.list snapshot facts the patch reads. */
interface WorkspaceListLike {
    readonly items: readonly WorkspaceLike[];
    /** Registry-global archive set (members are never reused); absent in old shapes. */
    readonly archivedSessionIds?: readonly string[];
}
/** Locale registration and binding face (the locale plugin's product). */
interface LocaleLike {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void;
    /** Bind a namespace to a translate function reading the active locale at call time. */
    bind?(ns: string): (key: string, params?: Record<string, string | number>) => string;
}
/** Browser Cordis context face this plugin consumes. */
export interface ClientContextLike {
    readonly sessions: SessionsLike;
    readonly workspaces: WorkspacesLike;
    /** The 0.2 navigation service (mint flow); absent on 0.1-era runtimes. */
    readonly uiWorkspace?: UiWorkspaceLike;
    readonly locale: LocaleLike;
    readonly conversation: {
        readonly input: ConversationInputLike;
    };
    effect(setup: () => (() => void) | void, label?: string): (() => void) | void;
}
/** Minimal keyboard-event shape the hotkey matcher reads. */
export interface HotkeyEventLike {
    readonly key: string;
    /** Layout-independent physical key ('KeyN'); absent on old engines. */
    readonly code?: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    /** True exactly while a real IME composition is open (not the legacy 229). */
    readonly isComposing?: boolean;
    /** True for OS key-repeat events (held key); auto-repeat must not re-mint. */
    readonly repeat?: boolean;
}
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
export declare function matchDraftsHotkey(event: HotkeyEventLike): 'new' | null;
/**
 * One-line preview of a draft's unsent composer text: whitespace collapsed,
 * capped at {@link max} chars with an ellipsis. Blank input previews as
 * undefined (nothing to show). Pure projection of the input state's draft.
 */
export declare function draftPreview(text: string, max?: number): string | undefined;
/**
 * The CURRENT session of a list snapshot: the row the main view retains
 * (`retainedBy.mainView > 0` — the 0.2 derivation, mirroring the stock
 * `mainSessionId`), with the legacy `current` field as the 0.1-era
 * fallback. The plugin reads the current session only to subscribe its
 * composer shell (typing happens in the open conversation).
 */
export declare function mainSessionIdOf(list: SessionListLike): string | undefined;
/**
 * Brand on rows this projection itself produced; the value is the row's
 * ORIGINAL client `blank` bit. The overlay must be idempotent over its own
 * output: a re-captured snapshot face (an HMR generation dance can leave a
 * projected face where the raw one was captured) feeds the projection back
 * its own rows, and without the brand the previously written `title` would
 * read as a user rename — permanently freezing the row title.
 */
export declare const PROJECTED_ROW: unique symbol;
/**
 * Overlay title of one draft: live preview, then pinned title, then stock.
 * A `title` this projection wrote itself is not a user rename — the brand
 * strips it so the live preview keeps winning over our own stale output.
 */
export declare function draftTitleOf(summary: SessionRowLike, previews: ReadonlyMap<string, string>, fallbackTitle: string): string;
/**
 * Project the STOCK session-list snapshot into the drafts view: every blank
 * non-subagent session becomes a first-class row (`blank: false`) carrying
 * its draft title, so the stock tree renders it — under its workspace, with
 * the creation-time cell and the × discard affordance (the stock ⋯ menu and
 * the row archive/pin buttons are muted for drafts — chat verbs). The title
 * is written to BOTH faces the tree consumes: `title` — the renderer's row
 * label since the 0.2 refactor (`node.title || t('session.untitled')`;
 * without it every draft row reads "Untitled") — and `displayTitle`, the
 * archive-confirm and hover-copy projection. Subagent blanks keep their
 * flag (stock hides them by design); rows that need no change keep their
 * object identity, and when nothing changes the SNAPSHOT reference is
 * returned untouched — getSnapshot must stay referentially stable between
 * mutations or every uSES reader re-renders forever.
 */
export declare function projectDraftList<T extends SessionListLike>(stock: T, previews: ReadonlyMap<string, string>, fallbackTitle: string): T;
/** sessionId → overlay title for every projectable draft (DOM marker feed). */
export declare function draftRowTitles(stock: SessionListLike, previews: ReadonlyMap<string, string>, fallbackTitle: string, archived?: ReadonlySet<string>): Map<string, string>;
/**
 * Whether a rendered tree row's visible text is one of the draft titles.
 * The row's textContent is `title + trailing time label` (menus and hover
 * cards are portaled away), so a prefix match is the rule. Titles shorter
 * than 3 characters never match: a 1–2 char preview prefixing an unrelated
 * workspace label would paint a row that is not a draft.
 */
export declare function matchDraftRow(rowText: string, titles: Iterable<string>): boolean;
/** How a rendered row should be treated by the marker. */
export type DraftRowKind = 'none' | 'tint' | 'full';
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
export declare function classifyDraftRow(rowId: string | undefined, rowText: string, draftIds: ReadonlySet<string>, draftTitles: readonly string[]): DraftRowKind;
/** Cross-generation overlay state plus the memo cell of the shadowed store. */
export interface DraftRegistry {
    /** sessionId → live composer preview (empty drafts absent). */
    readonly previews: Map<string, string>;
    /** sessionId → current overlay title (the DOM marker's match set). */
    titles: Map<string, string>;
    /** Bumped on every overlay-data change; pairs with {@link cache}. */
    version: number;
    /** Subscribers of the shadowed store beyond the stock observable's own. */
    readonly listeners: Set<() => void>;
    /** getSnapshot memo: (stock identity, version) → projected snapshot. */
    cache: {
        input: unknown;
        version: number;
        title: string;
        output: SessionListLike;
    };
    /**
     * Stock-snapshot reader seat (set when the store shadow is installed).
     * Internal derivations — titles, the shell sync — MUST read the STOCK
     * snapshot: the projected one carries `blank: false` for drafts and would
     * make every draft-derivation see no drafts at all.
     */
    stockGet: (() => SessionListLike) | undefined;
    /** Store-restore seat while the shadow is installed (unload/HMR dispose). */
    restoreStore: (() => void) | undefined;
    /**
     * Live installs over the store shadow: the installer (generation N) plus
     * every HMR generation that ADOPTED its shadow instead of re-shadowing.
     * The last one out restores the stock faces — an earlier disposer
     * restoring while a later generation still lives would silently un-project
     * the plugin (drafts vanish from the tree, no error).
     */
    overlayRefs: number;
    /** Marker rescan seat (installed by the DOM effect; emit() pokes it). */
    rescan: (() => void) | undefined;
    /** localStorage write debounce timer. */
    persistTimer: ReturnType<typeof setTimeout> | undefined;
}
/** The process-wide draft registry (created once, shared across HMR loads). */
export declare function draftRegistry(): DraftRegistry;
/**
 * Find the draft New Session should JUMP to instead of minting: the newest
 * EMPTY draft of the target workspace. A draft is empty when its composer
 * carries no unsent text — exactly the absence of a live preview
 * ({@link DraftRegistry.previews}, kept in sync with the input shells and
 * persisted across reloads). Occupied drafts (typed text) are skipped: they
 * stay put as their own chats and the click mints a fresh one — the Cursor
 * rule that empty placeholders never stack. Draft membership follows
 * {@link isDraft} (never-engaged placeholders and opened-but-never-prompted
 * sessions alike), the stock reuse guards apply (same cwd when both are
 * known, never an archived session), and subagent blanks are ignored as
 * everywhere in this plugin. Newest first, id as the deterministic tiebreak.
 */
export declare function findReusableEmptyDraft(stock: SessionListLike, workspaces: WorkspaceListLike, previews: ReadonlyMap<string, string>, workspaceId: string): SessionRowLike | undefined;
/**
 * Patch the live uiWorkspace navigation instance with the Cursor New Session
 * rule: **never stack empty drafts** — on EVERY mint path, not just the
 * button.
 *
 * Since the 0.2 harness refactor the mint flow lives on `ctx.uiWorkspace`
 * (`startSession` → `openWorkspace` → `connectWorkspace`; the boot initial
 * selection and the hero workspace picker also call `connectWorkspace`
 * directly), so THAT method is the seat the rule patches: connect first
 * looks for the workspace's existing EMPTY draft (no unsent composer text —
 * see {@link findReusableEmptyDraft}) and adopts it through the stock
 * create handshake (`session.create` with the preallocated id, the same
 * path the stock reuse takes); only when every draft is occupied does it
 * mint a fresh durable session through `session.create`. The stock method
 * is replaced — not wrapped — on purpose: its blank-reuse scan reuses the
 * workspace's blank regardless of typed text (one empty chat per workspace,
 * silently discarding the draft you were writing), so falling through to it
 * would betray the rule exactly when drafts are occupied. The per-workspace
 * in-flight dedupe the stock method owned lives on in the patch (a rapid
 * double-click collapses into ONE connect), and a `session/writer-held`
 * refusal of the adoption — a racing tab, a racing second click — falls
 * through to the fresh mint, mirroring the stock reuse fallback.
 *
 * The reuse scan reads the STOCK list snapshot: the public `getSnapshot` is
 * shadowed by the draft projection once {@link installDraftProjection} is
 * live (blank drafts carry `blank: false` there and would be invisible to
 * the scan), so the registry's stock seat is preferred with the public face
 * as the pre-install fallback.
 * @returns disposer restoring the stock connect (no-op when unsupported).
 */
export declare function installFreshSessions(deps: {
    workspaces: WorkspacesLike;
    sessions: SessionsLike;
    uiWorkspace?: UiWorkspaceLike | undefined;
}): () => void;
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
export declare function installDraftProjection(deps: {
    sessions: SessionsLike;
    conversation: {
        readonly input: ConversationInputLike;
    };
    fallbackTitle: () => string;
    /** Registry-global archive set (discarded drafts); absent degrades to unfiltered. */
    archivedIds?: () => readonly string[] | undefined;
}): () => void;
/** Minimal React fiber shape the session-id walk reads. */
export interface FiberLike {
    readonly return?: unknown;
    readonly memoizedProps?: {
        readonly node?: {
            readonly id?: unknown;
        };
    } | null;
}
/**
 * Resolve the Session id from a rendered row's React fiber: walk up from the
 * row's host fiber to the SessionNodeItem component fiber, whose props carry
 * the derived `node`. The DOM carries no session id (aria labels are
 * locale-dependent), so the fiber is the only honest address. Bounded hops;
 * any shape drift just returns undefined (the row keeps working, the ×
 * resolves on a later scan). Pure — testable against a fake fiber chain.
 */
export declare function findSessionId(start: unknown, maxHops?: number): string | undefined;
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
export declare function installDraftMarker(deps: {
    /** Localized × label (aria + tooltip), read at scan time for locale switches. */
    discardLabel: () => string;
    /** Discard = workspace archive: the row hides, the session log remains. */
    archiveSession: (sessionId: string) => Promise<void>;
}): () => void;
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Browser plugin entry: stylesheet, dictionaries, the New Session patch, the
 * draft projection (visibility + titles + previews), the row marker, and the
 * Ctrl+Alt+N hotkey. No slots are registered — drafts render through the
 * stock tree.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContextLike): void;
export {};
