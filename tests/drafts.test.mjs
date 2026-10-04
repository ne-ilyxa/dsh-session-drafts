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
      // Plain draft under a workspace; the main-view-retained (current) one.
      a: { id: 'a', blank: true, cwd: '/home/x/sellprof', updatedAt: 500, retainedBy: { mainView: 1 } },
      // Real chat: must pass through untouched.
      b: { id: 'b', blank: false, cwd: '/home/x/sellprof', updatedAt: 400, displayTitle: 'sellprof' },
      // Subagent blank: stock hides subagent children — the overlay must too.
      c: { id: 'c', blank: true, updatedAt: 300, origin: 'subagent' },
      // Pinned draft: explicit rename wins over preview/fallback.
      d: { id: 'd', blank: true, cwd: '/home/x/realt', updatedAt: 200, title: 'Заметки', displayTitle: 'Заметки' },
    },
    phase: 'ready',
  }
}

// ---------------------------------------------------------------------------
// Bundle surface
// ---------------------------------------------------------------------------

test('bundle declares the runtime services it needs (no slots: stock tree renders drafts)', async () => {
  const plugin = await loadPlugin()
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['sessions', 'workspaces', 'conversation', 'locale', 'uiWorkspace'])
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

  // Plain draft: visible row, preview title on BOTH faces the tree reads —
  // `title` is the renderer's row label since the 0.2 refactor (`node.title
  // || t('session.untitled')`), `displayTitle` feeds archive-confirm/hover.
  assert.equal(out.byId.a.blank, false)
  assert.equal(out.byId.a.title, 'Рефакторинг парсера')
  assert.equal(out.byId.a.displayTitle, 'Рефакторинг парсера')
  // Pinned draft: explicit title wins.
  assert.equal(out.byId.d.blank, false)
  assert.equal(out.byId.d.title, 'Заметки')
  assert.equal(out.byId.d.displayTitle, 'Заметки')
  // Subagent blank untouched (stock hides it by design).
  assert.equal(out.byId.c.blank, true)
  assert.equal(out.byId.c.displayTitle, undefined)
  assert.equal(out.byId.c.title, undefined)
  // Real chat passes through BY REFERENCE (no churn for stock rows).
  assert.equal(out.byId.b, stock.byId.b)
  // Everything else rides the snapshot by reference.
  assert.equal(out.ids, stock.ids)
  assert.equal(out.phase, 'ready')
})

test('mainSessionIdOf reads main-view retention, falling back to the legacy current field', async () => {
  const plugin = await loadPlugin()
  // 0.2 face: the retained row wins regardless of its position.
  assert.equal(plugin.mainSessionIdOf(sessionsFixture()), 'a')
  const later = sessionsFixture()
  later.byId.a = { ...later.byId.a, retainedBy: {} }
  later.byId.d = { ...later.byId.d, retainedBy: { mainView: 2 } }
  assert.equal(plugin.mainSessionIdOf(later), 'd')
  assert.equal(plugin.mainSessionIdOf({ ids: ['b'], byId: {} }), undefined)
  // 0.1-era face: the snapshot's own current field.
  assert.equal(plugin.mainSessionIdOf({ ids: [], byId: {}, current: 'b' }), 'b')
})

test('projectDraftList falls back to the localized New Session and stays referentially stable', async () => {
  const plugin = await loadPlugin()
  const stock = sessionsFixture()
  const out = plugin.projectDraftList(stock, new Map(), 'New Session')
  assert.equal(out.byId.a.title, 'New Session')
  assert.equal(out.byId.a.displayTitle, 'New Session')

  // No projectable drafts at all: the STOCK reference comes back untouched —
  // getSnapshot stability between mutations is the uSES contract.
  const quiet = { ids: ['b'], byId: { b: stock.byId.b } }
  assert.equal(plugin.projectDraftList(quiet, new Map(), 'New Session'), quiet)
})

test('projectDraftList reads the 0.2 engaged semantics: host metadata decides', async () => {
  const plugin = await loadPlugin()
  // An ENGAGED session loses the client `blank` bit (retention + opening
  // flip it), but the host metadata keeps "no sent turn" — still a draft.
  const engaged = {
    ids: ['e', 'graduated', 'unknown'],
    byId: {
      e: { id: 'e', blank: false, cwd: '/w', updatedAt: 10,
        projectionValues: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
      // A real chat: the host saw a turn — never a draft.
      graduated: { id: 'graduated', blank: false, cwd: '/w', updatedAt: 9,
        title: 'Настоящий чат', displayTitle: 'Настоящий чат',
        projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 5 } } },
      // Engagement without metadata cannot be classified yet — not projected.
      unknown: { id: 'unknown', blank: false, cwd: '/w', updatedAt: 8 },
    },
  }
  const out = plugin.projectDraftList(engaged, new Map(), 'New Session')
  assert.equal(out.byId.e.blank, false)
  assert.equal(out.byId.e.title, 'New Session', 'the engaged empty draft is projected')
  assert.equal(out.byId.graduated, engaged.byId.graduated, 'a graduated chat passes through untouched')
  assert.equal(out.byId.unknown, engaged.byId.unknown, 'metadata-less engagement stays unprojected')
})

test('findReusableEmptyDraft reuses engaged empty drafts too', async () => {
  const plugin = await loadPlugin()
  const stock = {
    ids: ['engaged', 'graduated', 'occ'],
    byId: {
      engaged: { id: 'engaged', blank: false, cwd: '/w', updatedAt: 100,
        projectionValues: { sessionListMetadata: { blank: true } } },
      graduated: { id: 'graduated', blank: false, cwd: '/w', updatedAt: 90,
        projectionValues: { sessionListMetadata: { blank: false } } },
      occ: { id: 'occ', blank: false, cwd: '/w', updatedAt: 80,
        projectionValues: { sessionListMetadata: { blank: true } } },
    },
  }
  const list = { items: [{ workspaceId: 'w', path: '/w', sessionIds: ['engaged', 'graduated', 'occ'] }] }
  // The engaged empty draft is the jump target; the graduated chat never is;
  // the occupied engaged draft is skipped only when its preview is known.
  assert.equal(plugin.findReusableEmptyDraft(stock, list, new Map([['occ', 'текст']]), 'w')?.id, 'engaged')
  assert.equal(plugin.findReusableEmptyDraft(stock, list, new Map([['engaged', 'текст']]), 'w')?.id, 'occ')
  const both = new Map([['engaged', 'а'], ['occ', 'б']])
  assert.equal(plugin.findReusableEmptyDraft(stock, list, both, 'w'), undefined)
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

/** Shared patch fixtures: w1={a,b} @ /home/x/sellprof, w2={d} @ /home/x/realt. */
function patchFixtures() {
  return {
    workspacesList: {
      items: [
        { workspaceId: 'w1', path: '/home/x/sellprof', sessionIds: ['a', 'b'] },
        { workspaceId: 'w2', path: '/home/x/realt', sessionIds: ['d'] },
      ],
      archivedSessionIds: [],
    },
    sessionsList: sessionsFixture(),
  }
}

function makeServices(fixtures) {
  const created = []
  const stockCalls = []
  return {
    created, stockCalls,
    // The 0.2 mint-flow service: the patch seat is its connectWorkspace.
    uiWorkspace: {
      startSession(workspaceId) { stockCalls.push(workspaceId) },
      // The stock connect: reuse-scan (nothing — drafts carry no cwd match
      // here), then create with the production dedupe semantics.
      async connectWorkspace(workspaceId) {
        created.push({ workspaceId, via: 'stock-connect' })
        await Promise.resolve()
        return 'fresh-1'
      },
    },
    workspaces: {
      list: { getSnapshot: () => fixtures.workspacesList },
      archiveSession: async () => {},
    },
    sessions: {
      list: { getSnapshot: () => fixtures.sessionsList },
      create: async (opts) => {
        created.push(opts)
        // The adoption handshake resolves to the preallocated id; a fresh
        // mint mints a new one, like the host would.
        return opts.sessionId ?? 'fresh-1'
      },
    },
  }
}

test('installFreshSessions routes the empty-draft rule through uiWorkspace.connectWorkspace', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { uiWorkspace, workspaces, sessions, created } = makeServices(fixtures)

  const dispose = plugin.installFreshSessions({ workspaces, sessions, uiWorkspace })

  // Empty draft exists → the patched connect ADOPTS it through the stock
  // create handshake (create with the draft's id); the stock connect (and
  // its blank-respecting reuse) never runs. This is the seat the stock
  // startSession, the boot initial selection and the hero picker all call.
  assert.equal(await uiWorkspace.connectWorkspace('w1'), 'a',
    'patched connect resolves the existing empty draft')
  assert.deepEqual(plain(created), [{ workspaceId: 'w1', sessionId: 'a' }],
    'the adoption goes through session.create with the draft id')

  // An ENGAGED empty draft (opened, never prompted — blank:false on the 0.2
  // face) is resident: the patched connect returns its id directly, without
  // the create handshake.
  fixtures.sessionsList.byId.e = {
    id: 'e', blank: false, cwd: '/home/x/sellprof', updatedAt: 950,
    retainedBy: { mainView: 1 },
    projectionValues: { sessionListMetadata: { blank: true } },
  }
  fixtures.sessionsList.ids = ['e', ...fixtures.sessionsList.ids]
  fixtures.workspacesList.items[0] = {
    ...fixtures.workspacesList.items[0],
    sessionIds: ['e', ...fixtures.workspacesList.items[0].sessionIds],
  }
  created.length = 0
  assert.equal(await uiWorkspace.connectWorkspace('w1'), 'e')
  assert.deepEqual(created, [], 'a resident draft is returned without a create round-trip')
  delete fixtures.sessionsList.byId.e
  fixtures.sessionsList.ids = fixtures.sessionsList.ids.filter(id => id !== 'e')
  fixtures.workspacesList.items[0] = {
    ...fixtures.workspacesList.items[0],
    sessionIds: fixtures.workspacesList.items[0].sessionIds.filter(id => id !== 'e'),
  }

  // Occupied world → a FRESH mint (the stock method is replaced, not wrapped:
  // its scan would have reused the occupied blank regardless of typed text).
  const previews = plugin.draftRegistry().previews
  previews.set('a', 'текст')
  previews.set('e', 'текст')
  assert.equal(await uiWorkspace.connectWorkspace('w1'), 'fresh-1')
  assert.deepEqual(plain(created.at(-1)), { workspaceId: 'w1' })

  // Unknown workspace: nothing to reuse, and the host-shaped create refusal
  // propagates to the caller (openWorkspace turns it into the stock notice).
  sessions.create = async (opts) => {
    if (opts.workspaceId === 'w404') {
      const error = new Error('session create failed: workspace/unknown')
      error.rpcError = { code: 'workspace/unknown' }
      throw error
    }
    return opts.sessionId ?? 'fresh-1'
  }
  await assert.rejects(() => uiWorkspace.connectWorkspace('w404'), /workspace\/unknown/)

  dispose()
  // Dispose restores the stock connect.
  assert.equal(await uiWorkspace.connectWorkspace('w1'), 'fresh-1')
  assert.equal(created.at(-1).via, 'stock-connect')
})

test('installFreshSessions collapses a rapid double-click into ONE connect', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { uiWorkspace, workspaces, sessions, created } = makeServices(fixtures)
  plugin.draftRegistry().previews.set('a', 'черновик') // no empty draft anywhere

  const dispose = plugin.installFreshSessions({ workspaces, sessions, uiWorkspace })
  // Two connects in the SAME macrotask — both land while the first create is
  // still in flight; the patch's per-workspace in-flight map (the stock
  // connecting map lives inside the replaced method) must collapse them.
  const first = uiWorkspace.connectWorkspace('w1')
  const second = uiWorkspace.connectWorkspace('w1')
  assert.equal(await first, 'fresh-1')
  assert.equal(await second, 'fresh-1', 'the second click rides the in-flight promise')
  const mints = created.filter(call => call.via !== 'stock-connect')
  assert.equal(mints.length, 1, `double connect minted once, got ${JSON.stringify(created)}`)

  dispose()
})

test('installFreshSessions falls through a held writer to a fresh mint (adoption race)', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { uiWorkspace, workspaces, sessions, created } = makeServices(fixtures)
  // The stock refusal shape for a create whose preallocated id is held.
  sessions.create = async (opts) => {
    created.push(opts)
    if (opts.sessionId !== undefined) {
      const error = new Error('session create failed: session/writer-held: busy')
      error.rpcError = { code: 'session/writer-held' }
      throw error
    }
    return 'fresh-1'
  }

  const dispose = plugin.installFreshSessions({ workspaces, sessions, uiWorkspace })
  assert.equal(await uiWorkspace.connectWorkspace('w1'), 'fresh-1',
    'a writer-held adoption falls through to the fresh mint')
  assert.deepEqual(plain(created), [
    { workspaceId: 'w1', sessionId: 'a' },
    { workspaceId: 'w1' },
  ])

  // A NON-writer-held adoption failure propagates (no silent mint).
  created.length = 0
  sessions.create = async () => {
    created.push('boom')
    throw new Error('workspace/unknown')
  }
  plugin.draftRegistry().previews.clear()
  await assert.rejects(() => uiWorkspace.connectWorkspace('w1'), /workspace\/unknown/)
  assert.deepEqual(created, ['boom'])

  dispose()
})

test('installFreshSessions degrades loudly on a 0.1-era runtime (no uiWorkspace)', async () => {
  const plugin = await loadPlugin()
  const fixtures = patchFixtures()
  const { uiWorkspace, workspaces, sessions } = makeServices(fixtures)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    // Missing uiWorkspace: warn + a noop disposer (stock New Session stays).
    const legacyDispose = plugin.installFreshSessions({ workspaces, sessions })
    assert.equal(typeof legacyDispose, 'function')
    assert.match(warnings.join('\n'), /runtime shape unsupported/)
    legacyDispose()
    // Installing twice over the same instance is idempotent (HMR guard):
    // the second install adds no shadow and returns a noop disposer.
    const first = plugin.installFreshSessions({ workspaces, sessions, uiWorkspace })
    assert.equal(typeof first, 'function')
    assert.equal(typeof plugin.installFreshSessions({ workspaces, sessions, uiWorkspace }), 'function')
    first()
  } finally {
    console.warn = originalWarn
  }
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
  }
  const list = {
    items: [
      { workspaceId: 'w1', path: '/home/x/sellprof', sessionIds: ['e1', 'e2', 'occ', 'sub', 'arc', 'cwdx'] },
      { workspaceId: 'w2', path: '/home/x/realt', sessionIds: ['other'] },
    ],
    archivedSessionIds: ['arc'],
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
  }
  const conversation = { input: { for: scope => shells[scope.id] } }

  const dispose = plugin.installDraftProjection({ sessions, conversation, fallbackTitle: () => 'New Session' })

  // Stock flips: plain + pinned drafts become rows, subagent blank hidden.
  let view = stock.getSnapshot()
  assert.equal(view.byId.a.blank, false)
  assert.equal(view.byId.a.title, 'New Session')
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
  assert.equal(view.byId.a.title, 'Рефакторинг парсера')
  assert.equal(view.byId.a.displayTitle, 'Рефакторинг парсера')
  assert.equal(plugin.draftRegistry().previews.get('a'), 'Рефакторинг парсера')
  assert.equal(plugin.draftRegistry().titles.get('a'), 'Рефакторинг парсера')

  // Clearing the composer falls back to the New Session title.
  shellA.state.set({ draft: '   ' })
  view = stock.getSnapshot()
  assert.equal(view.byId.a.title, 'New Session')
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

  const stock = miniStore({ ids: [], byId: {}, phase: 'pending' })
  const sessions = {
    list: stock,
    scope: () => undefined,
    create: async () => 'x',
  }
  const conversation = { input: { for: () => { throw new Error('no binding') } } }
  const dispose = plugin.installDraftProjection({ sessions, conversation, fallbackTitle: () => 'New Session' })

  assert.equal(registry.previews.get('ghost'), 'набранный текст',
    'a pending list must not prune a restored preview')

  // The list lands with the ghost as a live draft: the preview becomes its row title.
  stock.set({
    ids: ['ghost'],
    byId: { ghost: { id: 'ghost', blank: true, cwd: '/w', updatedAt: 5, retainedBy: { mainView: 1 } } },
    phase: 'ready',
  })
  assert.equal(stock.getSnapshot().byId.ghost.title, 'набранный текст')

  // Positive knowledge — the first send flips blank — is what prunes.
  stock.set({
    ids: ['ghost'],
    byId: { ghost: { id: 'ghost', blank: false, title: 'настоящий заголовок', displayTitle: 'настоящий заголовок', updatedAt: 9 } },
    phase: 'ready',
  })
  assert.equal(registry.previews.has('ghost'), false)
  assert.equal(stock.getSnapshot().byId.ghost.title, 'настоящий заголовок')

  dispose()
})
