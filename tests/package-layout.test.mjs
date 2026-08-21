import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')

test('package is a portable, prebuilt DSH Profile Bundle with a client half', async () => {
  assert.equal(pkg.name, '@ne-ilyxa/dsh-session-drafts')
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.repository?.url, 'git+https://github.com/ne-ilyxa/dsh-session-drafts.git')
  assert.equal(pkg.bugs?.url, 'https://github.com/ne-ilyxa/dsh-session-drafts/issues')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh?.client, {
    platform: 'web',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ],
  })
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/types/index.d.ts')
  assert.equal(pkg.exports?.['./client']?.default, './lib/client.js')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('src'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(typeof pkg.scripts?.build, 'string')
  assert.equal(typeof pkg.scripts?.prepack, 'string')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.1')
  assert.match(workspace, /^packages:\n  - \.\n/mu)
  assert.match(workspace, /^nodeLinker: hoisted$/mu)
  assert.match(workspace, /^autoInstallPeers: false$/mu)

  await access(new URL(pkg.main, root))
  await access(new URL(pkg.types, root))
  await access(new URL(pkg.exports['./client'].default, root))
  await access(new URL(pkg.dsh.bundle.patch, root))
})

test('profile patch mounts the package under a stable layer id', () => {
  assert.match(patch, /- insert:\n\s+- id: session-drafts\n\s+name: '@ne-ilyxa\/dsh-session-drafts'/u)
})

test('client bundle wraps in the DSH module-loader registration', async () => {
  const bundle = await readFile(new URL('lib/client.js', root), 'utf8')
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{ id: "@ne-ilyxa\/dsh-session-drafts"/u)
  assert.doesNotMatch(bundle, /import\s|require\("(?!react|@deepseek-ai\/dsh-client-ui-primitives)/u,
    'client bundle must stay pure: only baseline externals')
})

test('host entry is a no-op plugin (behavior lives in the browser)', async () => {
  const host = await readFile(new URL('src/index.ts', root), 'utf8')
  assert.match(host, /export default function sessionDraftsHost/u)
  assert.doesNotMatch(host, /ctx\.(provide|plugin|on)\(/u, 'host half must not register services')
})
