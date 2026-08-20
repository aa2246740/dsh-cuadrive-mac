export default {
  entry: {
    index: 'src/dsh-cuadrive-mac.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  platform: 'node',
  sourcemap: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
}
