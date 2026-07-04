// Build number = git commit count, injected at build time so the header's
// "Build N" tag always reflects what's actually deployed (it was previously
// hardcoded and went stale). Falls back to 'dev' outside a git checkout.
const { execSync } = require('child_process')
let buildNumber = 'dev'
try {
  buildNumber = execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: {
    NEXT_PUBLIC_BUILD: buildNumber,
  },
}

module.exports = nextConfig
