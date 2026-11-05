import DOMPurify from 'dompurify'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { marked } from 'marked'
import { parseTime } from './util'

marked.setOptions({ gfm: true, breaks: false })

const TS = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g

// ---------------------------------------------------------------- math (LaTeX)
//
// Math is pulled out BEFORE markdown runs (so `_` and `*` inside formulas aren't turned
// into italics), replaced by placeholders, and typeset with KaTeX AFTER the HTML has been
// sanitized. KaTeX escapes everything it outputs and runs with trust:false, so formulas
// can't inject links or scripts.

type MathBit = { tex: string; display: boolean }
const PH = (i: number) => `⁣MATH${i}⁣` // invisible separator: never typed by a person

function protectMath(md: string): { text: string; math: MathBit[] } {
  const math: MathBit[] = []
  const keep = (tex: string, display: boolean) => {
    math.push({ tex: tex.trim(), display })
    return PH(math.length - 1)
  }
  // Leave fenced and inline code untouched.
  const out = md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/)
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk
      return chunk
        .split(/(`[^`\n]+`)/)
        .map((part, j) => {
          if (j % 2 === 1) return part
          return (
            part
              // display: $$…$$ and \[…\]  (on their own paragraph so they render as blocks)
              .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `\n\n${keep(t, true)}\n\n`)
              .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `\n\n${keep(t, true)}\n\n`)
              // inline: \(…\) and $…$ (pandoc rule: no space inside the $, no digit right after
              // the closing $, so "costs $5 and $10" stays plain text)
              .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(t, false))
              .replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g, (_, pre, t) => `${pre}${keep(t, false)}`)
          )
        })
        .join('')
    })
    .join('')
  return { text: out, math }
}

function typeset(bit: MathBit) {
  return katex.renderToString(bit.tex, {
    displayMode: bit.display,
    throwOnError: false, // bad LaTeX shows as red source instead of breaking the page
    trust: false,
    strict: 'ignore',
    output: 'html',
  })
}

function restoreMath(html: string, math: MathBit[], render: (b: MathBit) => string) {
  return html
    .replace(new RegExp(`<p>\\s*${PH(-1).replace('-1', '(\\d+)')}\\s*</p>`, 'g'), (_, i) => {
      const b = math[Number(i)]
      return b?.display ? `<div class="math-block">${render(b)}</div>` : _
    })
    .replace(new RegExp(PH(-1).replace('-1', '(\\d+)'), 'g'), (_, i) => {
      const b = math[Number(i)]
      return b ? (b.display ? `<div class="math-block">${render(b)}</div>` : render(b)) : ''
    })
}

/** Markdown (+ LaTeX) -> safe HTML for the in-app view, with tappable [mm:ss] timestamps. */
export function renderNotes(md: string) {
  const { text, math } = protectMath(md)
  const html = marked.parse(text, { async: false })
  const withTs = html.replace(TS, (_, t: string) => `<button class="ts" data-t="${parseTime(t)}">${t}</button>`)
  const safe = DOMPurify.sanitize(withTs, { ADD_ATTR: ['data-t'] })
  return restoreMath(safe, math, typeset)
}

/** Markdown -> HTML tuned for Google Docs import (plain timestamps, inline styles). */
export function renderForDocs(md: string, heading: string) {
  // Google Docs can't display typeset math from pasted HTML, so formulas go in as readable
  // LaTeX source in a math-looking font (paste into Docs' equation editor if needed).
  const { text, math } = protectMath(md)
  const body = marked
    .parse(text, { async: false })
    .replace(/<input[^>]*checked[^>]*>/g, '☑ ')
    .replace(/<input[^>]*>/g, '☐ ')
  const clean = restoreMath(DOMPurify.sanitize(body), math, (b) =>
    `<span style="font-family:'Cambria Math','Times New Roman',serif;font-style:italic">${escapeHtml(b.display ? `$$${b.tex}$$` : `$${b.tex}$`)}</span>`,
  )
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.4}
h1{font-size:20pt} h2{font-size:15pt;color:#3730a3;margin-top:18pt} h3{font-size:12.5pt;margin-top:12pt}
table{border-collapse:collapse} td,th{border:1px solid #bbb;padding:4pt 6pt;vertical-align:top} th{background:#eef}
blockquote{border-left:3px solid #6366f1;margin:0;padding:4pt 10pt;background:#f5f5ff}
code,pre{font-family:'Courier New',monospace;font-size:10pt;background:#f4f4f4}
.math-block{margin:6pt 0 6pt 18pt}
</style></head><body><p style="color:#666">${escapeHtml(heading)}</p>${clean}</body></html>`
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Memory is line-oriented: keep single line breaks. */
export function renderMemory(md: string) {
  const { text, math } = protectMath(md)
  return restoreMath(DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true })), math, typeset)
}
