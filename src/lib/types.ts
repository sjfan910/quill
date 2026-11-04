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

/** One piece of transcript. t = seconds from the start of the recording. */
export type TranscriptSeg = {
  t: number
  text: string
  src: 'live' | 'gemini'
}

export type Usage = {
  model: string
  kind?: 'transcribe' | 'notes'
  promptTokens: number
  audioTokens?: number
  costUsd?: number
  cachedTokens: number
  outputTokens: number
  thoughtsTokens: number
}

export type HistoryEntry = {
  at: number
  kind: 'generate' | 'refine' | 'transcribe'
  feedback?: string
  slides?: string[]
  usage?: Usage
  learned?: string[]
  /** Seconds of audio sent to Gemini (transcription runs). */
  paidSec?: number
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
  /** Per-second loudness (0-1) captured while recording; used to find speech and trim silence. */
  loudness?: number[]
  /** Free live transcript captured on-device while recording (Web Speech API). */
  live?: { t: number; text: string; c?: number }[]
  liveNote?: string
  /** Final merged transcript (live + Gemini for the gaps). Notes and Improve run on this text. */
  transcript?: TranscriptSeg[]
  transcriptStats?: { liveSec: number; paidSec: number; speechSec: number }
}
