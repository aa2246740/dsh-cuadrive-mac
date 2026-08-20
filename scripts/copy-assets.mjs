import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'lib'), { recursive: true })
await copyFile(join(root, 'src/host-tcc-prompt.c'), join(root, 'lib/host-tcc-prompt.c'))
