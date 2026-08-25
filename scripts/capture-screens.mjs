// Capture the README screenshots against a real, isolated DSH instance.
//
// Boots a throwaway DSH web host (own DSH_HOME, this checkout installed via
// `dsh plugin add link:`), drives the real UI in headless Chrome into a
// representative drafts state, and shoots the sidebar:
//
//   assets/drafts-tree.png    two drafts as tree rows — the current empty one
//                             ("New Session", pencil mark, creation time) and
//                             an occupied one retitled to its live unsent-text
//                             preview
//   assets/draft-discard.png  the same list with a row hovered: the × discard
//                             button revealed in the trailing cell (where
//                             ordinary chats show their ⋯ menu)
//
// Requirements mirror tests/e2e/smoke.mjs (E2E_DSH_ROOT, CHROME_PATH, PORT).
// Run: node scripts/capture-screens.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const DSH_ROOT = process.env.E2E_DSH_ROOT ?? '/home/ilya/deepseek-harness'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const PORT = Number(process.env.PORT ?? 3991)
const BASE = `http://127.0.0.1:${PORT}`

if (!existsSync(join(DSH_ROOT, 'package.json')) || !existsSync(CHROME)) {
  console.error('[shots] needs E2E_DSH_ROOT and CHROME_PATH (see the file header)')
  process.exit(1)
}

const { default: puppeteer } = await import('puppeteer-core')
const log = (...a) => console.log('[shots]', ...a)
let home = null
let host = null

const dsh = (args, env) => spawnSync('pnpm', ['dsh', ...args], {
  cwd: DSH_ROOT,
  env: { ...process.env, ...env },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

try {
  home = await mkdtemp(join(tmpdir(), 'dsh-drafts-shots-'))
  const env = { DSH_HOME: home }

  const add = dsh(['plugin', '--profile', 'web', 'add', `link:${REPO_ROOT}`], env)
  if (add.status !== 0) {
    const yaml = join(home, 'profiles/web/pnpm-workspace.yaml')
    if (add.stderr.includes('allowBuilds') && existsSync(yaml)) {
      const { appendFileSync } = await import('node:fs')
      const key = /("@ne-ilyxa\/dsh-session-drafts@\S+)"/u.exec(add.stderr)?.[1]
        ?? '"@ne-ilyxa/dsh-session-drafts"'
      appendFileSync(yaml, `allowBuilds:\n  ${key}: true\n`)
      const retry = dsh(['plugin', '--profile', 'web', 'add', `link:${REPO_ROOT}`], env)
      if (retry.status !== 0) throw new Error(`plugin add failed:\n${retry.stderr}`)
    } else {
      throw new Error(`plugin add failed:\n${add.stderr}`)
    }
  }

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
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  })
  try {
    const page = await browser.newPage()
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 })
    await sleep(2500)

    // A workspace with a realistic folder name, then two drafts: the first
    // gets unsent text (its row retitles to the live preview), the second
    // stays empty and current ("New Session").
    const project = join(home, 'sellprof')
    await mkdir(project, { recursive: true })
    const rpc = (method, payload) => page.evaluate(async ({ method, payload }) => {
      const res = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `r${Math.random()}`, method, payload }),
      })
      return res.ok ? await res.json().catch(() => null) : null
    }, { method, payload })
    await rpc('workspace.create', { path: project })
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(3000)

    const clickNewSession = () => page.evaluate(() => {
      const btns = [...document.querySelectorAll('button[aria-label="New session"]')]
      btns[btns.length - 1]?.click()
    })
    await clickNewSession(); await sleep(1400)
    await page.evaluate(text => {
      const area = document.querySelector('textarea[data-phase]')
      if (area === null) throw new Error('no composer textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      area.focus()
      setter?.call(area, text)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }, 'Разбор парсера Авито: пустые строки в шаблоне')
    await sleep(900)
    await clickNewSession(); await sleep(1400)
    await sleep(600)

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[role="treeitem"]')].map(r => r.textContent ?? ''))
    log('tree rows:', JSON.stringify(rows))

    // Sidebar clip: the tree's own column, retina via deviceScaleFactor 2.
    const clip = await page.evaluate(() => {
      const tree = document.querySelector('[role="tree"]')
      const rect = (tree?.closest('div[class]')?.parentElement ?? tree)?.getBoundingClientRect()
      const root = rect ?? { left: 0, top: 0, width: 280, height: 900 }
      return {
        x: Math.max(0, root.left), y: 0,
        width: Math.min(320, root.width || 280),
        height: Math.min(720, root.height || 900),
      }
    })
    log('clip:', JSON.stringify(clip))
    await page.screenshot({ path: join(REPO_ROOT, 'assets/drafts-tree.png'), clip })

    // Hover the occupied (preview) row: the × reveals in the trailing cell.
    const box = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="treeitem"].dsd-draft-row')]
        .find(r => (r.textContent ?? '').includes('Разбор'))
      if (row === undefined) return null
      const rect = row.getBoundingClientRect()
      return { x: rect.left + rect.width - 14, y: rect.top + rect.height / 2 }
    })
    if (box === null) throw new Error('preview draft row not found for the hover shot')
    await page.mouse.move(box.x, box.y)
    await sleep(700)
    // Probe: the × must actually be VISIBLE in the shot (the stock hover rule
    // reveals the trailing action cell; this asserts it fired).
    const xVisible = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="treeitem"].dsd-draft-row')]
        .find(r => (r.textContent ?? '').includes('Разбор'))
      const x = row?.querySelector('button[data-dsd-discard]')
      if (x === undefined || x === null) return false
      const style = getComputedStyle(x)
      const parent = x.parentElement
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && parent !== null && getComputedStyle(parent).display !== 'none'
    })
    if (!xVisible) throw new Error('the × discard button is not visible under hover — shot would be misleading')
    log('× visible under hover: ok')
    await page.screenshot({ path: join(REPO_ROOT, 'assets/drafts-discard.png'), clip })
    log('wrote assets/drafts-tree.png and assets/drafts-discard.png')
  } finally {
    await browser.close()
  }
} catch (error) {
  console.error('[shots] FAIL:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  if (host !== null && host.exitCode === null) {
    try { process.kill(-host.pid, 'SIGTERM') } catch { /* group already gone */ }
  }
  if (home !== null) await rm(home, { recursive: true, force: true }).catch(() => {})
}
