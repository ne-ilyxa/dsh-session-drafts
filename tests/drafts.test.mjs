import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** Load the wrapped browser bundle in a VM; returns its exports. */
async function loadPlugin() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  const context = {
    console,
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory(() => { throw new Error('bundle must require nothing') })
        },
      },
    },
  }
  vm.runInNewContext(source, context)
  assert.ok(plugin, 'bundle registered with window.__ModuleLoader__.load')
  return plugin
}

/** Re-encode a VM-realm value into the host realm for strict deepEqual. */
const plain = value => JSON.parse(JSON.stringify(value))

function sessionsFixture() {
  return {
    ids: ['a', 'b', 'c', 'd'],
    byId: {
      // Plain draft under a workspace.
      a: { id: 'a', blank: true, cwd: '/home/x/sellprof', updatedAt: 500 },
      // Real chat: must pass through untouched.
      b: { id: 'b', blank: false, cwd: '/home/x/sellprof', updatedAt: 400, displayTitle: 'sellprof' },
      // Subagent blank: stock hides subagent children — the overlay must too.
      c: { id: 'c', blank: true, updatedAt: 300, origin: 'subagent' },
      // Pinned draft: explicit rename wins over preview/fallback.
      d: { id: 'd', blank: true, cwd: '/home/x/realt', updatedAt: 200, title: 'Заметки', displayTitle: 'Заметки' },
    },
    current: 'a',
    phase: 'ready',
  }
}

// ---------------------------------------------------------------------------
// Bundle surface
// ---------------------------------------------------------------------------

test('bundle declares the runtime services it needs (no slots: stock tree renders drafts)', async () => {
  const plugin = await loadPlugin()
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['sessions', 'workspaces', 'conversation', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

test('matchDraftsHotkey matches only Ctrl+Alt+N, layout-independent', async () => {
  const plugin = await loadPlugin()
  const ev = (key, over = {}) => ({
    key, code: undefined, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over,
  })
  // English layout: both code and key agree.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN' })), 'new')
  // Russian layout: event.key is 'т' for the physical N key — the code wins.
  assert.equal(plugin.matchDraftsHotkey(ev('т', { ctrlKey: true, altKey: true, code: 'KeyN' })), 'new')
  // No code (old engine): layout-dependent key falls back.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true })), 'new')
  // The v0.1 Ctrl+Alt+D popover toggle is gone with the popover.
  assert.equal(plugin.matchDraftsHotkey(ev('d', { ctrlKey: true, altKey: true, code: 'KeyD' })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('в', { ctrlKey: true, altKey: true, code: 'KeyD' })), null)
  // Firefox on Linux reports AltGraph=true for EVERY Ctrl+Alt combination
  // (X11 maps AltGr to Ctrl+Alt) — an AltGraph guard killed the hotkeys for
  // every Firefox/Linux user, so it is deliberately absent.
  assert.equal(plugin.matchDraftsHotkey(ev('n', {
    ctrlKey: true, altKey: true, code: 'KeyN', getModifierState: () => true,
  })), 'new')
  // An open IME composition is skipped; the legacy 229-alone signal is NOT
  // (Linux IBus stamps every keydown of a switched layout with it).
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', isComposing: true })), null)
  // Not ours: single modifiers, extra modifiers, other keys, other codes.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { altKey: true, code: 'KeyN' })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, code: 'KeyN' })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', shiftKey: true })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', metaKey: true })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('q', { ctrlKey: true, altKey: true, code: 'KeyQ' })), null)
})

// ---------------------------------------------------------------------------
// Pure projections
// ---------------------------------------------------------------------------

test('draftPreview collapses whitespace and caps length', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.draftPreview(''), undefined)
  assert.equal(plugin.draftPreview('   \n\t  '), undefined)
  assert.equal(plugin.draftPreview('  Рефакторинг\n  парсера  '), 'Рефакторинг парсера')
  assert.equal(plugin.draftPreview('a'.repeat(60)), 'a'.repeat(60))
  assert.equal(plugin.draftPreview('a'.repeat(61)), `${'a'.repeat(60)}…`)
  assert.equal(plugin.draftPreview('b'.repeat(100), 10), 'bbbbbbbbbb…')
})

test('projectDraftList flips plain blanks to visible rows with draft titles', async () => {
  const plugin = await loadPlugin()
  const stock = sessionsFixture()
  const previews = new Map([['a', 'Рефакторинг парсера']])
  const out = plugin.projectDraftList(stock, previews, 'New Session')

  // Plain draft: visible row, preview title.
  assert.equal(out.byId.a.blank, false)
  assert.equal(out.byId.a.displayTitle, 'Рефакторинг парсера')
  // Pinned draft: explicit title wins.
  assert.equal(out.byId.d.blank, false)
  assert.equal(out.byId.d.displayTitle, 'Заметки')
  // Subagent blank untouched (stock hides it by design).
  assert.equal(out.byId.c.blank, true)
  assert.equal(out.byId.c.displayTitle, undefined)
  // Real chat passes through BY REFERENCE (no churn for stock rows).
  assert.equal(out.byId.b, stock.byId.b)
  // Everything else rides the snapshot by reference.
  assert.equal(out.ids, stock.ids)
  assert.equal(out.current, 'a')
  assert.equal(out.phase, 'ready')
})

test('projectDraftList falls back to the localized New Session and stays referentially stable', async () => {
  const plugin = await loadPlugin()
  const stock = sessionsFixture()
  const out = plugin.projectDraftList(stock, new Map(), 'New Session')
  assert.equal(out.byId.a.displayTitle, 'New Session')

  // No projectable drafts at all: the STOCK reference comes back untouched —
  // getSnapshot stability between mutations is the uSES contract.
  const quiet = { ids: ['b'], byId: { b: stock.byId.b }, current: 'b' }
  assert.equal(plugin.projectDraftList(quiet, new Map(), 'New Session'), quiet)
})

test('draftRowTitles maps draft ids to their overlay titles', async () => {
  const plugin = await loadPlugin()
  const titles = plugin.draftRowTitles(sessionsFixture(), new Map([['a', 'превью']]), 'New Session')
  assert.deepEqual([...titles.keys()].sort(), ['a', 'd'])
  assert.equal(titles.get('a'), 'превью')
  assert.equal(titles.get('d'), 'Заметки')
})

test('matchDraftRow prefix-matches titles, ignores the trailing time, rejects short titles', async () => {
  const plugin = await loadPlugin()
  const titles = ['New Session', 'Рефакторинг парсера']
  assert.equal(plugin.matchDraftRow('New Sessionnow', titles), true)
  assert.equal(plugin.matchDraftRow('Рефакторинг парсера5min', titles), true)
  assert.equal(plugin.matchDraftRow('New Sessional title renamed later', titles), true)
  assert.equal(plugin.matchDraftRow('sellprof', titles), false)
  assert.equal(plugin.matchDraftRow('Рефакторинг autre', titles), false)
  // <3 chars never match — a 1–2 char preview prefixing an unrelated
  // workspace label would paint a row that is not a draft.
  assert.equal(plugin.matchDraftRow('se', ['se']), false)
  assert.equal(plugin.matchDraftRow('sellprof', ['sel']), true)
})

test('projectDraftList neutralizes the stock blank-reuse scan (hero picker mints fresh)', async () => {
  const plugin = await loadPlugin()
  // connectWorkspace reuses a workspace's existing blank session by scanning
  // sessions.list for `blank && cwd === workspace.path && member && !archived`.
  // Encode that exact scan over the PROJECTED snapshot: with every draft
  // carrying blank:false, the scan finds nothing and the stock path falls
  // through to session.create — Cursor semantics for the hero picker, for
  // free, with no second patch.
  const stock = sessionsFixture()
  const workspace = { path: '/home/x/sellprof', sessionIds: ['a', 'b'] }
  const archived = new Set()
  const reusable = snapshot => {
    for (const id of snapshot.ids) {
      const s = snapshot.byId[id]
      if (s !== undefined && s.blank && s.cwd === workspace.path
        && workspace.sessionIds.includes(s.id) && !archived.has(s.id)) return s.id
    }
    return undefined
  }
  assert.equal(reusable(stock), 'a', 'sanity: the stock snapshot offers the old blank')
  assert.equal(reusable(plugin.projectDraftList(stock, new Map(), 'New Session')), undefined,
    'the projected snapshot offers no reusable blank')
})

// ---------------------------------------------------------------------------
// New Session patch (unchanged semantics since v0.1)
// ---------------------------------------------------------------------------

test('installFreshSessions patches startSession to always create a fresh session', async () => {
  const plugin = await loadPlugin()
  const created = []
  const opened = []
  const cleared = []
  const stockCalls = []
  const workspacesFixture = {
    items: [
      { workspaceId: 'w1', sessionIds: ['a', 'b'] },
      { workspaceId: 'w2', sessionIds: ['d'] },
    ],
    recentWorkspaceId: 'w1',
  }
  const workspaces = {
    list: { getSnapshot: () => workspacesFixture },
    startSession(workspaceId) { stockCalls.push(workspaceId) },
  }
  const sessions = {
    list: { getSnapshot: () => sessionsFixture() },
    create: async (opts) => {
      created.push(opts)
      return 'fresh-1'
    },
    open: (id) => { opened.push(id) },
    clear: () => { cleared.push(true) },
  }

  const dispose = plugin.installFreshSessions({ workspaces, sessions })
  assert.equal(stockCalls.length, 0, 'stock method untouched until the patch runs')

  // Unscoped call inherits the current session's workspace (w1), never reuses.
  // (plain(): the patch runs inside the VM realm — strict deepEqual compares
  // prototypes, so cross-realm values are re-encoded first.)
  workspaces.startSession()
  await Promise.resolve()
  assert.deepEqual(plain(created), [{ workspaceId: 'w1' }])
  assert.deepEqual(plain(opened), ['fresh-1'])

  // Explicit workspace targets that workspace.
  workspaces.startSession('w2')
  await Promise.resolve()
  assert.deepEqual(plain(created), [{ workspaceId: 'w1' }, { workspaceId: 'w2' }])

  // Dispose restores the stock method.
  dispose()
  workspaces.startSession('w1')
  assert.deepEqual(stockCalls, ['w1'])
  assert.equal(created.length, 2)
})

// ---------------------------------------------------------------------------
// Draft projection install (store shadow + live preview mirror)
// ---------------------------------------------------------------------------

/** A minimal snapshot store: getSnapshot/subscribe over mutable state. */
function miniStore(initial) {
  const listeners = new Set()
  let state = initial
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

test('installDraftProjection shadows the store: drafts visible, previews live, dispose restores', async () => {
  const plugin = await loadPlugin()

  const fixture = sessionsFixture()
  const stock = miniStore(fixture)
  const originalGet = stock.getSnapshot
  const shellA = { state: miniStore({ draft: '' }) }
  const shellD = { state: miniStore({ draft: '' }) }
  const shells = { a: shellA, d: shellD }

  const sessions = {
    list: stock,
    scope: id => ({ id }),
    create: async () => 'x',
    open: () => {},
    clear: () => {},
  }
  const conversation = { input: { for: scope => shells[scope.id] } }

  const dispose = plugin.installDraftProjection({ sessions, conversation, fallbackTitle: () => 'New Session' })

  // Stock flips: plain + pinned drafts become rows, subagent blank hidden.
  let view = stock.getSnapshot()
  assert.equal(view.byId.a.blank, false)
  assert.equal(view.byId.a.displayTitle, 'New Session')
  assert.equal(view.byId.c.blank, true)
  assert.equal(view.ids, fixture.ids, 'ids ride the stock array')

  // Referential stability between reads without changes (uSES contract).
  assert.equal(stock.getSnapshot(), view)

  // A subscriber is woken by overlay changes (typing) — not only stock ones.
  let wakes = 0
  const off = stock.subscribe(() => { wakes += 1 })

  // Type into draft A's composer: the row title becomes the live preview.
  shellA.state.set({ draft: '  Рефакторинг\n  парсера  ' })
  assert.ok(wakes >= 1, 'overlay change woke the subscriber')
  view = stock.getSnapshot()
  assert.equal(view.byId.a.displayTitle, 'Рефакторинг парсера')
  assert.equal(plugin.draftRegistry().previews.get('a'), 'Рефакторинг парсера')
  assert.equal(plugin.draftRegistry().titles.get('a'), 'Рефакторинг парсера')

  // Clearing the composer falls back to the New Session title.
  shellA.state.set({ draft: '   ' })
  view = stock.getSnapshot()
  assert.equal(view.byId.a.displayTitle, 'New Session')
  assert.equal(plugin.draftRegistry().previews.has('a'), false)

  // First send: the host flips blank on the stock snapshot — the overlay
  // stops touching the row and prunes the stale preview.
  shellA.state.set({ draft: 'черновик' })
  const next = sessionsFixture()
  next.byId.a = { ...next.byId.a, blank: false, displayTitle: 'настоящий заголовок' }
  stock.set(next)
  view = stock.getSnapshot()
  assert.equal(view.byId.a.displayTitle, 'настоящий заголовок')
  assert.equal(plugin.draftRegistry().previews.has('a'), false)
  assert.equal(plugin.draftRegistry().titles.has('a'), false)

  // A newly minted draft appears as a row on the next stock change.
  const minted = sessionsFixture()
  minted.ids = ['z', ...minted.ids]
  minted.byId = { z: { id: 'z', blank: true, cwd: '/home/x/new', updatedAt: 900 }, ...minted.byId }
  stock.set(minted)
  view = stock.getSnapshot()
  assert.equal(view.byId.z.blank, false)
  assert.equal(view.byId.z.displayTitle, 'New Session')

  off()
  dispose()
  // Dispose restores the stock read face (same function reference).
  assert.equal(stock.getSnapshot, originalGet)
  assert.equal(stock.getSnapshot().byId.z.blank, true, 'stock data untouched underneath')
})

test('installDraftProjection is idempotent and survives dispose+reinstall (HMR shape)', async () => {
  const plugin = await loadPlugin()
  const stock = miniStore(sessionsFixture())
  const sessions = {
    list: stock,
    scope: () => undefined, // no shells: preview mirror stays quiet
    create: async () => 'x',
    open: () => {},
    clear: () => {},
  }
  const conversation = { input: { for: () => { throw new Error('no binding') } } }

  const dispose1 = plugin.installDraftProjection({ sessions, conversation, fallbackTitle: () => 'New Session' })
  assert.equal(stock.getSnapshot().byId.a.blank, false)
  dispose1()
  const dispose2 = plugin.installDraftProjection({ sessions, conversation, fallbackTitle: () => 'New Session' })
  assert.equal(stock.getSnapshot().byId.a.blank, false)
  dispose2()
})
