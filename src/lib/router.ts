import { useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'record'; id: string }
  | { name: 'lecture'; id: string }
  | { name: 'course'; id: string }
  | { name: 'settings' }

export function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/')
  if (a === 'record' && b) return { name: 'record', id: b }
  if (a === 'lecture' && b) return { name: 'lecture', id: b }
  if (a === 'course' && b) return { name: 'course', id: b }
  if (a === 'settings') return { name: 'settings' }
  return { name: 'home' }
}

export function go(path: string, replace = false) {
  const h = '#' + path
  if (replace) location.replace(h)
  else location.hash = h
}

export function useRoute() {
  const [r, setR] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => {
      setR(parse(location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}
