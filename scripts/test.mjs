import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const directory = await mkdtemp(path.join(tmpdir(), 'replay-tests-'))
try {
  const outfile = path.join(directory, 'steps.test.cjs')
  await build({ entryPoints: ['tests/steps.test.tsx'], outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic' })
  const result = spawnSync(process.execPath, ['--test', outfile, 'tests/atifLive.test.mjs',
    'tests/bufferCache.test.mjs', 'tests/proxyApi.test.mjs'], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
