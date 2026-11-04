import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { parseTime } from './util'

marked.setOptions({ gfm: true, breaks: false })

const TS = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g

/** Markdown -> safe HTML for the in-app view, with tappable [mm:ss] timestamps. */
export function renderNotes(md: string) {
  const html = marked.parse(md, { async: false })
  const withTs = html.replace(TS, (_, t: string) => `<button class="ts" data-t="${parseTime(t)}">${t}</button>`)
  return DOMPurify.sanitize(withTs, { ADD_ATTR: ['data-t'] })
}

/** Markdown -> HTML tuned for Google Docs import (plain timestamps, inline styles). */
export function renderForDocs(md: string, heading: string) {
  const body = marked
    .parse(md, { async: false })
    .replace(/<input[^>]*checked[^>]*>/g, '☑ ')
    .replace(/<input[^>]*>/g, '☐ ')
  const clean = DOMPurify.sanitize(body)
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.4}
h1{font-size:20pt} h2{font-size:15pt;color:#3730a3;margin-top:18pt} h3{font-size:12.5pt;margin-top:12pt}
table{border-collapse:collapse} td,th{border:1px solid #bbb;padding:4pt 6pt;vertical-align:top} th{background:#eef}
blockquote{border-left:3px solid #6366f1;margin:0;padding:4pt 10pt;background:#f5f5ff}
code,pre{font-family:'Courier New',monospace;font-size:10pt;background:#f4f4f4}
</style></head><body><p style="color:#666">${escapeHtml(heading)}</p>${clean}</body></html>`
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Memory is line-oriented: keep single line breaks. */
export function renderMemory(md: string) {
  return DOMPurify.sanitize(marked.parse(md, { async: false, breaks: true }))
}
