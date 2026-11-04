import DOMPurify from 'dompurify'
import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import { useEffect, useRef } from 'react'

const transformer = new Transformer()
// Security: markmap enables raw HTML by default and renders node content with
// innerHTML. Mind maps come from Gemini, so treat them as untrusted.
transformer.md.set({ html: false })

type Node = { content: string; children?: Node[] }
function sanitize<T extends Node>(node: T): T {
  node.content = DOMPurify.sanitize(node.content, { USE_PROFILES: { html: true } })
  node.children?.forEach(sanitize)
  return node
}

export default function MindMap({ md }: { md: string }) {
  const svg = useRef<SVGSVGElement>(null)
  const mm = useRef<Markmap | null>(null)

  useEffect(() => {
    if (!svg.current) return
    const root = sanitize(transformer.transform(md).root)
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
