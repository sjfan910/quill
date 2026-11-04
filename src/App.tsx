import { useEffect } from 'react'
import { Toaster } from './components/ui'
import { useRoute } from './lib/router'
import { recoverInterrupted } from './lib/session'
import Course from './screens/Course'
import Home from './screens/Home'
import Lecture from './screens/Lecture'
import Record from './screens/Record'
import Settings from './screens/Settings'

export default function App() {
  const r = useRoute()
  useEffect(() => {
    recoverInterrupted()
  }, [])
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
