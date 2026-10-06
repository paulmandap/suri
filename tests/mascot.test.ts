import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOOK_AHEAD, lookToward } from '@shared/look'

// The mascot's art comes from scripts/mascot/build_mascot.py. These checks
// keep a re-run on new art from breaking the island without anyone noticing.

const SPRITES_TS = join(process.cwd(), 'src', 'renderer', 'src', 'mascot', 'sprites.ts')

describe('the sprites the island imports', () => {
  const source = readFileSync(SPRITES_TS, 'utf8')
  const imports = [...source.matchAll(/from '(\.\.\/[^']+\.(?:webp|json))'/g)].map(
    (m) => m[1] ?? ''
  )

  it('all exist', () => {
    expect(imports.length).toBeGreaterThanOrEqual(9)
    for (const path of imports) {
      expect(existsSync(resolve(dirname(SPRITES_TS), path)), path).toBe(true)
    }
  })

  it('include a pose for every mood', () => {
    for (const mood of ['idle', 'working', 'alert', 'happy', 'sleepy', 'worried']) {
      expect(
        imports.some((path) => path.endsWith(`/${mood}.webp`)),
        mood
      ).toBe(true)
    }
  })
})

describe('head.json', () => {
  const face = JSON.parse(
    readFileSync(join(process.cwd(), 'assets', 'mascot', 'sprites', 'head.json'), 'utf8')
  ) as {
    width: number
    height: number
    eyes: { cx: number; cy: number; rx: number; ry: number }[]
    nose: { cx: number; cy: number; rx: number; ry: number }
  }

  it('describes a face: two eyes, left then right, level, with the nose below and between', () => {
    expect(face.width).toBeGreaterThan(0)
    expect(face.height).toBeGreaterThan(0)
    const [left, right] = face.eyes
    expect(face.eyes).toHaveLength(2)
    expect(left!.cx).toBeLessThan(0.5)
    expect(right!.cx).toBeGreaterThan(0.5)
    expect(Math.abs(left!.cy - right!.cy)).toBeLessThan(0.05)
    expect(face.nose.cx).toBeGreaterThan(left!.cx)
    expect(face.nose.cx).toBeLessThan(right!.cx)
    expect(face.nose.cy).toBeGreaterThan(left!.cy)
    for (const part of [...face.eyes, face.nose]) {
      for (const value of [part.cx, part.cy, part.rx, part.ry]) {
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(1)
      }
    }
  })
})

describe('lookToward', () => {
  it('looks ahead when the pointer is on the head', () => {
    expect(lookToward(0, 0)).toBe(LOOK_AHEAD)
  })

  it('glances further the further away the pointer is, up to full at the reach', () => {
    expect(lookToward(110, 0, 220)).toEqual({ x: 0.5, y: 0 })
    expect(lookToward(500, 0, 220)).toEqual({ x: 1, y: 0 })
    expect(lookToward(0, -1000, 220)).toEqual({ x: 0, y: -1 })
  })

  it('keeps the direction on a diagonal', () => {
    const look = lookToward(300, 300, 220)
    expect(look.x).toBeCloseTo(Math.SQRT1_2)
    expect(look.y).toBeCloseTo(Math.SQRT1_2)
    expect(Math.hypot(look.x, look.y)).toBeCloseTo(1)
  })
})
