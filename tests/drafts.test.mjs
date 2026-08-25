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
  // OS key-repeat (a held key) must not re-fire startSession inside the
  // in-flight mint window.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', repeat: true })), null)
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

test('classifyDraftRow: identity decides, text fallback is tint-only', async () => {
  const plugin = await loadPlugin()
  const ids = new Set(['a', 'd'])
  const titles = ['New Session', 'превью драфта']
  // Identity path — exact, cannot misclassify.
  assert.equal(plugin.classifyDraftRow('a', 'anything at all', ids, titles), 'full')
  assert.equal(plugin.classifyDraftRow('graduated-chat', 'New Session now', ids, titles), 'none')
  // Fallback path — text-prefix matches classify TINT ONLY (a false 'full'
  // would mute a real row's ⋯ and inject a working ×; a false tint costs a
  // gray color the next scan corrects).
  assert.equal(plugin.classifyDraftRow(undefined, 'New Sessionnow', ids, titles), 'tint')
  assert.equal(plugin.classifyDraftRow(undefined, 'dsh-plugins', ids, ['dsh']), 'tint')
  assert.equal(plugin.classifyDraftRow(undefined, 'unrelated row', ids, titles), 'none')
  // The C2 regression pin: a workspace-header text that prefixes a draft
  // preview never reaches 'full' — even when the fiber is unreachable.
  assert.equal(plugin.classifyDraftRow(undefined, 'fix the login bug3m', ids, ['fix']), 'tint')
})

test('draftRowTitles drops archived drafts from the marker feed', async () => {
  const plugin = await loadPlugin()
  const stock = sessionsFixture()
  const all = plugin.draftRowTitles(stock, new Map(), 'New Session')
  assert.deepEqual([...all.keys()].sort(), ['a', 'd'])
  const filtered = plugin.draftRowTitles(stock, new Map(), 'New Session', new Set(['d']))
  assert.deepEqual([...filtered.keys()], ['a'])
})

test('classifyDraftRow + archived filter ship in the bundle (affordance gating is real)', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /classifyDraftRow/u)
  assert.match(source, /overlayRefs/u, 'HMR dispose ordering refcount')
  assert.match(source, /event.repeat === true|repeat === true/u, 'hotkey auto-repeat guard')
})

test('findSessionId walks the fiber chain to the SessionNodeItem props, bounded and guarded', async () => {
  const plugin = await loadPlugin()
  // host fiber (div props: no node) → wrapper fiber → component fiber with
  // props.node.id — the real SessionNodeItem shape.
  const component = { memoizedProps: { node: { id: 'session-42' } }, return: null }
  const wrapper = { memoizedProps: { anchor: '<div/>' }, return: component }
  const host = { memoizedProps: { className: 'row', role: 'treeitem' }, return: wrapper }
  assert.equal(plugin.findSessionId(host), 'session-42')
  assert.equal(plugin.findSessionId(component), 'session-42')

  // No node anywhere (or a non-string id): undefined, never a throw.
  assert.equal(plugin.findSessionId({ memoizedProps: {}, return: { return: null } }), undefined)
  assert.equal(plugin.findSessionId({ memoizedProps: { node: { id: 7 } }, return: null }), undefined)
  assert.equal(plugin.findSessionId(undefined), undefined)
  assert.equal(plugin.findSessionId(null), undefined)

  // A degenerate cycle is bounded by the hop limit, not an infinite loop.
  const cyclic = { memoizedProps: null }
  cyclic.return = cyclic
  assert.equal(plugin.findSessionId(cyclic, 5), undefined)
})

test('bundle ships the draft affordance swap: muted ⋯ menu + injected × discard', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The ⋯ trigger is muted via a data attribute (locale-independent — the
  // aria label differs per language, so no aria selector may gate this).
  assert.match(source, /data-dsd-muted/u)
  assert.match(source, /button\[data-dsd-muted\]\{display:none!important\}/u)
  // The injected × takes the ⋯'s own seat and metrics (16px iconButton).
  assert.match(source, /data-dsd-discard/u)
  assert.match(source, /button\[data-dsd-discard\]\{[^}]*width:16px;height:16px/u)
  assert.match(source, /archiveSession/u, 'the × click must discard via workspace archive')
})

test('projectDraftList neutralizes the stock blank-reuse scan (the patched connect owns reuse)', async () => {
  const plugin = await loadPlugin()
  // connectWorkspace reuses a workspace's existing blank session by scanning
  // sessions.list for `blank && cwd === workspace.path && member && !archived`.
  // Encode that exact scan over the PROJECTED snapshot: with every draft
  // carrying blank:false, the scan finds nothing and the stock path falls
  // through to session.create. Harmless since v0.5 — the patched
  // connectWorkspace applies the empty-draft rule BEFORE the stock scan —
  // and it is what keeps the stock mint path from resurrecting an old blank
  // when the rule decides a mint is due.
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
// New Session patch (v0.3: reuse the empty draft, mint only when all occupied)
// ---------------------------------------------------------------------------

/** Flush the microtask chain plus one macrotask (connect→create→open depth). */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** Shared patch fixtures: w1={a,b} @ /home/x/sellprof, w2={d} @ /home/x/realt. */
function patchFixtures() {
  return {
    workspacesList: {
      items: [
        { workspaceId: 'w1', path: '/home/x/sellprof', sessionIds: ['a', 'b'] },
        { workspaceId: 'w2', path: '/home/x/realt', sessionIds: ['d'] },
      ],
      archivedSessionIds: [],
      recentWorkspaceId: 'w1',
    },
    sessionsList: sessionsFixture(),
  }
}

function makeServices(fixtures) {
  const created = []
  const opened = []
  const cleared = []
  const stockCalls = []
  const connecting = new Map() // the stock service's per-workspace in-flight dedupe
  return {
    created, opened, cleared, stockCalls,
    workspaces: {
      list: { getSnapshot: () => fixtures.workspacesList },
      startSession(workspaceId) { stockCalls.push(workspaceId) },
      // The stock connect: reuse-scan (nothing — drafts carry no cwd match
      // here), then create with the production dedupe semantics.
      async connectWorkspace(workspaceId) {
        const pending = connecting.get(workspaceId)
        if (pending !== undefined) return pending
        const attempt = (async () => {
          created.push({ workspaceId })
          await Promise.resolve()
          return 'fresh-1'
        })()
        connecting.set(workspaceId, attempt)
        return attempt.finally(() => { connecting.delete(workspaceId) })
      },
    },
    sessions: {
      list: { getSnapshot: () => fixtures.sessionsList },
      create: async (opts) => {
        created.push(opts)
        return 'fresh-1'
      },
      open: (id) => { opened.push(id) },
      clear: () => { cleared.push(true) },
    },
  }
}

test('installFreshSessions routes the empty-draft rule through connectWorkspace (all mint paths)', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { workspaces, sessions, created, opened } = makeServices(fixtures)

  const dispose = plugin.installFreshSessions({ workspaces, sessions })

  // Empty draft exists → the patched connect resolves it directly; the stock
  // connect (and its create) never runs. This is the seat the boot initial
  // selection and the hero workspace picker also call.
  await assert.deepEqual(
    await workspaces.connectWorkspace('w1'), 'a',
    'patched connect resolves the existing empty draft',
  )
  assert.deepEqual(created, [], 'no mint while an empty draft exists')
  workspaces.startSession()
  await Promise.resolve()
  assert.deepEqual(created, [], 'startSession through the patched connect reuses too')
  assert.deepEqual(plain(opened), ['a'])

  // Occupied world → falls through to the STOCK connect (its dedupe, its create).
  const previews = plugin.draftRegistry().previews
  previews.set('a', 'текст')
  await assert.equal(await workspaces.connectWorkspace('w1'), 'fresh-1')
  assert.deepEqual(plain(created), [{ workspaceId: 'w1' }])

  dispose()
})

test('installFreshSessions collapses a rapid double-click into ONE mint (stock dedupe preserved)', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { workspaces, sessions, created, opened } = makeServices(fixtures)
  const previews = plugin.draftRegistry().previews
  previews.set('a', 'черновик') // no empty draft anywhere

  const dispose = plugin.installFreshSessions({ workspaces, sessions })
  // Two clicks in the SAME macrotask — both land while the first create is
  // still in flight; the stock connecting map must collapse them.
  workspaces.startSession()
  workspaces.startSession()
  await settle()
  assert.deepEqual(plain(created), [{ workspaceId: 'w1' }], 'double click minted once')
  // Both clicks' promises settle on the SAME session; the double open is
  // harmless — the stock sessions.open() is idempotent.
  assert.ok(plain(opened).length >= 1 && plain(opened).every(id => id === 'fresh-1'),
    `opened must reference only the single minted draft, got ${JSON.stringify(opened)}`)

  dispose()
})

test('findReusableEmptyDraft picks the newest empty member draft, applying every stock guard', async () => {
  const plugin = await loadPlugin()
  const stock = {
    ids: ['e1', 'occ', 'sub', 'arc', 'other', 'cwdx', 'e2'],
    byId: {
      e1: { id: 'e1', blank: true, cwd: '/home/x/sellprof', updatedAt: 100 },
      e2: { id: 'e2', blank: true, cwd: '/home/x/sellprof', updatedAt: 300 },
      occ: { id: 'occ', blank: true, cwd: '/home/x/sellprof', updatedAt: 900 },
      sub: { id: 'sub', blank: true, cwd: '/home/x/sellprof', updatedAt: 800, origin: 'subagent' },
      arc: { id: 'arc', blank: true, cwd: '/home/x/sellprof', updatedAt: 700 },
      // Minted in w1 but its cwd points elsewhere — the stock reuse guard.
      cwdx: { id: 'cwdx', blank: true, cwd: '/elsewhere', updatedAt: 600 },
      // A draft of ANOTHER workspace (member of w2): never reused for w1.
      other: { id: 'other', blank: true, cwd: '/home/x/realt', updatedAt: 500 },
    },
    current: undefined,
  }
  const list = {
    items: [
      { workspaceId: 'w1', path: '/home/x/sellprof', sessionIds: ['e1', 'e2', 'occ', 'sub', 'arc', 'cwdx'] },
      { workspaceId: 'w2', path: '/home/x/realt', sessionIds: ['other'] },
    ],
    archivedSessionIds: ['arc'],
    recentWorkspaceId: 'w1',
  }
  const none = new Map()
  // World where only 'occ' carries unsent text: newest EMPTY member draft
  // wins (e2 over e1; occ skipped, sub/arch/foreign/cwd-mismatch never ride).
  const occ = new Map([['occ', 'текст']])
  assert.equal(plugin.findReusableEmptyDraft(stock, list, occ, 'w1')?.id, 'e2')
  // An entirely empty world: the newest blank member draft ('occ' itself).
  assert.equal(plugin.findReusableEmptyDraft(stock, list, none, 'w1')?.id, 'occ')
  // Every member draft occupied (unsent text preview): nothing to reuse.
  const previews = new Map([['e2', 'текст'], ['e1', 'текст'], ['occ', 'текст']])
  assert.equal(plugin.findReusableEmptyDraft(stock, list, previews, 'w1'), undefined)
  // Freeing e1 alone still leaves e2 as the jump target.
  previews.delete('e2')
  assert.equal(plugin.findReusableEmptyDraft(stock, list, previews, 'w1')?.id, 'e2')
  // Unknown workspace: nothing to reuse.
  assert.equal(plugin.findReusableEmptyDraft(stock, list, none, 'w404'), undefined)
  // archivedSessionIds may be absent in stripped shapes — no throw; without
  // the archive set the archived row can no longer be excluded, so the
  // newest blank member ('arc', 700) honestly wins over e2 (300).
  const { archivedSessionIds: _drop, ...slim } = list
  assert.equal(plugin.findReusableEmptyDraft(stock, slim, occ, 'w1')?.id, 'arc')
})

test('installFreshSessions jumps to the existing EMPTY draft instead of minting', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { workspaces, sessions, created, opened, stockCalls } = makeServices(fixtures)

  const dispose = plugin.installFreshSessions({ workspaces, sessions })

  // Unscoped call: fixture draft 'a' (blank, member of w1, no preview) is the
  // jump target — no session.create, just open.
  workspaces.startSession()
  await settle()
  assert.deepEqual(created, [], 'no mint while an empty draft exists')
  assert.deepEqual(plain(opened), ['a'])

  // Explicit other workspace: its own empty draft.
  workspaces.startSession('w2')
  await settle()
  assert.deepEqual(created, [])
  assert.deepEqual(plain(opened), ['a', 'd'])

  // Dispose restores the stock method (a disposed patch forwards to stock).
  dispose()
  workspaces.startSession('w1')
  assert.deepEqual(stockCalls, ['w1'])
  assert.equal(created.length, 0)
})

test('installFreshSessions mints only when every draft is occupied (or none exists)', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { workspaces, sessions, created, opened } = makeServices(fixtures)
  // Both fixture drafts carry unsent text — occupied, so the click mints.
  const previews = plugin.draftRegistry().previews
  previews.set('a', 'черновик про парсер')
  previews.set('d', 'заметки')

  const dispose = plugin.installFreshSessions({ workspaces, sessions })

  workspaces.startSession()
  await settle()
  // (plain(): the patch runs inside the VM realm — strict deepEqual compares
  // prototypes, so cross-realm values are re-encoded first.)
  assert.deepEqual(plain(created), [{ workspaceId: 'w1' }])
  assert.deepEqual(plain(opened), ['fresh-1'])

  // Explicit workspace targets that workspace.
  workspaces.startSession('w2')
  await settle()
  assert.deepEqual(plain(created), [{ workspaceId: 'w1' }, { workspaceId: 'w2' }])
  assert.equal(previews.get('fresh-1'), undefined, 'the minted session is empty by definition')

  // Freeing the preview of 'a' (composer cleared) makes it reusable again —
  // the next unscoped click jumps, no third mint.
  previews.delete('a')
  workspaces.startSession()
  await settle()
  assert.equal(created.length, 2)
  assert.deepEqual(plain(opened), ['fresh-1', 'fresh-1', 'a'])

  dispose()
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

test('installDraftProjection HMR ordering: an earlier generation disposing never un-projects a live one', async () => {
  const plugin = await loadPlugin()
  const stock = miniStore(sessionsFixture())
  const originalGet = stock.getSnapshot
  const sessions = {
    list: stock,
    scope: () => undefined,
    create: async () => 'x',
    open: () => {},
    clear: () => {},
  }
  const conversation = { input: { for: () => { throw new Error('no binding') } } }
  const install = () => plugin.installDraftProjection({
    sessions, conversation, fallbackTitle: () => 'New Session',
  })

  // Generation N installs; generation N+1 ADOPTS the same shadow; then N's
  // disposer runs (out of order) — the store must stay projected until the
  // LAST generation disposes.
  const disposeN = install()
  const disposeN1 = install()
  assert.equal(stock.getSnapshot().byId.a.blank, false)
  disposeN()
  assert.equal(stock.getSnapshot().byId.a.blank, false,
    'an earlier generation disposing must not un-project the live one')
  disposeN1()
  assert.equal(stock.getSnapshot, originalGet, 'the last generation out restores stock')
  assert.equal(stock.getSnapshot().byId.a.blank, true)
})

test('installDraftProjection keeps restored previews through the boot race (pending list)', async () => {
  const plugin = await loadPlugin()
  // The real-world shape this pins: a page reload restores previews from
  // localStorage, and the plugin activates BEFORE the host list lands. The
  // absent summaries must NOT read as "stopped being a draft" — that prune
  // wiped every restored preview and persisted the empty map.
  const registry = plugin.draftRegistry()
  registry.previews.set('ghost', 'набранный текст')

  const stock = miniStore({ ids: [], byId: {}, current: undefined, phase: 'pending' })
  const sessions = {
    list: stock,
    scope: () => undefined,
    create: async () => 'x',
    open: () => {},
    clear: () => {},
  }
  const conversation = { input: { for: () => { throw new Error('no binding') } } }
  const dispose = plugin.installDraftProjection({ sessions, conversation, fallbackTitle: () => 'New Session' })

  assert.equal(registry.previews.get('ghost'), 'набранный текст',
    'a pending list must not prune a restored preview')

  // The list lands with the ghost as a live draft: the preview becomes its row title.
  stock.set({
    ids: ['ghost'],
    byId: { ghost: { id: 'ghost', blank: true, cwd: '/w', updatedAt: 5 } },
    current: 'ghost',
    phase: 'ready',
  })
  assert.equal(stock.getSnapshot().byId.ghost.displayTitle, 'набранный текст')

  // Positive knowledge — the first send flips blank — is what prunes.
  stock.set({
    ids: ['ghost'],
    byId: { ghost: { id: 'ghost', blank: false, displayTitle: 'настоящий заголовок', updatedAt: 9 } },
    current: 'ghost',
    phase: 'ready',
  })
  assert.equal(registry.previews.has('ghost'), false)
  assert.equal(stock.getSnapshot().byId.ghost.displayTitle, 'настоящий заголовок')

  dispose()
})
