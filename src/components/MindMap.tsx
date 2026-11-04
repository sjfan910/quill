import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import { useEffect, useRef } from 'react'

const transformer = new Transformer()

export default function MindMap({ md }: { md: string }) {
  const svg = useRef<SVGSVGElement>(null)
  const mm = useRef<Markmap | null>(null)

  useEffect(() => {
    if (!svg.current) return
    const { root } = transformer.transform(md)
    if (!mm.current) {
      mm.current = Markmap.create(svg.current, { duration: 300, maxWidth: 180, initialExpandLevel: 2, spacingVertical: 10, spacingHorizontal: 60, fitRatio: 0.95 }, root)
    } else {
      mm.current.setData(root).then(() => mm.current?.fit())
    }
  }, [md])

  useEffect(() => () => {
    mm.current?.destroy()
    mm.current = null
  }, [])

  return (
    <div className="mindmap">
      <svg ref={svg} />
      <button className="chip mindmap-fit" onClick={() => mm.current?.fit()}>
        ⤢ Fit
      </button>
    </div>
  )
}
