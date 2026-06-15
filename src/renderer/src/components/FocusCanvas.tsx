import { useEffect, useRef } from 'react'
import { moodById } from '../lib/moods'

interface Props {
  moodId: string
}

interface Orb {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
  phase: number
  pulse: number
}

/**
 * Generative ambient display — softly drifting, gently pulsing glows of color
 * on a dark base. Calm, slow, never jarring. Pure canvas (no media), so it works
 * offline and respects prefers-reduced-motion by falling back to a static wash.
 */
export default function FocusCanvas({ moodId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const mood = moodById(moodId)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    let w = 0
    let h = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)

    function resize() {
      w = canvas!.clientWidth
      h = canvas!.clientHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas!.width = Math.floor(w * dpr)
      canvas!.height = Math.floor(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const count = 6
    const orbs: Orb[] = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      r: Math.min(w, h) * (0.3 + Math.random() * 0.25),
      color: mood.colors[i % mood.colors.length],
      phase: Math.random() * Math.PI * 2,
      pulse: 0.6 + Math.random() * 0.5
    }))

    function drawOrb(o: Orb, scale: number) {
      const radius = o.r * scale
      const g = ctx!.createRadialGradient(o.x, o.y, 0, o.x, o.y, radius)
      g.addColorStop(0, o.color)
      g.addColorStop(1, 'transparent')
      ctx!.fillStyle = g
      ctx!.beginPath()
      ctx!.arc(o.x, o.y, radius, 0, Math.PI * 2)
      ctx!.fill()
    }

    let raf = 0
    let t = 0

    function frame() {
      t += 0.006
      ctx!.globalCompositeOperation = 'source-over'
      ctx!.fillStyle = mood.base
      ctx!.fillRect(0, 0, w, h)

      ctx!.globalCompositeOperation = 'lighter'
      for (const o of orbs) {
        if (!reduce) {
          o.x += o.vx
          o.y += o.vy
          if (o.x < -o.r * 0.4 || o.x > w + o.r * 0.4) o.vx *= -1
          if (o.y < -o.r * 0.4 || o.y > h + o.r * 0.4) o.vy *= -1
        }
        const scale = reduce ? 0.85 : 0.78 + Math.sin(t * o.pulse + o.phase) * 0.16
        drawOrb(o, scale)
      }
      ctx!.globalCompositeOperation = 'source-over'

      if (!reduce) raf = requestAnimationFrame(frame)
    }
    frame()

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(raf)
    }
  }, [moodId])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
}
