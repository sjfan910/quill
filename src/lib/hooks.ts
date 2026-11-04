import { useEffect, useState } from 'react'
import { subscribe } from './db'

/** Re-runs an async loader whenever the database changes. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>()
  useEffect(() => {
    let alive = true
    const run = () => load().then((d) => alive && setData(d))
    run()
    const unsub = subscribe(run)
    return () => {
      alive = false
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return data
}
