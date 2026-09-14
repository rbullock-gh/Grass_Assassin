const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')
const fs = require('node:fs')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

/**
 * Metro in a pnpm monorepo, consuming workspace packages as TypeScript source.
 *
 * Two things have to be arranged, and without both the app does not bundle at
 * all — which typecheck and the unit suite both pass straight over, because
 * neither of them runs the bundler.
 */

// 1. Watch the whole workspace, and let Metro walk up to the root store.
//    pnpm's node_modules is a symlink farm, so the default single-root
//    assumption finds neither the workspace packages nor their dependencies.
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// Hierarchical lookup stays ON. pnpm nests each package's own dependencies
// under .pnpm/<pkg>/node_modules, so walking up from the importing file is
// exactly how expo's own transitive deps get found; disabling it is the
// standard single-root assumption that breaks here.
config.resolver.unstable_enableSymlinks = true

/**
 * 2. Map NodeNext's ".js" specifiers back to the ".ts" files they mean.
 *
 * The shared packages are ESM TypeScript, where `import './client.js'` is the
 * correct and required way to refer to `client.ts` — tsc, tsx and vitest all
 * understand that. Metro does not: it looks for a literal client.js, does not
 * find one, and fails to resolve.
 *
 * Rewriting the extension is the whole fix. It is applied only when the .js
 * file genuinely does not exist, so a real compiled .js in node_modules still
 * wins and nothing about normal resolution changes.
 */
const TS_EXTENSIONS = ['.ts', '.tsx']

const defaultResolveRequest = config.resolver.resolveRequest

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest

  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const origin = path.dirname(context.originModulePath)
    const asJs = path.resolve(origin, moduleName)

    if (!fs.existsSync(asJs)) {
      const withoutExtension = asJs.slice(0, -'.js'.length)
      for (const extension of TS_EXTENSIONS) {
        if (fs.existsSync(withoutExtension + extension)) {
          return resolve(context, moduleName.slice(0, -'.js'.length) + extension, platform)
        }
      }
    }
  }

  return resolve(context, moduleName, platform)
}

module.exports = config
