import { execSync } from 'node:child_process'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Dev only: the console talks to the API same-origin through this proxy, as Caddy does in production.
const api = process.env.API_ADDR && `http://${process.env.API_ADDR}`
if (process.argv.includes('dev') && !api) throw new Error('Load the settings first (set -a; . ../.env; set +a): API_ADDR is where the API listens')

// The player shows which build it is (date and commit of the last change) in its About page. A download without git
// history (a release archive) has no commit to name.
function lastCommit() {
  try {
    return execSync('git log -1 --format="%cs · %h"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    console.warn('No git history here: the player will show "unknown build".')
    return 'unknown build'
  }
}
const build = lastCommit()

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] }, // unit tests: the console's own rules (lib/), no browser
  define: { __PLAYER_BUILD__: JSON.stringify(build) },
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    fs: { allow: ['..'] }, // the What's new page reads the repo's CHANGELOG.md
    proxy: {
      '/v1/': { target: api },
      // The player host's files (library/video/<file>), as Caddy sends them: under /play.
      '^/[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]': { target: api, rewrite: (p) => '/play' + p },
    },
  },
})
