// Rasterizes build/icon.svg and writes the platform icon files electron-builder
// picks up automatically: build/icon.png (1024), build/icon.ico, build/icon.icns.
// Run with: node scripts/make-icons.mjs   (after `npm i -D sharp png2icons`)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import png2icons from 'png2icons'

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const svg = readFileSync(join(buildDir, 'icon.svg'))
const png = await sharp(svg).resize(1024, 1024).png().toBuffer()
writeFileSync(join(buildDir, 'icon.png'), png)
writeFileSync(join(buildDir, 'icon.ico'), png2icons.createICO(png, png2icons.BICUBIC, 0, false))
writeFileSync(join(buildDir, 'icon.icns'), png2icons.createICNS(png, png2icons.BICUBIC, 0))
console.log('Wrote icon.png, icon.ico, icon.icns to', buildDir)
