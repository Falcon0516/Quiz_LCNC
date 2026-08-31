// ─── QuizStore — In-Memory Repository ───────────────────────────────────────
// Implements a repository interface pattern so the backing store can be swapped
// to Redis/Postgres later without touching business logic.

import { QuizConfig, QuizSession, Participant, LeaderboardEntry } from './types';
import { generateJoinCode, generateToken, log } from './utils';

// ─── Repository Interface ───────────────────────────────────────────────────

export interface IQuizStore {
  createSession(quiz: QuizConfig): QuizSession;
  getSession(code: string): QuizSession | undefined;
  deleteSession(code: string): void;
  getAllSessions(): QuizSession[];
}

// ─── Token Map (participantToken → { code, participantId }) ─────────────────

interface TokenEntry {
  code: string;
  participantId: string;
}

// ─── In-Memory Implementation ───────────────────────────────────────────────

export class QuizStore implements IQuizStore {
  private sessions: Map<string, QuizSession> = new Map();
  private tokens: Map<string, TokenEntry> = new Map();
  private questionTimers: Map<string, NodeJS.Timeout> = new Map();

  createSession(quiz: QuizConfig): QuizSession {
    // Generate a unique 6-char code (retry on collision)
    let code = generateJoinCode();
    let attempts = 0;
    while (this.sessions.has(code) && attempts < 10) {
      code = generateJoinCode();
      attempts++;
    }
    if (this.sessions.has(code)) {
      throw new Error('Could not generate a unique session code after 10 attempts');
    }

    const session: QuizSession = {
      code,
      quiz,
      phase: 'lobby',
      currentQuestionIndex: 0,
      questionStartedAt: null,
      questionEndsAt: null,
      participants: {},
      adminSocketId: null,
    };

    this.sessions.set(code, session);
    log('SESSION_CREATED', { code, title: quiz.title, questionCount: quiz.questions.length });
    return session;
  }

  getSession(code: string): QuizSession | undefined {
    return this.sessions.get(code);
  }

  deleteSession(code: string): void {
    this.clearQuestionTimer(code);
    // Clean up tokens for this session
    for (const [token, entry] of this.tokens.entries()) {
      if (entry.code === code) {
        this.tokens.delete(token);
      }
    }
    this.sessions.delete(code);
    log('SESSION_DELETED', { code });
  }

  getAllSessions(): QuizSession[] {
    return Array.from(this.sessions.values());
  }

  // ─── Participant Management ─────────────────────────────────────────────

  addParticipant(
    code: string,
    name: string,
    socketId: string
  ): { participant: Participant; token: string } | { error: string } {
    const session = this.sessions.get(code);
    if (!session) return { error: 'Quiz not found' };

    // Check name uniqueness (case-insensitive)
    const nameLower = name.trim().toLowerCase();
    const existing = Object.values(session.participants).find(
      (p) => p.name.toLowerCase() === nameLower
    );
    if (existing) {
      return { error: 'Name already taken in this quiz' };
    }

    const token = generateToken();
    const participant: Participant = {
      id: token, // use token as participant ID for simplicity
      name: name.trim(),
      joinedAt: Date.now(),
      connected: true,
      score: 0,
      answers: {},
    };

    session.participants[participant.id] = participant;
    this.tokens.set(token, { code, participantId: participant.id });

    log('PARTICIPANT_JOINED', { code, name: participant.name, id: participant.id });
    return { participant, token };
  }

  rejoinParticipant(
    token: string,
    socketId: string
  ): { session: QuizSession; participant: Participant } | { error: string } {
    const entry = this.tokens.get(token);
    if (!entry) return { error: 'Invalid token — session may have expired' };

    const session = this.sessions.get(entry.code);
    if (!session) return { error: 'Quiz session no longer exists' };

    const participant = session.participants[entry.participantId];
    if (!participant) return { error: 'Participant no longer exists in this session' };

    participant.connected = true;
    log('PARTICIPANT_REJOINED', { code: entry.code, name: participant.name });
    return { session, participant };
  }

  disconnectParticipant(token: string): void {
    const entry = this.tokens.get(token);
    if (!entry) return;

    const session = this.sessions.get(entry.code);
    if (!session) return;

    const participant = session.participants[entry.participantId];
    if (participant) {
      participant.connected = false;
      log('PARTICIPANT_DISCONNECTED', { code: entry.code, name: participant.name });
    }
  }

  kickParticipant(code: string, participantId: string): boolean {
    const session = this.sessions.get(code);
    if (!session) return false;

    const participant = session.participants[participantId];
    if (!participant) return false;

    // Remove participant and their token
    delete session.participants[participantId];
    for (const [token, entry] of this.tokens.entries()) {
      if (entry.participantId === participantId) {
        this.tokens.delete(token);
        break;
      }
    }

    log('PARTICIPANT_KICKED', { code, name: participant.name });
    return true;
  }

  getTokenEntry(token: string): TokenEntry | undefined {
    return this.tokens.get(token);
  }

  // ─── Leaderboard ────────────────────────────────────────────────────────

  getLeaderboard(code: string, questionId?: string): LeaderboardEntry[] {
    const session = this.sessions.get(code);
    if (!session) return [];

    const entries: LeaderboardEntry[] = Object.values(session.participants)
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        rank: 0, // will be set below
        delta: questionId && p.answers[questionId]
          ? p.answers[questionId].pointsAwarded
          : 0,
        lastAnswerCorrect: questionId && p.answers[questionId]
          ? p.answers[questionId].correct
          : null,
      }))
      .sort((a, b) => b.score - a.score);

    // Assign ranks (handling ties)
    entries.forEach((entry, i) => {
      if (i === 0) {
        entry.rank = 1;
      } else if (entry.score === entries[i - 1].score) {
        entry.rank = entries[i - 1].rank;
      } else {
        entry.rank = i + 1;
      }
    });

    return entries;
  }

  // ─── Question Timer Management ──────────────────────────────────────────

  setQuestionTimer(code: string, timer: NodeJS.Timeout): void {
    this.clearQuestionTimer(code); // clear any existing
    this.questionTimers.set(code, timer);
  }

  clearQuestionTimer(code: string): void {
    const existing = this.questionTimers.get(code);
    if (existing) {
      clearTimeout(existing);
      this.questionTimers.delete(code);
    }
  }

  // ─── Answer Count ───────────────────────────────────────────────────────

  getAnsweredCount(code: string, questionId: string): number {
    const session = this.sessions.get(code);
    if (!session) return 0;
    return Object.values(session.participants).filter(
      (p) => p.answers[questionId] !== undefined
    ).length;
  }

  getConnectedCount(code: string): number {
    const session = this.sessions.get(code);
    if (!session) return 0;
    return Object.values(session.participants).filter((p) => p.connected).length;
  }
}

// Singleton export
export const store = new QuizStore();
