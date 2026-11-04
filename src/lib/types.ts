export type Course = {
  id: string
  code: string // e.g. "CS 2050"
  name: string // e.g. "Intro to Discrete Math"
  color: string
  createdAt: number
}

export type Mark = {
  t: number // seconds into the recording
  kind: 'star' | 'note'
  text?: string
}

export type LectureStatus = 'recording' | 'saved' | 'processing' | 'ready' | 'error'

export type HistoryEntry = {
  at: number
  kind: 'generate' | 'refine'
  feedback?: string
  slides?: string[]
}

export type Lecture = {
  id: string
  courseId?: string // undefined = let Gemini detect it
  number?: number // lecture number inside the course
  title: string
  summary?: string
  createdAt: number
  durationSec: number
  chunkCount: number
  status: LectureStatus
  error?: string
  marks: Mark[]
  notesMd?: string
  mindmapMd?: string
  audioFile?: { name: string; uri: string; expiresAt: number }
  slides: { key: string; name: string; type: string; size: number }[]
  history: HistoryEntry[]
  gdocUrl?: string
}
