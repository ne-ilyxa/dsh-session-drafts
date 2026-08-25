/**
 * dsh-session-drafts, browser half.
 *
 * Cursor-style drafts, fully in-tree (no popover, no popup menu):
 *
 * 1. Fresh drafts — `workspaces.startSession` (every New Session surface:
 *    the sidebar button, the folder ＋, the workspace picker) is patched on
 *    the live WorkspaceRuntime instance to ALWAYS mint a fresh durable blank
 *    session on the host (`session.create` persists the Session entity
 *    before any message) and open it. Several empty chats per workspace
 *    coexist in Session persistence and survive host restarts.
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
 *    session is its creation time — nothing moves it), the row menu
 *    (Rename/Fork/Archive — Archive IS discard), click to open. The same
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

// ---------------------------------------------------------------------------
// Structural surface types (the plugin declares what it consumes; the runtime
// satisfies these structurally — same discipline as the stock client plugins).
// ---------------------------------------------------------------------------

/** Session-list row facts the draft projection reads and rewrites. */
interface SessionRowLike {
  readonly id: string
  readonly blank: boolean
  readonly cwd?: string
  readonly updatedAt: number
  readonly origin?: string
  /** Explicit user title (the rename gesture); present only when pinned. */
  readonly title?: string
  /** Stock display projection (explicit title → cwd basename → id). */
  readonly displayTitle?: string
}

/** sessions.list snapshot facts the draft projection reads. */
interface SessionListLike {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionRowLike | undefined>>
  readonly current: string | undefined
}

/**
 * The snapshot store behind `sessions.list`: a plain object literal from
 * `createSnapshotStore` (never frozen — dev-freeze applies to the STATE,
 * not the store), so both read faces can be shadowed with own properties
 * while the object identity — what every already-bound reader holds —
 * stays the same.
 */
interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** The sessions service face the patches and the mirror use. */
interface SessionsLike {
  readonly list: SnapshotStoreLike<SessionListLike>
  create(opts: { workspaceId?: string; cwd?: string }): Promise<string>
  open(id: string): void
  clear(): void
  /** Session scope for facade access (undefined until the session is opened). */
  scope?(sessionId: string): unknown | undefined
}

/** Per-session composer input face (ui-conversation's conversation.input). */
interface ConversationInputLike {
  for(scope: unknown): {
    readonly state: SnapshotStoreLike<{ readonly draft?: string }>
  }
}

/** The workspaces service face the patch uses. */
interface WorkspacesLike {
  readonly list: { getSnapshot(): WorkspaceListLike }
  startSession(workspaceId?: string): void
}

/** workspaces.list snapshot facts the patch reads. */
interface WorkspaceListLike {
  readonly items: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[]
  readonly recentWorkspaceId: string | undefined
}

/** Locale registration and binding face (the locale plugin's product). */
interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  /** Bind a namespace to a translate function reading the active locale at call time. */
  bind?(ns: string): (key: string, params?: Record<string, string | number>) => string
}

/** Browser Cordis context face this plugin consumes. */
export interface ClientContextLike {
  readonly sessions: SessionsLike
  readonly workspaces: WorkspacesLike
  readonly locale: LocaleLike
  readonly conversation: { readonly input: ConversationInputLike }
  effect(setup: () => (() => void) | void, label?: string): (() => void) | void
}

// ---------------------------------------------------------------------------
// Hotkeys (pure matcher, exported for tests).
// ---------------------------------------------------------------------------

/** Minimal keyboard-event shape the hotkey matcher reads. */
export interface HotkeyEventLike {
  readonly key: string
  /** Layout-independent physical key ('KeyN'); absent on old engines. */
  readonly code?: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  /** True exactly while a real IME composition is open (not the legacy 229). */
  readonly isComposing?: boolean
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
export function matchDraftsHotkey(event: HotkeyEventLike): 'new' | null {
  if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return null
  if (event.isComposing === true) return null
  if (event.code === 'KeyN') return 'new'
  if (event.code !== undefined) return null
  return event.key.toLowerCase() === 'n' ? 'new' : null
}

// ---------------------------------------------------------------------------
// Pure draft derivation (exported for tests; no React, no context, no DOM).
// ---------------------------------------------------------------------------

/**
 * One-line preview of a draft's unsent composer text: whitespace collapsed,
 * capped at {@link max} chars with an ellipsis. Blank input previews as
 * undefined (nothing to show). Pure projection of the input state's draft.
 */
export function draftPreview(text: string, max = 60): string | undefined {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return undefined
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`
}

/** Whether a summary row is a projectable draft (blank, not a subagent child). */
function isDraft(summary: SessionRowLike): boolean {
  return summary.blank && summary.origin !== 'subagent'
}

/** Overlay title of one draft: live preview, then pinned title, then stock. */
export function draftTitleOf(
  summary: SessionRowLike,
  previews: ReadonlyMap<string, string>,
  fallbackTitle: string,
): string {
  if (summary.title !== undefined) return summary.displayTitle ?? fallbackTitle
  return previews.get(summary.id) ?? fallbackTitle
}

/**
 * Project the STOCK session-list snapshot into the drafts view: every blank
 * non-subagent session becomes a first-class row (`blank: false`) carrying
 * its draft title, so the stock tree renders it — under its workspace, with
 * the creation-time cell and the row menu (Archive = discard). Subagent
 * blanks keep their flag (stock hides them by design); rows that need no
 * change keep their object identity, and when nothing changes the SNAPSHOT
 * reference is returned untouched — getSnapshot must stay referentially
 * stable between mutations or every uSES reader re-renders forever.
 */
export function projectDraftList<T extends SessionListLike>(
  stock: T,
  previews: ReadonlyMap<string, string>,
  fallbackTitle: string,
): T {
  let changed = false
  const byId: Record<string, SessionRowLike | undefined> = { ...stock.byId }
  for (const id of stock.ids) {
    const summary = stock.byId[id]
    if (summary === undefined || !isDraft(summary)) continue
    byId[id] = { ...summary, blank: false, displayTitle: draftTitleOf(summary, previews, fallbackTitle) }
    changed = true
  }
  // Referential stability: no projectable drafts — pass the stock snapshot
  // through untouched.
  if (!changed) return stock
  // The spread keeps every other member (phase, current, …) by reference.
  return { ...stock, byId } as T
}

/** sessionId → overlay title for every projectable draft (DOM marker feed). */
export function draftRowTitles(
  stock: SessionListLike,
  previews: ReadonlyMap<string, string>,
  fallbackTitle: string,
): Map<string, string> {
  const titles = new Map<string, string>()
  for (const id of stock.ids) {
    const summary = stock.byId[id]
    if (summary === undefined || !isDraft(summary)) continue
    titles.set(id, draftTitleOf(summary, previews, fallbackTitle))
  }
  return titles
}

/**
 * Whether a rendered tree row's visible text is one of the draft titles.
 * The row's textContent is `title + trailing time label` (menus and hover
 * cards are portaled away), so a prefix match is the rule. Titles shorter
 * than 3 characters never match: a 1–2 char preview prefixing an unrelated
 * workspace label would paint a row that is not a draft.
 */
export function matchDraftRow(rowText: string, titles: Iterable<string>): boolean {
  for (const title of titles) {
    if (title.length >= 3 && rowText.startsWith(title)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Shared draft registry (Symbol.for: one instance across HMR generations,
// so a store shadowed by generation N keeps reading generation N+1's data).
// ---------------------------------------------------------------------------

/** Cross-generation overlay state plus the memo cell of the shadowed store. */
export interface DraftRegistry {
  /** sessionId → live composer preview (empty drafts absent). */
  readonly previews: Map<string, string>
  /** sessionId → current overlay title (the DOM marker's match set). */
  titles: Map<string, string>
  /** Bumped on every overlay-data change; pairs with {@link cache}. */
  version: number
  /** Subscribers of the shadowed store beyond the stock observable's own. */
  readonly listeners: Set<() => void>
  /** getSnapshot memo: (stock identity, version) → projected snapshot. */
  cache: { input: unknown; version: number; output: SessionListLike }
  /**
   * Stock-snapshot reader seat (set when the store shadow is installed).
   * Internal derivations — titles, the shell sync — MUST read the STOCK
   * snapshot: the projected one carries `blank: false` for drafts and would
   * make every draft-derivation see no drafts at all.
   */
  stockGet: (() => SessionListLike) | undefined
  /** Store-restore seat while the shadow is installed (unload/HMR dispose). */
  restoreStore: (() => void) | undefined
  /** Marker rescan seat (installed by the DOM effect; emit() pokes it). */
  rescan: (() => void) | undefined
  /** localStorage write debounce timer. */
  persistTimer: ReturnType<typeof setTimeout> | undefined
}

const REGISTRY_KEY = Symbol.for('@ne-ilyxa/dsh-session-drafts/registry')

/** The process-wide draft registry (created once, shared across HMR loads). */
export function draftRegistry(): DraftRegistry {
  const holder = globalThis as { [REGISTRY_KEY]?: DraftRegistry }
  if (holder[REGISTRY_KEY] === undefined) {
    holder[REGISTRY_KEY] = {
      previews: new Map(),
      titles: new Map(),
      version: 0,
      listeners: new Set(),
      cache: { input: undefined, version: -1, output: { ids: [], byId: {}, current: undefined } },
      stockGet: undefined,
      restoreStore: undefined,
      rescan: undefined,
      persistTimer: undefined,
    }
  }
  return holder[REGISTRY_KEY]
}

/** localStorage seat of the preview mirror (best-effort; failures ignore). */
const PREVIEW_STORAGE_KEY = 'dsh.plugin.session-drafts.previews'
/** Stored previews cap and shelf life — drafts archive long before either. */
const PREVIEW_STORAGE_CAP = 200
const PREVIEW_STORAGE_TTL_MS = 45 * 86_400_000

/** Load persisted previews into the registry (idempotent, fail-soft). */
function loadPersistedPreviews(registry: DraftRegistry): void {
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_KEY)
    if (raw === null) return
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return
    const now = Date.now()
    let count = 0
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (count >= PREVIEW_STORAGE_CAP) break
      if (typeof value !== 'object' || value === null) continue
      const { p, at } = value as { p?: unknown; at?: unknown }
      if (typeof p !== 'string' || p === '' || typeof at !== 'number') continue
      if (now - at > PREVIEW_STORAGE_TTL_MS) continue
      registry.previews.set(id, p)
      count += 1
    }
  } catch {
    // Quota/private mode/corrupt JSON: persistence silently disables.
  }
}

/** Debounced write of the preview map (fail-soft, capped, last-write-wins). */
function schedulePersist(registry: DraftRegistry): void {
  if (registry.persistTimer !== undefined) return
  registry.persistTimer = setTimeout(() => {
    registry.persistTimer = undefined
    try {
      const now = Date.now()
      const entries = [...registry.previews.entries()].slice(-PREVIEW_STORAGE_CAP)
      const payload: Record<string, { p: string; at: number }> = {}
      for (const [id, preview] of entries) payload[id] = { p: preview, at: now }
      localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Same contract as a storage failure in the stock persist layer.
    }
  }, 400)
}

// ---------------------------------------------------------------------------
// New Session patch: always a fresh durable draft, never blank reuse.
// ---------------------------------------------------------------------------

/** Instance marker making the patch idempotent across HMR generations. */
const START_SESSION_PATCH = Symbol.for('@ne-ilyxa/dsh-session-drafts/startSession')

type PatchedWorkspaces = Omit<WorkspacesLike, 'startSession'> & {
  startSession?: (workspaceId?: string) => void
  [START_SESSION_PATCH]?: { original: (workspaceId?: string) => void; patched: (workspaceId?: string) => void }
}

/** Resolve the New Session target exactly like the stock policy (minus reuse). */
export function resolveTargetWorkspaceId(
  workspaces: WorkspaceListLike,
  sessions: SessionListLike,
): string | undefined {
  const current = sessions.current
  const currentWorkspaceId = current === undefined
    ? undefined
    : workspaces.items.find(item => item.sessionIds.includes(current))?.workspaceId
  return currentWorkspaceId ?? workspaces.recentWorkspaceId
}

/**
 * Patch one live WorkspaceRuntime instance so `startSession` always creates a
 * fresh blank session on the host and opens it (the stock method reuses the
 * workspace's existing blank session, capping empty chats at one per
 * workspace). The resolution policy (explicit → current Session's workspace →
 * recent workspace; clear the selection when none exists) is preserved.
 * @returns disposer restoring the stock method (no-op when unsupported).
 */
export function installFreshSessions(deps: { workspaces: WorkspacesLike; sessions: SessionsLike }): () => void {
  const { workspaces, sessions } = deps
  if (typeof workspaces.startSession !== 'function' || typeof sessions.create !== 'function') {
    console.warn('[session-drafts] runtime shape unsupported — New Session left stock')
    return () => {}
  }
  const target = workspaces as PatchedWorkspaces
  if (target[START_SESSION_PATCH] !== undefined) return () => {}
  const wasOwn = Object.hasOwn(target, 'startSession')
  const original = workspaces.startSession.bind(workspaces)
  const patched = (workspaceId?: string): void => {
    try {
      const resolved = workspaceId
        ?? resolveTargetWorkspaceId(workspaces.list.getSnapshot(), sessions.list.getSnapshot())
      if (resolved === undefined) {
        sessions.clear()
        return
      }
      void sessions.create({ workspaceId: resolved }).then(
        (sessionId) => { sessions.open(sessionId) },
        (reason: unknown) => {
          console.warn('[session-drafts] new session failed, falling back:', reason)
          original(workspaceId)
        },
      )
    } catch (error: unknown) {
      console.warn('[session-drafts] new session threw, falling back:', error)
      original(workspaceId)
    }
  }
  target[START_SESSION_PATCH] = { original, patched }
  target.startSession = patched
  return () => {
    const record = target[START_SESSION_PATCH]
    if (record === undefined || record.patched !== target.startSession) return
    // Own-property methods restore by assignment; prototype methods by
    // deleting the shadow so the prototype shows through again.
    if (wasOwn) target.startSession = record.original
    else delete target.startSession
    delete target[START_SESSION_PATCH]
  }
}

// ---------------------------------------------------------------------------
// Draft projection: shadow sessions.list's two read faces on the live store
// object (identity-stable), feed live composer previews into the titles.
// ---------------------------------------------------------------------------

/** Instance marker making the store shadow idempotent across HMR. */
const LIST_OVERLAY_PATCH = Symbol.for('@ne-ilyxa/dsh-session-drafts/list-overlay')

type PatchableStore = Omit<SnapshotStoreLike<SessionListLike>, 'getSnapshot' | 'subscribe'> & {
  getSnapshot?: () => SessionListLike
  subscribe?: (fn: () => void) => () => void
  [LIST_OVERLAY_PATCH]?: { getSnapshot: () => SessionListLike; subscribe: (fn: () => void) => () => void }
}

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
export function installDraftProjection(deps: {
  sessions: SessionsLike
  conversation: { readonly input: ConversationInputLike }
  fallbackTitle: () => string
}): () => void {
  const { sessions, conversation, fallbackTitle } = deps
  const store = sessions.list as PatchableStore
  if (typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
    console.warn('[session-drafts] sessions.list shape unsupported — drafts stay stock-hidden')
    return () => {}
  }
  const registry = draftRegistry()
  loadPersistedPreviews(registry)

  // ------------------------------------------------------------------ store
  if (store[LIST_OVERLAY_PATCH] === undefined) {
    const record = { getSnapshot: store.getSnapshot, subscribe: store.subscribe }
    const wasOwnGet = Object.hasOwn(store, 'getSnapshot')
    const wasOwnSub = Object.hasOwn(store, 'subscribe')
    const originalGet = record.getSnapshot.bind(store)
    const originalSubscribe = record.subscribe.bind(store)
    const projectedGet = (): SessionListLike => {
      const stock = originalGet()
      if (registry.cache.input === stock && registry.cache.version === registry.version) {
        return registry.cache.output
      }
      const output = projectDraftList(stock, registry.previews, fallbackTitle())
      registry.cache = { input: stock, version: registry.version, output }
      return output
    }
    const projectedSubscribe = (fn: () => void): (() => void) => {
      registry.listeners.add(fn)
      const off = originalSubscribe(fn)
      return () => {
        registry.listeners.delete(fn)
        off()
      }
    }
    store[LIST_OVERLAY_PATCH] = record
    store.getSnapshot = projectedGet
    store.subscribe = projectedSubscribe
    registry.stockGet = originalGet
    registry.restoreStore = () => {
      if (store[LIST_OVERLAY_PATCH] !== record) return
      // Restore by reassignment when the faces were own properties of the
      // literal (they always are for createSnapshotStore products).
      if (wasOwnGet) store.getSnapshot = record.getSnapshot
      else delete store.getSnapshot
      if (wasOwnSub) store.subscribe = record.subscribe
      else delete store.subscribe
      delete store[LIST_OVERLAY_PATCH]
    }
  }
  // The registry keeps a stock reader even after a restore: HMR generation
  // N+1 re-installs over the same store and its derivations still need the
  // un-projected snapshot.
  const stockSnapshot = (): SessionListLike => registry.stockGet?.() ?? store.getSnapshot!()

  // ------------------------------------------------------------------ emit
  /** Recompute the marker's title set from the CURRENT stock snapshot. */
  const retitle = (): void => {
    registry.titles = draftRowTitles(stockSnapshot(), registry.previews, fallbackTitle())
  }
  /** Overlay data changed: bump, retitle, wake engines and the marker. */
  const emit = (): void => {
    registry.version += 1
    retitle()
    for (const fn of [...registry.listeners]) fn()
    registry.rescan?.()
  }

  // -------------------------------------------------------------- previews
  const inputOffs = new Map<string, () => void>()

  const syncPreview = (id: string, shellState: SnapshotStoreLike<{ readonly draft?: string }>): void => {
    const text = shellState.getSnapshot().draft
    const preview = typeof text === 'string' ? draftPreview(text) : undefined
    if (preview === undefined) {
      if (registry.previews.delete(id)) {
        schedulePersist(registry)
        emit()
      }
      return
    }
    if (registry.previews.get(id) !== preview) {
      registry.previews.set(id, preview)
      schedulePersist(registry)
      emit()
    }
  }

  /** Reconcile shell subscriptions with the current draft set. */
  const syncShells = (): void => {
    const snapshot = stockSnapshot()
    const wanted = new Set<string>()
    for (const id of snapshot.ids) {
      const summary = snapshot.byId[id]
      if (summary === undefined || !isDraft(summary)) continue
      wanted.add(summary.id)
    }
    // Drop previews of sessions that stopped being drafts (first send, or
    // the session vanished) — the overlay would otherwise resurrect a title.
    let pruned = false
    for (const id of [...registry.previews.keys()]) {
      if (!wanted.has(id) && registry.previews.delete(id)) pruned = true
    }
    for (const id of wanted) {
      if (inputOffs.has(id)) continue
      try {
        const scope = sessions.scope?.(id)
        if (scope === undefined) continue // never opened: no shell yet
        const shell = conversation.input.for(scope)
        const off = shell.state.subscribe(() => { syncPreview(id, shell.state) })
        inputOffs.set(id, off)
        syncPreview(id, shell.state) // seed immediately
      } catch {
        // No binding materialized (session never opened this page life):
        // the preview appears after the first open; the persisted mirror
        // covers the meanwhile.
      }
    }
    for (const [id, off] of inputOffs) {
      if (!wanted.has(id)) {
        off()
        inputOffs.delete(id)
      }
    }
    if (pruned) {
      schedulePersist(registry)
      emit()
    }
  }

  // Stock list changes: new drafts minted, blanks flipped by the first
  // send, sessions archived. Retitle for the marker and reconcile shells;
  // no version bump — engines re-read through their own subscription and
  // the getSnapshot memo keys on the new stock identity. Subscribing
  // through the shadowed face ALSO enrolls this callback in emit()'s wake
  // list, so a preview change re-syncs shells too (idempotent, cheap).
  const offStock = store.subscribe(() => {
    retitle()
    registry.rescan?.()
    syncShells()
  })

  retitle()
  syncShells()

  return () => {
    offStock()
    for (const off of inputOffs.values()) off()
    inputOffs.clear()
    registry.restoreStore?.()
    registry.restoreStore = undefined
  }
}

// ---------------------------------------------------------------------------
// Draft marker: paint the visual draft identity onto rendered tree rows.
// ---------------------------------------------------------------------------

/** Class painted on draft rows (see styles below). */
const DRAFT_ROW_CLASS = 'dsd-draft-row'

/**
 * Mark rendered draft rows. The row renderer is bundle-internal, so the
 * identity is painted from the outside: a MutationObserver watches the
 * document, every pass matches `[role="treeitem"]` rows against the
 * registry's title set, and CSS does the rest. Purely cosmetic: if the DOM
 * shape drifts, rows keep working and only lose the tint.
 * @returns disposer stopping the observer and clearing the marks.
 */
export function installDraftMarker(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const registry = draftRegistry()
  const unmarkAll = (): void => {
    for (const row of Array.from(document.querySelectorAll(`[role="treeitem"].${DRAFT_ROW_CLASS}`))) {
      row.classList.remove(DRAFT_ROW_CLASS)
    }
  }
  let frame: number | undefined
  const scan = (): void => {
    frame = undefined
    const values = [...registry.titles.values()]
    if (values.length === 0) {
      unmarkAll()
      return
    }
    for (const row of Array.from(document.querySelectorAll('[role="treeitem"]'))) {
      // A tree row's textContent is `title + trailing time` (menus and
      // hover cards are portaled away from the row).
      if (matchDraftRow(row.textContent ?? '', values)) row.classList.add(DRAFT_ROW_CLASS)
      else row.classList.remove(DRAFT_ROW_CLASS)
    }
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(scan)
  }
  registry.rescan = schedule
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  schedule()
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    observer.disconnect()
    if (registry.rescan === schedule) registry.rescan = undefined
    unmarkAll()
  }
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

/** Required services (cordis fiber inject). */
export const inject = ['sessions', 'workspaces', 'conversation', 'locale']

/** Shared stylesheet, guarded by a stable data attribute across HMR loads. */
const STYLE_ID = '@ne-ilyxa/dsh-session-drafts'

/**
 * Draft row identity. The stock tree gives every row a 16px status slot;
 * a draft's slot is empty (no activity), so the pencil lands there without
 * shifting the layout — and in the flat list (no slot) the row keeps just
 * the gray title. Colors ride the theme-aware design tokens: dark theme
 * reads as gray-next-to-white, light theme as muted-next-to-black.
 */
const styles = `
[role="treeitem"].dsd-draft-row{color:var(--dsw-alias-label-secondary)}
[role="treeitem"].dsd-draft-row>span:first-child:empty::after{content:"";display:block;width:14px;height:14px;background-color:var(--dsw-alias-label-tertiary);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L5.2 13.6l-3.2.8.8-3.2z' fill='none' stroke='%23000' stroke-width='1.4' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E") center/12px 12px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L5.2 13.6l-3.2.8.8-3.2z' fill='none' stroke='%23000' stroke-width='1.4' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E") center/12px 12px no-repeat}
`

const NS = 'sessionDrafts'

const en = {
  /** Blank draft with no preview text and no pinned title. */
  rowTitle: 'New Session',
} as const

const zh = {
  rowTitle: '新会话',
} as const

/**
 * Browser plugin entry: stylesheet, dictionaries, the New Session patch, the
 * draft projection (visibility + titles + previews), the row marker, and the
 * Ctrl+Alt+N hotkey. No slots are registered — drafts render through the
 * stock tree.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => {
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = STYLE_ID
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'session-drafts: styles')

  ctx.effect(() => ctx.locale.register(NS, { en: en as unknown as Record<string, string>, zh: zh as unknown as Record<string, string> }), 'session-drafts: dictionaries')

  ctx.effect(() => installFreshSessions({ workspaces: ctx.workspaces, sessions: ctx.sessions }), 'session-drafts: fresh New Session')

  ctx.effect(() => {
    // The overlay title needs the active locale's "New Session"; bind is
    // stable per namespace and reads the locale at call time, so the title
    // follows the app locale on the next projection after a switch.
    const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined
    const fallbackTitle = (): string => {
      try {
        const text = bound?.('rowTitle')
        return typeof text === 'string' && text !== '' ? text : en.rowTitle
      } catch {
        return en.rowTitle
      }
    }
    return installDraftProjection({
      sessions: ctx.sessions,
      conversation: ctx.conversation,
      fallbackTitle,
    })
  }, 'session-drafts: draft projection')

  ctx.effect(() => installDraftMarker(), 'session-drafts: draft row marker')

  // Global hotkey: Ctrl+Alt+N mints a fresh draft from anywhere (works with
  // zero drafts too). Registered on WINDOW in the CAPTURE phase: window is
  // the first node of the event path, so no document/container handler can
  // stopPropagation() the event away from us (the dsh-better-sidebar IME
  // guard does exactly that under Linux IBus, where every keydown carries
  // keyCode 229).
  ctx.effect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // DOM EventTarget is opaque to the structural matcher (tagName lives
      // on Element); the cast is the documented seam — the matcher narrows.
      if (matchDraftsHotkey(event as unknown as HotkeyEventLike) === null) return
      event.preventDefault()
      event.stopPropagation()
      ctx.workspaces.startSession()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, 'session-drafts: Ctrl+Alt+N')
}
