// E2E smoke: full Cursor-style drafts flow on an isolated DSH instance.
//
// Boots a throwaway DSH web host (its own DSH_HOME, a scratch profile with
// this checkout installed via `dsh plugin add link:`), drives the real web UI
// in headless Chrome, and asserts the host-side session truth. Self-cleaning.
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
      const { appendFileSync, readFileSync } = await import('node:fs')
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
  // group, so teardown kills the whole tree (pnpm -> dsh -> server), not just
  // the pnpm wrapper.
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
    const widget = () => page.evaluate(() => ({
      trigger: document.querySelector('.dsd-trigger') !== null,
      count: document.querySelector('.dsd-trigger .dsd-count')?.textContent ?? null,
      panel: document.querySelector('.dsd-panel') !== null,
      rows: document.querySelectorAll('.dsd-row').length,
      current: document.querySelectorAll('.dsd-row.dsd-current').length,
      newBtn: document.querySelector('.dsd-panel .dsd-new') !== null,
    }))
    const clickNewSession = () => page.evaluate(() => {
      const btns = [...document.querySelectorAll('button[aria-label="New session"]')]
      btns[btns.length - 1]?.click()
    })
    const clickSelector = sel => page.evaluate(s => {
      const el = document.querySelector(s)
      el?.click()
      return el !== null
    }, sel)

    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 })
    await sleep(2500)
    const ws = await rpc('workspace.create', { path: tmpdir() })
    if (ws?.result?.ok !== true) fail('workspace.create failed')
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(3000)

    // Three New Session clicks -> three independent durable drafts (no reuse).
    const before = await hostBlanks()
    for (let i = 0; i < 3; i++) { await clickNewSession(); await sleep(1500) }
    const after = await hostBlanks()
    log(`host blank sessions: ${before} -> ${after}`)
    if (after !== before + 3) fail(`expected +3 durable drafts, got ${before} -> ${after}`)

    // Popover lists them; the footer mints another draft.
    await clickSelector('.dsd-trigger'); await sleep(700)
    const w = await widget()
    log('popover:', JSON.stringify(w))
    if (w.rows < 3) fail(`popover shows ${w.rows} rows, expected >= 3`)

    await page.evaluate(() => { [...document.querySelectorAll('.dsd-row')].pop()?.click() })
    await sleep(1200)
    await clickSelector('.dsd-trigger'); await sleep(700)
    const lastIsCurrent = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.dsd-row')]
      return rows.length > 0 && rows.at(-1).classList.contains('dsd-current')
    })
    if (!lastIsCurrent) fail('switching drafts did not move the current marker')

    // Draft preview: inject unsent text through React's native setter (the
    // app's focus management deflects CDP typing, so this is the honest path
    // to a real machine draft), switch to another draft, read the row.
    const typed = 'preview-e2e Рефакторинг парсера'
    await page.evaluate(text => {
      const t = document.querySelector('textarea[data-phase]')
      if (t === null) throw new Error('no composer textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      t.focus()
      setter?.call(t, text)
      t.dispatchEvent(new Event('input', { bubbles: true }))
    }, typed)
    await sleep(600)
    await page.evaluate(() => { [...document.querySelectorAll('.dsd-row')].at(-2)?.click() })
    await sleep(1200)
    await clickSelector('.dsd-trigger'); await sleep(800)
    const previews = await page.evaluate(() =>
      [...document.querySelectorAll('.dsd-row .dsd-rowPreview')].map(e => e.textContent ?? ''))
    if (!previews.some(p => p.includes('Рефакторинг'))) {
      fail(`draft preview missing; previews=${JSON.stringify(previews)}`)
    }
    // Close the popover (click the row we came from is done; ensure closed).
    if ((await widget()).panel) { await clickSelector('.dsd-trigger'); await sleep(500) }

    // Hotkeys: Ctrl+Alt+N mints a draft (puppeteer sends physical codes,
    // which is what the layout-independent matcher reads). Before that,
    // install a worst-case reproduction of the environment that killed the
    // bubble-phase listener in the wild: a document-capture guard that
    // stopPropagation()s unconditionally (dsh-better-sidebar's IME guard
    // does exactly this under Linux IBus, where every keydown carries
    // keyCode 229). The window-capture listener must still see the event.
    await page.evaluate(() => {
      const guard = event => { event.stopPropagation() }
      document.addEventListener('keydown', guard, true)
      document.addEventListener('keyup', guard, true)
    })
    const beforeHotkey = await hostBlanks()
    await page.keyboard.down('Control'); await page.keyboard.down('Alt')
    await page.keyboard.press('KeyN')
    await page.keyboard.up('Alt'); await page.keyboard.up('Control')
    await sleep(2000)
    if (await hostBlanks() !== beforeHotkey + 1) fail('Ctrl+Alt+N did not mint a draft')
    // Ctrl+Alt+D toggles the popover open.
    await page.keyboard.down('Control'); await page.keyboard.down('Alt')
    await page.keyboard.press('KeyD')
    await page.keyboard.up('Alt'); await page.keyboard.up('Control')
    await sleep(800)
    if (!(await widget()).panel) fail('Ctrl+Alt+D did not open the popover')
    await page.keyboard.down('Control'); await page.keyboard.down('Alt')
    await page.keyboard.press('KeyD')
    await page.keyboard.up('Alt'); await page.keyboard.up('Control')
    await sleep(600)


    if (!(await widget()).panel) { await clickSelector('.dsd-trigger'); await sleep(600) }
    const viaPanel = await clickSelector('.dsd-panel .dsd-new')
    await sleep(1800)
    if (!viaPanel) fail('panel footer New Session missing')
    log('host blanks after panel new:', await hostBlanks())

    const relevant = problems.filter(l => !l.includes('favicon'))
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
