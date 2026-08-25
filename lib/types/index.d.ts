/**
 * dsh-session-drafts, host half.
 *
 * Intentionally empty: all behavior lives in the browser bundle
 * (`exports["./client"]`, built from `src/client/index.tsx`). This module
 * exists so the package is a loadable Cordis plugin in the host profile —
 * loading it is what places the client bundle into the web boot graph
 * (the client-modules scanner keys off loaded plugin packages that declare
 * `dsh.client` in their manifest).
 *
 * What the client half does (v0.2, no popover): every New Session click
 * mints a fresh durable blank session on the host (`session.create`) instead
 * of reusing the workspace's single blank, and the sessions list snapshot is
 * overlaid so every draft renders as an ordinary sidebar tree row — draft
 * title (live unsent-text preview, persisted), creation time, stock row menu
 * (Archive = discard), gray tint + pencil mark. Cursor-style chat list.
 * @module @ne-ilyxa/dsh-session-drafts
 */
import type { Context } from '@deepseek-ai/cordis';
/** Client-side plugin configuration (reserved; no options today). */
export interface SessionDraftsConfig {
}
/**
 * No-op host plugin: installs nothing on the host. See the module doc.
 * @param _ctx - host plugin context (unused).
 * @param _config - profile-layer config (unused).
 */
export default function sessionDraftsHost(_ctx: Context, _config?: SessionDraftsConfig): void;
