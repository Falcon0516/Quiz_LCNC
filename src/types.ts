// ─── Shared TypeScript Types ────────────────────────────────────────────────
// These types define the core data model for the quiz platform.
// Keep in sync with frontend/src/lib/types.ts

export interface Question {
  id: string;
  question: string;
  options: string[];        // 2-6 options
  correctIndex: number;     // index into options
  timeLimitSeconds: number; // per-question timer
  points: number;           // base points for correct answer
  imageUrl?: string;        // optional image above the question
}

export interface QuizConfig {
  id: string;
  title: string;
  questions: Question[];
}

export interface ParticipantAnswer {
  optionIndex: number;
  correct: boolean;
  timeTakenMs: number;
  pointsAwarded: number;
}

export interface Participant {
  id: string;           // persistent uuid, survives reconnects via token
  name: string;
  joinedAt: number;
  connected: boolean;
  score: number;
  answers: Record<string /* questionId */, ParticipantAnswer>;
}

export type QuizPhase =
  | "lobby"            // waiting room, admin hasn't started
  | "question_active"  // question shown, timer running, accepting answers
  | "question_locked"  // timer ended, showing correct answer + leaderboard
  | "finished";        // all questions done, final leaderboard

export interface QuizSession {
  code: string;              // 6-char human-friendly join code, e.g. "K7QX2A"
  quiz: QuizConfig;
  phase: QuizPhase;
  currentQuestionIndex: number;
  questionStartedAt: number | null;  // epoch ms, authoritative for timer sync
  questionEndsAt: number | null;     // epoch ms — clients compute remaining from this
  participants: Record<string, Participant>;
  adminSocketId: string | null;
}

// ─── Socket Event Payloads ──────────────────────────────────────────────────

export interface LeaderboardEntry {
  id: string;
  name: string;
  score: number;
  rank: number;
  delta: number;        // points gained this round
  lastAnswerCorrect: boolean | null;
}

export interface QuestionShowPayload {
  question: Omit<Question, 'correctIndex'>;
  questionIndex: number;
  totalQuestions: number;
  questionEndsAt: number;
}

export interface QuestionRevealPayload {
  correctIndex: number;
  leaderboard: LeaderboardEntry[];
}

export interface YourResultPayload {
  correct: boolean;
  pointsAwarded: number;
  totalScore: number;
  rank: number;
}

export interface LobbyUpdatePayload {
  participants: Array<{ id: string; name: string; connected: boolean }>;
  count: number;
}

export interface QuizFinishedPayload {
  finalLeaderboard: LeaderboardEntry[];
}

export interface ErrorPayload {
  message: string;
  code: string;
}

export interface SessionStatePayload {
  code: string;
  phase: QuizPhase;
  currentQuestionIndex: number;
  questionEndsAt: number | null;
  totalQuestions: number;
  title: string;
  participants: Array<{ id: string; name: string; connected: boolean; score: number }>;
  currentQuestion?: Omit<Question, 'correctIndex'>;
  currentQuestionFull?: Question; // only sent to admin
  answeredCount?: number;
}
