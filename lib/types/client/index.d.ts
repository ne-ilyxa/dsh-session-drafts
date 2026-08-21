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
import { type ReactNode } from 'react';
/** Session-list row facts the drafts view reads. */
interface SessionRowLike {
    readonly id: string;
    readonly blank: boolean;
    readonly cwd?: string;
    readonly updatedAt: number;
    readonly origin?: string;
}
/** sessions.list snapshot facts the drafts view reads. */
interface SessionListLike {
    readonly ids: readonly string[];
    readonly byId: Readonly<Record<string, SessionRowLike | undefined>>;
    readonly current: string | undefined;
}
/** Workspace row facts the drafts view reads. */
interface WorkspaceLike {
    readonly workspaceId: string;
    readonly path: string;
    readonly title?: string;
    readonly sessionIds: readonly string[];
}
/** workspaces.list snapshot facts the drafts view reads. */
interface WorkspaceListLike {
    readonly items: readonly WorkspaceLike[];
    readonly archivedSessionIds: readonly string[];
    readonly recentWorkspaceId: string | undefined;
}
/** The sessions service face the patch and the widget use. */
interface SessionsLike {
    readonly list: {
        getSnapshot(): SessionListLike;
    };
    create(opts: {
        workspaceId?: string;
        cwd?: string;
    }): Promise<string>;
    open(id: string): void;
    clear(): void;
    /** Session scope for facade access (undefined until the session is opened). */
    scope?(sessionId: string): unknown | undefined;
}
/** Per-session composer input face (ui-conversation's conversation.input). */
interface ConversationInputLike {
    for(scope: unknown): {
        readonly state: {
            getSnapshot(): {
                readonly draft?: string;
            };
        };
    };
}
/** The workspaces service face the patch and the widget use. */
interface WorkspacesLike {
    readonly list: {
        getSnapshot(): WorkspaceListLike;
    };
    startSession(workspaceId?: string): void;
    archiveSession(sessionId: string): Promise<void>;
}
/** Locale registration face (the locale plugin's product). */
interface LocaleLike {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void;
}
/** Browser Cordis context face this plugin consumes. */
interface ClientContextLike {
    readonly slots: {
        inject(key: string, install: () => (() => void)): () => void;
        register(options: Record<string, unknown>, component: unknown): () => void;
    };
    readonly sessions: SessionsLike;
    readonly workspaces: WorkspacesLike;
    readonly locale: LocaleLike;
    readonly conversation: {
        readonly input: ConversationInputLike;
    };
    effect(setup: () => (() => void) | void, label?: string): (() => void) | void;
}
/** Minimal keyboard-event shape the hotkey matcher reads. */
export interface HotkeyEventLike {
    readonly key: string;
    /** Layout-independent physical key ('KeyN', 'KeyD'); absent on old engines. */
    readonly code?: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    /** True exactly while a real IME composition is open (not the legacy 229). */
    readonly isComposing?: boolean;
    /** AltGraph detector (typing on European layouts rides Ctrl+Alt). */
    getModifierState?(state: 'AltGraph'): boolean;
}
/**
 * Match the drafts hotkeys: Ctrl+Alt+N mints a new draft, Ctrl+Alt+D toggles
 * the popover. Matching is by physical key code first — `event.key` follows
 * the keyboard layout, so a Russian layout yields 'т' for the N key and a
 * key-based matcher silently dies there. `event.key` stays as the fallback
 * for engines without codes. Ctrl+Alt avoids the browser's own
 * single-modifier shortcuts; AltGraph (Ctrl+Alt on European layouts, a
 * TYPING modifier) is explicitly excluded so composing characters never
 * mints drafts. An open IME composition is skipped too — but the legacy
 * keyCode-229-alone signal deliberately is NOT: under Linux IBus every
 * keydown of a layout switch carries 229, and honoring it would kill the
 * hotkeys entirely (the dsh-better-sidebar capture guard does exactly that
 * and must not be joined).
 */
export declare function matchDraftsHotkey(event: HotkeyEventLike): 'new' | 'toggle' | null;
/** One switchable draft row projected for the popover. */
export interface DraftRow {
    readonly id: string;
    /** Workspace display label: its stored title's path basename, cwd basename, or Ungrouped. */
    readonly label: string;
    readonly updatedAt: number;
    readonly current: boolean;
}
/** Directory basename with both separators accepted; cwd fallback label. */
export declare const UNGROUPED_LABEL = "Ungrouped";
/** basename of a path ("both separators accepted"), or the fallback label. */
export declare function workspaceBaseLabel(path: string | undefined): string;
/**
 * Project every switchable blank draft from the session list: blank, not a
 * subagent child, not archived; newest first (recency, id as the stable
 * tiebreak). The label prefers the workspace account that holds the session
 * (title basename), then the session cwd, then the ungrouped label.
 */
export declare function selectDraftRows(sessions: SessionListLike, workspaces: WorkspaceListLike): DraftRow[];
/** Compact relative time for draft rows: "now", "{n}m", "{n}h", "{n}d". */
export declare function draftAge(updatedAt: number, now: number): {
    key: 'now' | 'min' | 'hour' | 'day';
    n: number;
};
/**
 * One-line preview of a draft's unsent composer text: whitespace collapsed,
 * capped at {@link max} chars with an ellipsis. Blank input previews as
 * undefined (nothing to show). Pure projection of InputState.text.
 */
export declare function draftPreview(text: string, max?: number): string | undefined;
/** Resolve the New Session target exactly like the stock policy (minus reuse). */
export declare function resolveTargetWorkspaceId(workspaces: WorkspaceListLike, sessions: SessionListLike): string | undefined;
/**
 * Patch one live WorkspaceRuntime instance so `startSession` always creates a
 * fresh blank session on the host and opens it (the stock method reuses the
 * workspace's existing blank session, capping empty chats at one per
 * workspace). The resolution policy (explicit → current Session's workspace →
 * recent workspace; clear the selection when none exists) is preserved.
 * @returns disposer restoring the stock method (no-op when unsupported).
 */
export declare function installFreshSessions(deps: {
    workspaces: WorkspacesLike;
    sessions: SessionsLike;
}): () => void;
/** Props the slot framework composes into the footer action entry. */
interface DraftsFooterActionProps {
    readonly wide: boolean;
    readonly useSessions: <T>(selector: (snapshot: SessionListLike) => T) => T;
    readonly useWorkspaces: <T>(selector: (snapshot: WorkspaceListLike) => T) => T;
    readonly t: (key: string, params?: Record<string, string | number>) => string;
    readonly startSession: () => void;
    readonly openSession: (sessionId: string) => void;
    readonly discardSession: (sessionId: string) => void;
    /** Raw unsent composer text of one draft (undefined when none/unopened). */
    readonly draftPreviewOf: (sessionId: string) => string | undefined;
}
/** Sidebar foot entry: drafts trigger + anchored popover switcher. */
export declare function DraftsFooterAction(props: DraftsFooterActionProps): ReactNode;
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Browser plugin entry: stylesheet, dictionaries, the New Session patch, and
 * the drafts switcher registration.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContextLike): void;
export {};
