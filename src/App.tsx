import { useEffect, useState } from 'react'
import { Toaster } from './components/ui'
import { useRoute } from './lib/router'
import { recoverInterrupted } from './lib/session'
import { cloudEnabled, localOnly, useSession } from './lib/supabase'
import { startSync, stopSync } from './lib/sync'
import Course from './screens/Course'
import Home from './screens/Home'
import Lecture from './screens/Lecture'
import Login from './screens/Login'
import Record from './screens/Record'
import Settings from './screens/Settings'

export default function App() {
  const r = useRoute()
  const session = useSession()
  const [skipped, setSkipped] = useState(localOnly)

  useEffect(() => {
    recoverInterrupted()
  }, [])

  const uid = session?.user.id
  useEffect(() => {
    if (uid) void startSync(uid)
    else stopSync()
  }, [uid])

  if (cloudEnabled && session === undefined) return <main className="page" />
  if (cloudEnabled && !session && !skipped) return <Login onSkip={() => setSkipped(true)} />

  return (
    <>
      {r.name === 'home' && <Home />}
      {r.name === 'record' && <Record id={r.id} />}
      {r.name === 'lecture' && <Lecture id={r.id} key={r.id} />}
      {r.name === 'course' && <Course id={r.id} key={r.id} />}
      {r.name === 'settings' && <Settings />}
      <Toaster />
    </>
  )
}
