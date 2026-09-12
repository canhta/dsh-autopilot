import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const packageId = '@canhta/dsh-autopilot'
const cssPrefix = '\0dsh-autopilot-css:'
const cssSuffix = '.mjs'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  sourcemap: true,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: ['zod'],
    onlyBundle: ['zod'],
    neverBundle: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
    ],
  },
  plugins: [
    {
      name: 'dsh-autopilot-css-modules',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        const file = isAbsolute(source)
          ? source
          : resolve(importer === undefined ? process.cwd() : `${importer}/..`, source)
        return `${cssPrefix}${file}${cssSuffix}`
      },
      async load(id) {
        if (!id.startsWith(cssPrefix)) return null
        const file = id.slice(cssPrefix.length, -cssSuffix.length)
        this.addWatchFile(file)
        const result = transform({ filename: file, code: await readFile(file), cssModules: true, minify: true })
        const classes = Object.fromEntries(
          Object.entries(result.exports ?? {}).map(([name, value]) => [name, value.name]),
        )
        const css = JSON.stringify(result.code.toString())
        const tag = JSON.stringify(`${packageId}/${file.split('/').at(-1)}`)
        return [
          `const css = ${css};`,
          `const tagId = ${tag};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const element = document.createElement('style');",
          `  element.dataset.plugin = ${JSON.stringify(packageId)};`,
          '  element.dataset.pluginCss = tagId;',
          '  element.textContent = css;',
          '  document.head.appendChild(element);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
