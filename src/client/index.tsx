/**
 * dsh-session-drafts, browser half.
 *
 * Cursor-style New Session for the DSH web shell:
 *
 * 1. Fresh drafts — `workspaces.startSession` (the one service entry every
 *    New Session surface calls: the sidebar button, the workspace browser,
 *    the agent preset) is patched on the live WorkspaceRuntime instance to
 *    ALWAYS mint a fresh durable blank session on the host
 *    (`session.create` persists the Session entity before any message) and
 *    open it, instead of reusing the workspace's existing blank session.
 *    Several empty chats can now coexist in Session persistence.
 *
 * 2. Drafts switcher — the stock tree hides blank sessions other than the
 *    current one, so an add-on `sidebar.footer.action` entry (an additive
 *    list slot) renders a "Drafts" trigger + popover listing every blank
 *    session: switch to one, discard it (workspace archive), or mint a new
 *    draft straight from the panel.
 *
 * Patch discipline: instance-level property shadowing guarded by a
 * `Symbol.for` marker (idempotent across HMR), restored on fiber unload,
 * falling back to the stock method on any synchronous failure. No core
 * files are modified.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCloseOutline16,
  IconNewChatOutline16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

// ---------------------------------------------------------------------------
// Structural surface types (the plugin declares what it consumes; the runtime
// satisfies these structurally — same discipline as the stock client plugins).
// ---------------------------------------------------------------------------

/** Session-list row facts the drafts view reads. */
interface SessionRowLike {
  readonly id: string
  readonly blank: boolean
  readonly cwd?: string
  readonly updatedAt: number
  readonly origin?: string
}

/** sessions.list snapshot facts the drafts view reads. */
interface SessionListLike {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionRowLike | undefined>>
  readonly current: string | undefined
}

/** Workspace row facts the drafts view reads. */
interface WorkspaceLike {
  readonly workspaceId: string
  readonly path: string
  readonly title?: string
  readonly sessionIds: readonly string[]
}

/** workspaces.list snapshot facts the drafts view reads. */
interface WorkspaceListLike {
  readonly items: readonly WorkspaceLike[]
  readonly archivedSessionIds: readonly string[]
  readonly recentWorkspaceId: string | undefined
}

/** The sessions service face the patch and the widget use. */
interface SessionsLike {
  readonly list: { getSnapshot(): SessionListLike }
  create(opts: { workspaceId?: string; cwd?: string }): Promise<string>
  open(id: string): void
  clear(): void
  /** Session scope for facade access (undefined until the session is opened). */
  scope?(sessionId: string): unknown | undefined
}

/** Per-session composer input face (ui-conversation's conversation.input). */
interface ConversationInputLike {
  for(scope: unknown): { readonly state: { getSnapshot(): { readonly draft?: string } } }
}

/** The workspaces service face the patch and the widget use. */
interface WorkspacesLike {
  readonly list: { getSnapshot(): WorkspaceListLike }
  startSession(workspaceId?: string): void
  archiveSession(sessionId: string): Promise<void>
}

/** Locale registration face (the locale plugin's product). */
interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
}

/** Browser Cordis context face this plugin consumes. */
interface ClientContextLike {
  readonly slots: {
    inject(key: string, install: () => (() => void)): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
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
  /** Layout-independent physical key ('KeyN', 'KeyD'); absent on old engines. */
  readonly code?: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  /** True exactly while a real IME composition is open (not the legacy 229). */
  readonly isComposing?: boolean
}

/**
 * Match the drafts hotkeys: Ctrl+Alt+N mints a new draft, Ctrl+Alt+D toggles
 * the popover. Matching is by physical key code first — `event.key` follows
 * the keyboard layout, so a Russian layout yields 'т' for the N key and a
 * key-based matcher silently dies there. `event.key` stays as the fallback
 * for engines without codes. Ctrl+Alt avoids the browser's own
 * single-modifier shortcuts; an open IME composition is skipped — but the
 * legacy keyCode-229-alone signal deliberately is NOT (under Linux IBus every
 * keydown of a layout switch carries 229). There is deliberately NO
 * AltGraph guard: Firefox on Linux reports AltGraph=true for EVERY Ctrl+Alt
 * combination (X11 maps AltGr to Ctrl+Alt), so such a guard — however
 * well-meant for European layouts — kills the hotkeys for every Firefox user
 * on Linux.
 */
export function matchDraftsHotkey(event: HotkeyEventLike): 'new' | 'toggle' | null {
  if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return null
  if (event.isComposing === true) return null
  const code = event.code
  if (code === 'KeyN') return 'new'
  if (code === 'KeyD') return 'toggle'
  const key = event.key.toLowerCase()
  if (key === 'n') return 'new'
  if (key === 'd') return 'toggle'
  return null
}

// ---------------------------------------------------------------------------
// Pure draft derivation (exported for tests; no React, no context).
// ---------------------------------------------------------------------------

/** One switchable draft row projected for the popover. */
export interface DraftRow {
  readonly id: string
  /** Workspace display label: its stored title's path basename, cwd basename, or Ungrouped. */
  readonly label: string
  readonly updatedAt: number
  readonly current: boolean
}

/** Directory basename with both separators accepted; cwd fallback label. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** basename of a path ("both separators accepted"), or the fallback label. */
export function workspaceBaseLabel(path: string | undefined): string {
  if (path === undefined || path === '') return UNGROUPED_LABEL
  const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : path
}

/**
 * Project every switchable blank draft from the session list: blank, not a
 * subagent child, not archived; newest first (recency, id as the stable
 * tiebreak). The label prefers the workspace account that holds the session
 * (title basename), then the session cwd, then the ungrouped label.
 */
export function selectDraftRows(
  sessions: SessionListLike,
  workspaces: WorkspaceListLike,
): DraftRow[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const labelById = new Map<string, string>()
  for (const workspace of workspaces.items) {
    const label = workspaceBaseLabel(workspace.title === undefined || workspace.title === ''
      ? workspace.path
      : workspace.title)
    for (const id of workspace.sessionIds) {
      if (!labelById.has(id)) labelById.set(id, label)
    }
  }
  const rows: DraftRow[] = []
  for (const id of sessions.ids) {
    const summary = sessions.byId[id]
    if (summary === undefined || !summary.blank || summary.origin === 'subagent') continue
    if (archived.has(summary.id)) continue
    rows.push({
      id: summary.id,
      label: labelById.get(summary.id) ?? workspaceBaseLabel(summary.cwd),
      updatedAt: summary.updatedAt,
      current: summary.id === sessions.current,
    })
  }
  rows.sort((a, b): number =>
    b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : a.id < b.id ? -1 : 1)
  return rows
}

/** Compact relative time for draft rows: "now", "{n}m", "{n}h", "{n}d". */
export function draftAge(updatedAt: number, now: number): { key: 'now' | 'min' | 'hour' | 'day'; n: number } {
  const diff = Math.max(0, now - updatedAt)
  if (diff < 60_000) return { key: 'now', n: 0 }
  if (diff < 3_600_000) return { key: 'min', n: Math.floor(diff / 60_000) }
  if (diff < 86_400_000) return { key: 'hour', n: Math.floor(diff / 3_600_000) }
  return { key: 'day', n: Math.floor(diff / 86_400_000) }
}

/**
 * One-line preview of a draft's unsent composer text: whitespace collapsed,
 * capped at {@link max} chars with an ellipsis. Blank input previews as
 * undefined (nothing to show). Pure projection of InputState.text.
 */
export function draftPreview(text: string, max = 60): string | undefined {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return undefined
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`
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
// Drafts switcher widget (additive `sidebar.footer.action` entry).
// ---------------------------------------------------------------------------

const NS = 'sessionDrafts'
const STYLE_ID = '@ne-ilyxa/dsh-session-drafts'

const en = {
  trigger: 'Drafts',
  triggerLabel: 'Chat drafts ({n}) — Ctrl+Alt+D',
  header: 'Drafts',
  rowTitle: 'New Session',
  discard: 'Discard draft',
  open: 'Open draft',
  newDraft: 'New Session',
  empty: 'No empty chats',
  timeNow: 'now',
  timeMin: '{n}m',
  timeHour: '{n}h',
  timeDay: '{n}d',
} as const

const zh = {
  trigger: '草稿',
  triggerLabel: '聊天草稿（{n}）— Ctrl+Alt+D',
  header: '草稿',
  rowTitle: '新会话',
  discard: '丢弃草稿',
  open: '打开草稿',
  newDraft: '新会话',
  empty: '暂无空白会话',
  timeNow: '刚刚',
  timeMin: '{n}分钟',
  timeHour: '{n}小时',
  timeDay: '{n}天',
} as const

/** Viewport-edge clearance for the anchored panel (matches Menu's 12px rule). */
const PANEL_MARGIN = 12
/** Gap between the trigger row and the panel opened above it. */
const PANEL_GAP = 8

/** Props the slot framework composes into the footer action entry. */
interface DraftsFooterActionProps {
  readonly wide: boolean
  readonly useSessions: <T>(selector: (snapshot: SessionListLike) => T) => T
  readonly useWorkspaces: <T>(selector: (snapshot: WorkspaceListLike) => T) => T
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly startSession: () => void
  readonly openSession: (sessionId: string) => void
  readonly discardSession: (sessionId: string) => void
  /** Raw unsent composer text of one draft (undefined when none/unopened). */
  readonly draftPreviewOf: (sessionId: string) => string | undefined
}

/** Sidebar foot entry: drafts trigger + anchored popover switcher. */
export function DraftsFooterAction(props: DraftsFooterActionProps): ReactNode {
  const { wide, useSessions, useWorkspaces, t, startSession, openSession, discardSession, draftPreviewOf } = props
  const sessions = useSessions(snapshot => snapshot)
  const workspaces = useWorkspaces(snapshot => snapshot)
  const drafts = selectDraftRows(sessions, workspaces)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Drafts appearing/disappearing retimes the rows and re-anchors an open panel.
  // The immediate setNow on open is the fix for stale ages: `now` initializes at
  // trigger mount (≈ the first draft's creation time), so rows rendered from a
  // later open would diff against the mount time and forever read "now".
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [open])

  // Global hotkeys: Ctrl+Alt+N mints a fresh draft from anywhere (works with
  // zero drafts too — the trigger hides, the hotkey must not), Ctrl+Alt+D
  // toggles the popover. Registered on WINDOW in the CAPTURE phase: window is
  // the first node of the event path, so no document/container handler can
  // stopPropagation() the event away from us. That is not theoretical — the
  // dsh-better-sidebar IME guard (document capture) calls stopPropagation on
  // every keydown it believes is composition, and under Linux IBus layout
  // switching that is EVERY keydown (keyCode 229), which silently killed
  // bubble-phase listeners of any layout. Registered before the zero-drafts
  // null return, so the listener lives whenever the sidebar footer does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // DOM EventTarget is opaque to the structural matcher (tagName lives on
      // Element); the cast is the documented seam — the matcher narrows safely.
      const action = matchDraftsHotkey(event as unknown as HotkeyEventLike)
      if (action === null) return
      event.preventDefault()
      event.stopPropagation()
      if (action === 'new') {
        setOpen(false)
        startSession()
      } else {
        setOpen(current => !current)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [startSession])

  // Anchor the panel above the trigger (the foot sits at the viewport bottom),
  // falling below only when there is no room; re-run on scroll/resize.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const width = panelRef.current?.offsetWidth ?? 0
      const height = panelRef.current?.offsetHeight ?? 0
      const left = Math.min(Math.max(rect.left, PANEL_MARGIN), Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN))
      let top = rect.top - height - PANEL_GAP
      if (top < PANEL_MARGIN) top = Math.min(rect.bottom + PANEL_GAP, Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN))
      setPosition({ left, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, drafts.length])

  // Outside pointerdown / Escape closes (the panel is portaled, so both the
  // trigger and the panel count as inside).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target
      if (node instanceof Node
        && (triggerRef.current?.contains(node) || panelRef.current?.contains(node))) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const onOpen = useCallback((sessionId: string): void => {
    setOpen(false)
    openSession(sessionId)
  }, [openSession])

  const onDiscard = useCallback((sessionId: string): void => {
    discardSession(sessionId)
  }, [discardSession])

  if (drafts.length === 0) return null

  const rows = drafts.map((draft) => {
    const age = draftAge(draft.updatedAt, now)
    const when = age.key === 'now'
      ? t('timeNow')
      : t(`time${age.key === 'min' ? 'Min' : age.key === 'hour' ? 'Hour' : 'Day'}`, { n: age.n })
    // Snapshot-at-render preview: only an opened session has a composer, and
    // the popover is closed while its own draft is being typed into.
    const preview = draftPreview(draftPreviewOf(draft.id) ?? '')
    return (
      <div
        key={draft.id}
        className={`dsd-row${draft.current ? ' dsd-current' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${t('open')} — ${draft.label}`}
        onClick={() => { onOpen(draft.id) }}
        onKeyDown={(event) => { if (event.key === 'Enter') onOpen(draft.id) }}
      >
        <span className="dsd-rowIcon" aria-hidden="true"><IconNewChatOutline16 size={16} /></span>
        <span className="dsd-rowBody">
          <span className="dsd-rowTitle">{t('rowTitle')}</span>
          <span className="dsd-rowLabel">{draft.label}</span>
          {preview !== undefined && <span className="dsd-rowPreview" title={preview}>{preview}</span>}
        </span>
        <span className="dsd-rowWhen">{when}</span>
        <button
          type="button"
          className="dsd-discard"
          aria-label={t('discard')}
          title={t('discard')}
          onClick={(event) => {
            event.stopPropagation()
            onDiscard(draft.id)
          }}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </div>
    )
  })

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`dsd-trigger${wide ? '' : ' dsd-rail'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('triggerLabel', { n: drafts.length })}
        title={t('triggerLabel', { n: drafts.length })}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className="dsd-triggerIcon" aria-hidden="true"><IconNewChatOutline16 size={wide ? 14 : 18} /></span>
        {wide && <span className="dsd-triggerLabel">{t('trigger')}</span>}
        <span className={`dsd-count${wide ? '' : ' dsd-countRail'}`}>{drafts.length}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="dsd-panel"
          role="dialog"
          aria-label={t('header')}
          style={position === null
            ? { visibility: 'hidden', left: 0, top: 0 }
            : { left: position.left, top: position.top }}
        >
          <div className="dsd-panelHeader">{t('header')}</div>
          <div className="dsd-rows">{rows.length > 0 ? rows : <div className="dsd-empty">{t('empty')}</div>}</div>
          <div className="dsd-panelFooter">
            <button
              type="button"
              className="dsd-new"
              onClick={() => {
                setOpen(false)
                startSession()
              }}
            >
              <span aria-hidden="true"><IconPlusOutline16 size={14} /></span>
              <span>{t('newDraft')}</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'conversation']

/** Shared stylesheet, guarded by a stable data attribute across HMR loads. */
const styles = `
.dsd-trigger{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:36px;padding:0 10px;margin:0 2px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;width:100%;justify-content:flex-start}
.dsd-trigger:hover{background:var(--dsw-alias-button-floating-hover)}
.dsd-triggerIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dsd-triggerLabel{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-count{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;text-align:center}
.dsd-trigger.dsd-rail{width:36px;height:36px;padding:0;justify-content:center;margin:0 0 8px}
.dsd-countRail{position:absolute;transform:translate(14px,-10px);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2)}
.dsd-trigger.dsd-rail{position:relative}
.dsd-panel{position:fixed;z-index:1100;box-sizing:border-box;width:264px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsd-panelHeader{flex:none;padding:8px 10px 6px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsd-rows{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.dsd-row{position:relative;display:flex;align-items:center;gap:8px;min-height:40px;padding:6px 8px;border-radius:10px;cursor:pointer}
.dsd-row:hover{background:var(--dsw-alias-fill-secondary)}
.dsd-row:focus-visible{outline:2px solid var(--dsw-alias-border-focus);outline-offset:-2px}
.dsd-rowIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dsd-rowBody{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsd-rowTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}
.dsd-rowLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsd-rowPreview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;font-style:italic}
.dsd-rowWhen{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsd-current .dsd-rowTitle{color:var(--dsw-alias-label-brand)}
.dsd-current::before{content:"";position:absolute;left:2px;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--dsw-alias-label-brand)}
.dsd-discard{flex:none;display:none;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsd-row:hover .dsd-discard,.dsd-discard:focus-visible{display:inline-flex}
.dsd-discard:hover{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary)}
.dsd-empty{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsd-panelFooter{flex:none;display:flex;flex-direction:column;margin-top:4px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsd-new{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px 10px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}
.dsd-new:hover{background:var(--dsw-alias-fill-secondary)}
`

/**
 * Browser plugin entry: stylesheet, dictionaries, the New Session patch, and
 * the drafts switcher registration.
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

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'session-drafts',
      order: 10,
      inject: () => ({
        startSession: () => { ctx.workspaces.startSession() },
        openSession: (sessionId: string) => { ctx.sessions.open(sessionId) },
        discardSession: (sessionId: string) => {
          void ctx.workspaces.archiveSession(sessionId).catch((error: unknown) => {
            console.warn('[session-drafts] draft discard failed:', error)
          })
        },
        draftPreviewOf: (sessionId: string): string | undefined => {
          // Only a listed session has a scope; its input shell is resident
          // (the hub materializes shells with the scope). The draft field is
          // InputState.draft; anything unexpected previews as nothing.
          try {
            const scope = ctx.sessions.scope?.(sessionId)
            if (scope === undefined) return undefined
            const draft = ctx.conversation.input.for(scope).state.getSnapshot().draft
            return typeof draft === 'string' ? draft : undefined
          } catch {
            return undefined
          }
        },
      }),
      locale: NS,
    },
    DraftsFooterAction,
  ))
}
