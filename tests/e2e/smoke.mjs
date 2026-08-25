// E2E smoke: Cursor-style drafts AS TREE ROWS on an isolated DSH instance.
//
// Boots a throwaway DSH web host (its own DSH_HOME, a scratch profile with
// this checkout installed via `dsh plugin add link:`), drives the real web UI
// in headless Chrome, and asserts both the host-side session truth and the
// sidebar tree DOM. Self-cleaning.
//
// Covers the v0.2 contract:
//   - every New Session click (button / folder ＋ / Ctrl+Alt+N) mints a fresh
//     durable draft; drafts render as ordinary tree rows (marked, gray,
//     "New Session" title, creation-time cell) — no popover anywhere;
//   - typing in a draft updates its row title live (unsent-text preview) and
//     survives a page reload (localStorage mirror; sessions survive the host);
//   - the stock row menu archives (= discards) a draft.
//
// Requirements (skipped with exit 0 when unset — CI runs only unit tests):
//   E2E_DSH_ROOT  path to a deepseek-harness checkout (default: /home/ilya/deepseek-harness)
//   CHROME_PATH   path to a Chrome/Chromium binary
//   E2E_PORT      listen port for the scratch instance (default 3987)
//
// Run: pnpm test:e2e
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO_ROOT = new URL('../..', import.meta.url).pathname
const DSH_ROOT = process.env.E2E_DSH_ROOT ?? '/home/ilya/deepseek-harness'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const PORT = Number(process.env.E2E_PORT ?? 3987)
const BASE = `http://127.0.0.1:${PORT}`

if (!existsSync(join(DSH_ROOT, 'package.json'))) {
  console.log('[e2e] skip: E2E_DSH_ROOT does not exist —', DSH_ROOT)
  process.exit(0)
}
if (!existsSync(CHROME)) {
  console.log('[e2e] skip: no Chrome at CHROME_PATH —', CHROME)
  process.exit(0)
}

const { default: puppeteer } = await import('puppeteer-core')
const log = (...a) => console.log('[e2e]', ...a)
let home = null
let host = null

const dsh = (args, env) => spawnSync('pnpm', ['dsh', ...args], {
  cwd: DSH_ROOT,
  env: { ...process.env, ...env },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

function fail(message) {
  console.error('[e2e] FAIL:', message)
  process.exitCode = 1
}

try {
  home = await mkdtemp(join(tmpdir(), 'dsh-drafts-e2e-'))
  const env = { DSH_HOME: home }

  // 1. Install this checkout into the scratch profile.
  const add = dsh(['plugin', '--profile', 'web', 'add', `link:${REPO_ROOT}`], env)
  if (add.status !== 0) {
    // pnpm ≥10 blocks the prepare build of a link: dependency unless allowed.
    const yaml = join(home, 'profiles/web/pnpm-workspace.yaml')
    if (add.stderr.includes('allowBuilds') && existsSync(yaml)) {
      const { appendFileSync } = await import('node:fs')
      const key = /("@ne-ilyxa\/dsh-session-drafts@\S+)"/u.exec(add.stderr)?.[1]
        ?? '"@ne-ilyxa/dsh-session-drafts"'
      appendFileSync(yaml, `allowBuilds:\n  ${key}: true\n`)
      log('allowlisted prepare build, retrying install')
      const retry = dsh(['plugin', '--profile', 'web', 'add', `link:${REPO_ROOT}`], env)
      if (retry.status !== 0) throw new Error(`plugin add failed:\n${retry.stderr}`)
    } else {
      throw new Error(`plugin add failed:\n${add.stderr}`)
    }
  }

  // 2. Boot the scratch host. stdio ignore: a pipe nobody drains fills its
  // 64KB buffer and silently wedges the host mid-boot. detached: own process
  // group, so teardown kills the whole tree (pnpm -> dsh -> server).
  host = spawn('pnpm', ['dsh', 'web', '--no-open', '--port', String(PORT)], {
    cwd: DSH_ROOT,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: true,
  })
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(500)
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
      up = res.ok
    } catch { /* not yet */ }
  }
  if (!up) throw new Error('scratch DSH host did not come up')

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  })
  try {
    const page = await browser.newPage()
    const problems = []
    page.on('pageerror', e => problems.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') problems.push(m.text()) })

    const rpc = (method, payload) => page.evaluate(async ({ method, payload }) => {
      const res = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `r${Math.random()}`, method, payload }),
      })
      return res.ok ? await res.json().catch(() => null) : null
    }, { method, payload })
    const hostBlanks = async () => {
      const r = await rpc('session.list', {})
      return (r?.result?.value?.items ?? []).filter(s => s.blank).length
    }

    // Native clicks only: CDP coordinate clicks never reach the sidebar
    // (overlay interception) — the honest path is element.click() in page.
    const clickNewSession = () => page.evaluate(() => {
      const btns = [...document.querySelectorAll('button[aria-label="New session"]')]
      btns[btns.length - 1]?.click()
    })
    const draftRows = () => page.evaluate(() =>
      [...document.querySelectorAll('[role="treeitem"].dsd-draft-row')].map(row => ({
        text: row.textContent ?? '',
        selected: row.getAttribute('aria-selected') === 'true',
      })))
    const typeDraft = text => page.evaluate(t => {
      const area = document.querySelector('textarea[data-phase]')
      if (area === null) throw new Error('no composer textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      area.focus()
      setter?.call(area, t)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }, text)

    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 })
    await sleep(2500)
    const ws = await rpc('workspace.create', { path: tmpdir() })
    if (ws?.result?.ok !== true) fail('workspace.create failed')
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(3000)

    // The v0.1 popover is gone entirely: no footer trigger, no panel.
    const legacy = await page.evaluate(() => ({
      trigger: document.querySelector('.dsd-trigger') !== null,
      panel: document.querySelector('.dsd-panel') !== null,
      rows: document.querySelectorAll('.dsd-row').length,
    }))
    if (legacy.trigger || legacy.panel || legacy.rows > 0) {
      fail(`v0.1 popover leaked: ${JSON.stringify(legacy)}`)
    }

    // --- Settle: one click guarantees an EMPTY draft exists and is current
    // (mint on a cold profile, jump on a warm one). `base` counts host-side
    // blank sessions — note the host flag means "no message SENT": typing
    // unsent text does NOT flip it, so blanks grow only on real mints.
    await clickNewSession(); await sleep(1500)
    const base = await hostBlanks()
    if (base < 1) fail('no draft after the first New Session click')
    let rows = await draftRows()
    log(`base: host blanks=${base}, draft rows=${rows.length}`)
    if (rows.length !== base) fail(`tree shows ${rows.length} draft rows, expected ${base}`)
    if (!rows.every(r => r.text.startsWith('New Session'))) fail('empty draft row title is not "New Session"')
    // Creation-time cell: the row carries a trailing time label after the title.
    if (!rows.some(r => r.text.length > 'New Session'.length)) fail('draft row missing creation-time label')
    if (rows.filter(r => r.selected).length !== 1) fail('exactly one draft row must be selected')

    // --- Empty-draft jump: with an empty draft already there, the click must
    // NOT mint — it lands on the empty placeholder.
    await clickNewSession(); await sleep(1300)
    if ((await hostBlanks()) !== base) fail('click minted while an EMPTY draft existed (reuse failed)')
    rows = await draftRows()
    if (rows.length !== base) fail(`draft rows after reuse jump: ${rows.length}, expected ${base}`)
    if (rows.filter(r => r.selected).length !== 1) fail('selection lost after the reuse jump')

    // --- Live preview: typing in the current draft retitles its row AND
    // occupies it.
    const typed = 'preview-e2e Рефакторинг парсера'
    await typeDraft(typed)
    await sleep(800)
    rows = await draftRows()
    const previewRow = rows.find(r => r.text.includes('Рефакторинг'))
    if (previewRow === undefined) fail(`draft preview missing in tree; rows=${JSON.stringify(rows)}`)
    else if (!previewRow.selected) fail('preview retitled the wrong (non-current) row')
    else log('live preview row:', previewRow.text)

    // --- Occupied: the click now MINTS a fresh empty draft (no infinite
    // empties, no swallowed drafts). A RAPID DOUBLE click must collapse into
    // ONE mint — the stock connect's in-flight dedupe map, preserved by the
    // patch routing the mint path through it.
    await clickNewSession(); await clickNewSession(); await sleep(1800)
    let blanks = await hostBlanks()
    if (blanks !== base + 1) fail(`expected exactly one mint after occupation (double click), got ${base} -> ${blanks}`)
    rows = await draftRows()
    if (rows.length !== base + 1) fail(`draft rows after mint: ${rows.length}, expected ${base + 1}`)
    const occupied = rows.filter(r => r.text.includes('Рефакторинг'))
    if (occupied.length !== 1) fail('the occupied draft did not stay in the tree')
    if (occupied[0].selected) fail('the minted empty draft is not the selected one')

    // --- The fresh draft is empty again: one more click jumps, no mint.
    await clickNewSession(); await sleep(1300)
    if ((await hostBlanks()) !== base + 1) fail('click minted while the fresh EMPTY draft existed')

    // --- Reload: drafts persist host-side, the preview persists via the
    // localStorage mirror, and the current (empty) draft is restored.
    const storedBefore = await page.evaluate(() =>
      localStorage.getItem('dsh.plugin.session-drafts.previews'))
    log('stored previews BEFORE reload:', storedBefore)
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(3500)
    const storedAfter = await page.evaluate(() =>
      localStorage.getItem('dsh.plugin.session-drafts.previews'))
    log('stored previews AFTER reload:', storedAfter)
    blanks = await hostBlanks()
    rows = await draftRows()
    log(`after reload: host blanks=${blanks}, draft rows=${rows.length}`)
    if (blanks !== base + 1) fail(`drafts did not survive reload host-side (${blanks})`)
    if (rows.length !== base + 1) fail(`draft rows after reload: ${rows.length}, expected ${base + 1}`)
    if (!rows.some(r => r.text.includes('Рефакторинг'))) {
      fail(`preview did not survive reload; rows=${JSON.stringify(rows)}`)
    }

    // --- Folder ＋: the restored current draft is the empty one, so occupy
    // it first — then the folder ＋ (same workspace) must mint. Hover styles
    // hide the ＋ until row hover, but a native click still dispatches.
    await typeDraft('folder-occupy'); await sleep(700)
    await page.evaluate(() => {
      document.querySelector('button[aria-label^="New session in"]')?.click()
    })
    await sleep(1600)
    if ((await hostBlanks()) !== base + 2) fail('folder ＋ did not mint after occupation')
    if ((await draftRows()).length !== base + 2) fail('folder-minted draft not visible in tree')

    // --- Hotkey: occupy the fresh draft, then Ctrl+Alt+N mints. First
    // install the worst-case environment that killed bubble-phase listeners
    // in the wild: a document-capture guard that stopPropagation()s
    // unconditionally (dsh-better-sidebar's IME guard does exactly this
    // under Linux IBus).
    await typeDraft('hotkey-occupy'); await sleep(700)
    await page.evaluate(() => {
      const guard = event => { event.stopPropagation() }
      document.addEventListener('keydown', guard, true)
      document.addEventListener('keyup', guard, true)
    })
    await page.keyboard.down('Control'); await page.keyboard.down('Alt')
    await page.keyboard.press('KeyN')
    await page.keyboard.up('Alt'); await page.keyboard.up('Control')
    await sleep(1800)
    if ((await hostBlanks()) !== base + 3) fail('Ctrl+Alt+N did not mint after occupation')
    // With the minted draft empty, the SAME hotkey jumps — no mint.
    await page.keyboard.down('Control'); await page.keyboard.down('Alt')
    await page.keyboard.press('KeyN')
    await page.keyboard.up('Alt'); await page.keyboard.up('Control')
    await sleep(1500)
    if ((await hostBlanks()) !== base + 3) fail('Ctrl+Alt+N minted while an EMPTY draft existed')
    if ((await draftRows()).length !== base + 3) fail('hotkey drafts not visible in tree')

    // --- Draft affordance: NO ⋯ menu (Rename/Fork/Archive are chat verbs —
    // a draft is a placeholder); the only trailing control is the × discard
    // button, riding the same hover cell at the ⋯'s metrics.
    const affordance = await page.evaluate(() =>
      [...document.querySelectorAll('[role="treeitem"].dsd-draft-row')].map(row => {
        const ell = row.querySelector('button[aria-label^="Session actions for"]')
        return {
          menuHidden: ell === null || getComputedStyle(ell).display === 'none',
          hasX: row.querySelector('button[data-dsd-discard]') !== null,
        }
      }))
    log('draft affordance:', JSON.stringify(affordance))
    if (affordance.length === 0 || !affordance.every(a => a.menuHidden)) {
      fail('draft rows still expose the stock ⋯ menu')
    }
    if (!affordance.every(a => a.hasX)) fail('draft rows missing the × discard button')

    // --- Inverse pin (the C2 class): workspace header rows are treeitems
    // with their own ⋯ (Rename/Delete) — they must NEVER carry the draft
    // treatment, even when their label prefixes a draft preview.
    const headers = await page.evaluate(() =>
      [...document.querySelectorAll('[role="treeitem"][aria-expanded]')].map(row => ({
        text: row.textContent ?? '',
        tinted: row.classList.contains('dsd-draft-row'),
        muted: row.querySelector('button[data-dsd-muted]') !== null,
        strayX: row.querySelector('button[data-dsd-discard]') !== null,
      })))
    log('workspace headers:', JSON.stringify(headers))
    if (headers.length === 0) fail('no workspace header rows found for the inverse check')
    if (headers.some(h => h.tinted || h.muted || h.strayX)) {
      fail(`draft treatment leaked onto a workspace header: ${JSON.stringify(headers)}`)
    }

    // --- × discards the preview draft. Note: archived sessions STAY in
    // session.list host-side (the archive is a registry-global hide set; the
    // accounting slot remains), so the honest postcondition is the row
    // disappearing from the tree.
    const discarded = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="treeitem"].dsd-draft-row')]
        .find(r => (r.textContent ?? '').includes('Рефакторинг'))
      if (row === undefined) return 'row not found'
      const x = row.querySelector('button[data-dsd-discard]')
      if (x === null) return '× button not found'
      x.click()
      return 'clicked'
    })
    await sleep(1500)
    if (discarded !== 'clicked') fail(`discard: ${discarded}`)
    else if ((await draftRows()).length !== base + 2) fail('discarded draft row still rendered')
    else if (!(await draftRows()).every(r => !r.text.includes('Рефакторинг'))) fail('preview draft row survived discard')
    else log('× discarded the preview draft; tree rows back to', base + 2)

    // --- Host restart: drafts are durable host-side — the whole point of
    // the model — so a full DSH server restart must not lose one.
    const beforeRestart = await draftRows()
    try { process.kill(-host.pid, 'SIGTERM') } catch { /* group already gone */ }
    await sleep(2000)
    host = spawn('pnpm', ['dsh', 'web', '--no-open', '--port', String(PORT)], {
      cwd: DSH_ROOT,
      env: { ...process.env, DSH_HOME: home },
      stdio: 'ignore',
      detached: true,
    })
    let restarted = false
    for (let i = 0; i < 40 && !restarted; i++) {
      await sleep(500)
      try {
        const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
        restarted = res.ok
      } catch { /* not yet */ }
    }
    if (!restarted) fail('scratch host did not come back up after restart')
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(3500)
    // The old page's socket/chunk errors during the kill+restart window are
    // transient by construction; only console output from the SETTLED
    // restarted page counts for the final check.
    const settledAt = problems.length
    const afterRestart = await draftRows()
    log(`after host restart: draft rows ${beforeRestart.length} -> ${afterRestart.length}`,
      JSON.stringify(afterRestart))
    if (afterRestart.length !== beforeRestart.length) {
      fail(`drafts did not survive a host restart (${beforeRestart.length} -> ${afterRestart.length})`)
    }
    for (const marker of ['folder-occupy', 'hotkey-occupy']) {
      if (!afterRestart.some(r => r.text.includes(marker))) {
        fail(`occupied draft "${marker}" lost its preview across the host restart`)
      }
    }

    const relevant = problems.slice(settledAt).filter(l => !l.includes('favicon'))
    if (relevant.length > 0) { fail(`console problems: ${relevant.slice(0, 3).join(' | ')}`) }
    if (process.exitCode !== 1) log('RESULT: PASS')
  } finally {
    await browser.close()
  }
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  if (host !== null && host.exitCode === null) {
    try { process.kill(-host.pid, 'SIGTERM') } catch { /* group already gone */ }
  }
  if (home !== null) await rm(home, { recursive: true, force: true }).catch(() => {})
}
