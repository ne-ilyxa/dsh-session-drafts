import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** Load the wrapped browser bundle in a VM with mocked externals; returns its exports. */
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
          plugin = record.factory(id => {
            if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('fragment') }
            if (id === 'react') {
              return {
                useCallback: value => value,
                useEffect() { throw new Error('component was mounted during registration') },
                useLayoutEffect() { throw new Error('component was mounted during registration') },
                useRef() { throw new Error('component was mounted during registration') },
                useState() { throw new Error('component was mounted during registration') },
              }
            }
            if (id === 'react-dom') return { createPortal: value => value }
            if (id === '@deepseek-ai/dsh-client-ui-primitives') {
              return {
                IconNewChatOutline16() {},
                IconCloseOutline16() {},
                IconPlusOutline16() {},
              }
            }
            throw new Error(`unexpected browser dependency ${id}`)
          })
        },
      },
    },
  }
  vm.runInNewContext(source, context)
  assert.ok(plugin, 'bundle registered with window.__ModuleLoader__.load')
  return plugin
}

function sessionsFixture() {
  return {
    ids: ['a', 'b', 'c', 'd', 'e'],
    byId: {
      a: { id: 'a', blank: true, cwd: '/home/x/sellprof', updatedAt: 500, },
      b: { id: 'b', blank: false, cwd: '/home/x/sellprof', updatedAt: 400 },
      c: { id: 'c', blank: true, updatedAt: 300, origin: 'subagent' },
      d: { id: 'd', blank: true, cwd: '/home/x/realt', updatedAt: 200 },
      e: { id: 'e', blank: true, cwd: '/home/x/gone', updatedAt: 100 },
    },
    current: 'a',
  }
}

function workspacesFixture() {
  return {
    items: [
      {
        workspaceId: 'w1',
        path: '/home/x/sellprof',
        title: 'Sellprof Analytics',
        sessionIds: ['a', 'b'],
      },
      {
        workspaceId: 'w2',
        path: '/home/x/realt',
        sessionIds: ['d'],
      },
    ],
    archivedSessionIds: ['e'],
    recentWorkspaceId: 'w1',
  }
}

test('bundle declares the runtime services it needs', async () => {
  const plugin = await loadPlugin()
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['slots', 'sessions', 'workspaces', 'locale', 'conversation'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.DraftsFooterAction, 'function')
})

/** Re-encode a VM-realm value into the host realm for strict deepEqual. */
const plain = value => JSON.parse(JSON.stringify(value))

test('selectDraftRows keeps blank non-subagent drafts, labels them, sorts newest-first', async () => {
  const plugin = await loadPlugin()
  const rows = plain(plugin.selectDraftRows(sessionsFixture(), workspacesFixture()))
  assert.deepEqual(rows.map(row => row.id), ['a', 'd'])
  assert.equal(rows[0].label, 'Sellprof Analytics')
  assert.equal(rows[0].current, true)
  assert.equal(rows[1].label, 'realt')
  assert.equal(rows[1].current, false)
})

test('selectDraftRows falls back to cwd basename and the ungrouped label', async () => {
  const plugin = await loadPlugin()
  const sessions = {
    ids: ['x', 'y'],
    byId: {
      x: { id: 'x', blank: true, cwd: '/home/x/untitled-project', updatedAt: 2 },
      y: { id: 'y', blank: true, updatedAt: 1 },
    },
    current: undefined,
  }
  const rows = plain(plugin.selectDraftRows(sessions, { items: [], archivedSessionIds: [], recentWorkspaceId: undefined }))
  assert.deepEqual(rows.map(row => row.label), ['untitled-project', 'Ungrouped'])
})

test('workspaceBaseLabel handles separators, trailing slashes, and empty paths', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.workspaceBaseLabel('/home/x/sellprof'), 'sellprof')
  assert.equal(plugin.workspaceBaseLabel('C:\\repo\\go\\sellprof'), 'sellprof')
  assert.equal(plugin.workspaceBaseLabel('/home/x/dir/'), 'dir')
  assert.equal(plugin.workspaceBaseLabel(''), 'Ungrouped')
  assert.equal(plugin.workspaceBaseLabel(undefined), 'Ungrouped')
})

test('draftAge buckets relative time', async () => {
  const plugin = await loadPlugin()
  const now = 10_000_000
  assert.deepEqual(plain(plugin.draftAge(now - 30_000, now)), { key: 'now', n: 0 })
  assert.deepEqual(plain(plugin.draftAge(now - 5 * 60_000, now)), { key: 'min', n: 5 })
  assert.deepEqual(plain(plugin.draftAge(now - 3 * 3_600_000, now)), { key: 'hour', n: 3 })
  assert.deepEqual(plain(plugin.draftAge(now - 2 * 86_400_000, now)), { key: 'day', n: 2 })
})

test('matchDraftsHotkey matches physical codes (layout-independent) and guards AltGraph', async () => {
  const plugin = await loadPlugin()
  const ev = (key, over = {}) => ({
    key, code: undefined, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over,
  })
  // English layout: both code and key agree.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN' })), 'new')
  assert.equal(plugin.matchDraftsHotkey(ev('d', { ctrlKey: true, altKey: true, code: 'KeyD' })), 'toggle')
  // Russian layout: event.key is 'т' for the physical N key — the code wins.
  assert.equal(plugin.matchDraftsHotkey(ev('т', { ctrlKey: true, altKey: true, code: 'KeyN' })), 'new')
  assert.equal(plugin.matchDraftsHotkey(ev('в', { ctrlKey: true, altKey: true, code: 'KeyD' })), 'toggle')
  // No code (old engine): layout-dependent key falls back.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true })), 'new')
  assert.equal(plugin.matchDraftsHotkey(ev('D', { ctrlKey: true, altKey: true })), 'toggle')
  // AltGraph is a typing modifier on European layouts (rides Ctrl+Alt) — never ours.
  assert.equal(plugin.matchDraftsHotkey(ev('q', {
    ctrlKey: true, altKey: true, code: 'KeyQ', getModifierState: () => true,
  })), null)
  // An open IME composition is skipped; the legacy 229-alone signal is NOT
  // (Linux IBus stamps every keydown of a switched layout with it).
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', isComposing: true })), null)
  // Not ours: single modifiers, extra modifiers, other keys.
  assert.equal(plugin.matchDraftsHotkey(ev('n', { altKey: true, code: 'KeyN' })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('d', { ctrlKey: true, code: 'KeyD' })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', shiftKey: true })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('n', { ctrlKey: true, altKey: true, code: 'KeyN', metaKey: true })), null)
  assert.equal(plugin.matchDraftsHotkey(ev('q', { ctrlKey: true, altKey: true, code: 'KeyQ' })), null)
})

test('draftPreview collapses whitespace and caps length', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.draftPreview(''), undefined)
  assert.equal(plugin.draftPreview('   \n\t  '), undefined)
  assert.equal(plugin.draftPreview('  Рефакторинг\n  парсера  '), 'Рефакторинг парсера')
  assert.equal(plugin.draftPreview('a'.repeat(60)), 'a'.repeat(60))
  assert.equal(plugin.draftPreview('a'.repeat(61)), `${'a'.repeat(60)}…`)
  assert.equal(plugin.draftPreview(`b`.repeat(100), 10), 'bbbbbbbbbb…')
})

test('installFreshSessions patches startSession to always create a fresh session', async () => {
  const plugin = await loadPlugin()
  const created = []
  const opened = []
  const cleared = []
  const stockCalls = []
  const workspaces = {
    list: { getSnapshot: () => workspacesFixture() },
    startSession(workspaceId) { stockCalls.push(workspaceId) },
    archiveSession: async () => {},
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
  workspaces.startSession()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(plain(created).length, 1)
  assert.equal(plain(created)[0]?.workspaceId, 'w1')
  assert.deepEqual(plain(opened), ['fresh-1'])

  // Explicit workspace targeting is preserved.
  created.length = 0
  workspaces.startSession('w2')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(plain(created).length, 1)
  assert.equal(plain(created)[0]?.workspaceId, 'w2')

  // Dispose restores the stock method.
  dispose()
  assert.equal(stockCalls.length, 0)
  workspaces.startSession('w9')
  assert.deepEqual(stockCalls, ['w9'])
  assert.equal(created.length, 1, 'create not called after restore')
})

test('installFreshSessions falls back to the recent workspace and clear() with none', async () => {
  const plugin = await loadPlugin()
  const created = []
  const cleared = []
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [],
        archivedSessionIds: [],
        recentWorkspaceId: 'rec',
      }),
    },
    startSession() { throw new Error('stock must not run') },
    archiveSession: async () => {},
  }
  const sessions = {
    list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) },
    create: async opts => {
      created.push(opts)
      return 'fresh'
    },
    open() {},
    clear() { cleared.push(true) },
  }
  const dispose = plugin.installFreshSessions({ workspaces, sessions })

  // No current session: recent workspace wins.
  workspaces.startSession()
  assert.equal(plain(created).length, 1)
  assert.equal(plain(created)[0]?.workspaceId, 'rec')

  dispose()
})

test('installFreshSessions is idempotent and skips unsupported runtimes', async () => {
  const plugin = await loadPlugin()
  const workspaces = {
    list: { getSnapshot: () => ({ items: [], archivedSessionIds: [], recentWorkspaceId: undefined }) },
    startSession() {},
    archiveSession: async () => {},
  }
  const sessions = {
    list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) },
    create: async () => 'x',
    open() {},
    clear() {},
  }
  const disposeA = plugin.installFreshSessions({ workspaces, sessions })
  const disposeB = plugin.installFreshSessions({ workspaces, sessions })
  disposeB() // second install was a no-op; its disposer must not strip A's patch
  workspaces.startSession()
  assert.equal(workspaces.startSession.name, 'patched')
  disposeA()

  const bare = { list: { getSnapshot: () => ({}) }, startSession() {} }
  const inertSessions = { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) } }
  const disposeC = plugin.installFreshSessions({ workspaces: bare, sessions: inertSessions })
  assert.equal(bare.startSession.name, 'startSession')
  disposeC()
})
