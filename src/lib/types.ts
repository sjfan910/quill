export type Course = {
  id: string
  code: string // e.g. "CS 2050"
  name: string // e.g. "Intro to Discrete Math"
  color: string
  createdAt: number
  /** Compact running memory of the class (Markdown, ~350 words max), maintained by Gemini. */
  memory?: string
  memoryUpdatedAt?: number
}

export type Mark = {
  t: number // seconds into the recording
  kind: 'star' | 'note'
  text?: string
}

export type LectureStatus = 'recording' | 'saved' | 'processing' | 'ready' | 'error'

export type Usage = {
  model: string
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  thoughtsTokens: number
}

export type HistoryEntry = {
  at: number
  kind: 'generate' | 'refine'
  feedback?: string
  slides?: string[]
  usage?: Usage
  learned?: string[]
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
