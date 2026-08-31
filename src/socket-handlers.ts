// ─── Socket.IO Event Handlers ───────────────────────────────────────────────
// All real-time quiz logic: admin controls, participant actions, server broadcasts.

import { Server, Socket } from 'socket.io';
import { store } from './store';
import { calculateScore } from './scoring';
import { log } from './utils';
import { config } from './config';
import {
  quizConfigSchema,
  joinPayloadSchema,
  rejoinPayloadSchema,
  codePayloadSchema,
  submitAnswerPayloadSchema,
  kickPayloadSchema,
} from './schema';
import {
  QuizSession,
  QuestionShowPayload,
  QuestionRevealPayload,
  YourResultPayload,
  LobbyUpdatePayload,
  SessionStatePayload,
} from './types';
import { generateQuizId } from './utils';

// ─── Rate Limiting (simple per-socket) ──────────────────────────────────────

const socketRateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 20;

function checkRateLimit(socketId: string): boolean {
  const now = Date.now();
  let entry = socketRateLimits.get(socketId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    socketRateLimits.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ─── Track socket → { role, code, participantToken } ────────────────────────

interface SocketMeta {
  role: 'admin' | 'participant' | 'display';
  code: string;
  participantToken?: string;
}

const socketMeta = new Map<string, SocketMeta>();

// ─── Helper: Build lobby update payload ─────────────────────────────────────

function buildLobbyUpdate(session: QuizSession): LobbyUpdatePayload {
  const participants = Object.values(session.participants).map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
  }));
  return { participants, count: participants.length };
}

// ─── Helper: Build session state for reconnection ───────────────────────────

function buildSessionState(session: QuizSession, isAdmin: boolean): SessionStatePayload {
  const currentQ = session.quiz.questions[session.currentQuestionIndex];
  const questionId = currentQ?.id;
  const payload: SessionStatePayload = {
    code: session.code,
    phase: session.phase,
    currentQuestionIndex: session.currentQuestionIndex,
    questionEndsAt: session.questionEndsAt,
    totalQuestions: session.quiz.questions.length,
    title: session.quiz.title,
    participants: Object.values(session.participants).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
    })),
  };

  if (session.phase === 'question_active' && currentQ) {
    const { correctIndex, ...safeQuestion } = currentQ;
    payload.currentQuestion = safeQuestion;
    if (isAdmin) {
      payload.currentQuestionFull = currentQ;
    }
    if (questionId) {
      payload.answeredCount = store.getAnsweredCount(session.code, questionId);
    }
  }

  if (session.phase === 'question_locked' && currentQ) {
    const { correctIndex, ...safeQuestion } = currentQ;
    payload.currentQuestion = safeQuestion;
    if (isAdmin) {
      payload.currentQuestionFull = currentQ;
    }
  }

  return payload;
}

// ─── Helper: Start question timer ───────────────────────────────────────────

function startQuestionTimer(io: Server, session: QuizSession): void {
  const question = session.quiz.questions[session.currentQuestionIndex];
  if (!question) return;

  const now = Date.now();
  session.phase = 'question_active';
  session.questionStartedAt = now;
  session.questionEndsAt = now + question.timeLimitSeconds * 1000;

  // Broadcast question (without correctIndex) to participants + display
  const { correctIndex, ...safeQuestion } = question;
  const showPayload: QuestionShowPayload = {
    question: safeQuestion,
    questionIndex: session.currentQuestionIndex,
    totalQuestions: session.quiz.questions.length,
    questionEndsAt: session.questionEndsAt,
  };

  io.to(session.code).emit('question:show', showPayload);

  // Send full question (with correctIndex) only to admin
  if (session.adminSocketId) {
    io.to(session.adminSocketId).emit('question:show:admin', {
      ...showPayload,
      correctIndex: question.correctIndex,
    });
  }

  log('QUESTION_STARTED', {
    code: session.code,
    questionIndex: session.currentQuestionIndex,
    questionId: question.id,
    timeLimitSeconds: question.timeLimitSeconds,
  });

  // Server-authoritative timer — auto-lock when time expires
  const timer = setTimeout(() => {
    endQuestion(io, session);
  }, question.timeLimitSeconds * 1000);

  store.setQuestionTimer(session.code, timer);
}

// ─── Helper: End question (lock + reveal) ───────────────────────────────────

function endQuestion(io: Server, session: QuizSession): void {
  if (session.phase !== 'question_active') return; // guard against double-fire

  session.phase = 'question_locked';
  store.clearQuestionTimer(session.code);

  const question = session.quiz.questions[session.currentQuestionIndex];
  const leaderboard = store.getLeaderboard(session.code, question.id);

  // Broadcast reveal to all
  const revealPayload: QuestionRevealPayload = {
    correctIndex: question.correctIndex,
    leaderboard,
  };
  io.to(session.code).emit('question:reveal', revealPayload);

  // Send individual results to each participant
  for (const participant of Object.values(session.participants)) {
    const answer = participant.answers[question.id];
    const yourResult: YourResultPayload = {
      correct: answer?.correct ?? false,
      pointsAwarded: answer?.pointsAwarded ?? 0,
      totalScore: participant.score,
      rank: leaderboard.find((e) => e.id === participant.id)?.rank ?? 0,
    };

    // Find participant's socket
    for (const [socketId, meta] of socketMeta.entries()) {
      if (meta.participantToken === participant.id && meta.code === session.code) {
        io.to(socketId).emit('question:your_result', yourResult);
        break;
      }
    }
  }

  log('QUESTION_ENDED', {
    code: session.code,
    questionIndex: session.currentQuestionIndex,
    questionId: question.id,
  });
}

// ─── Main Socket Setup ─────────────────────────────────────────────────────

export function setupSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    log('SOCKET_CONNECTED', { socketId: socket.id });

    // ─── Admin Events ─────────────────────────────────────────────────

    socket.on('admin:create_or_load_quiz', (data: unknown, callback?: Function) => {
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded', code: 'RATE_LIMITED' });
        return;
      }

      const parsed = quizConfigSchema.safeParse(data);
      if (!parsed.success) {
        const errors = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        socket.emit('error', { message: `Invalid quiz: ${errors}`, code: 'INVALID_QUIZ' });
        return;
      }

      const quizConfig = {
        id: generateQuizId(),
        title: parsed.data.title,
        questions: parsed.data.questions,
      };

      const session = store.createSession(quizConfig);
      session.adminSocketId = socket.id;

      socket.join(session.code);
      socketMeta.set(socket.id, { role: 'admin', code: session.code });

      if (typeof callback === 'function') {
        callback({ code: session.code });
      }
      socket.emit('admin:quiz_created', { code: session.code });
    });

    socket.on('admin:join_session', (data: unknown) => {
      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid code', code: 'INVALID_PAYLOAD' });
        return;
      }

      const session = store.getSession(parsed.data.code);
      if (!session) {
        socket.emit('error', { message: 'Quiz not found', code: 'NOT_FOUND' });
        return;
      }

      session.adminSocketId = socket.id;
      socket.join(session.code);
      socketMeta.set(socket.id, { role: 'admin', code: session.code });

      // Send current state for admin reconnect
      socket.emit('session:state', buildSessionState(session, true));
      socket.emit('lobby:update', buildLobbyUpdate(session));
    });

    socket.on('admin:start_quiz', (data: unknown) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid payload', code: 'INVALID_PAYLOAD' });
        return;
      }

      const session = store.getSession(parsed.data.code);
      if (!session) {
        socket.emit('error', { message: 'Quiz not found', code: 'NOT_FOUND' });
        return;
      }
      if (session.adminSocketId !== socket.id) {
        socket.emit('error', { message: 'Not authorized as admin', code: 'UNAUTHORIZED' });
        return;
      }
      if (session.phase !== 'lobby') {
        socket.emit('error', { message: 'Quiz already started', code: 'INVALID_STATE' });
        return;
      }
      if (Object.keys(session.participants).length === 0) {
        socket.emit('error', { message: 'No participants have joined', code: 'NO_PARTICIPANTS' });
        return;
      }

      session.currentQuestionIndex = 0;
      startQuestionTimer(io, session);
    });

    socket.on('admin:start_question', (data: unknown) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) return;

      const session = store.getSession(parsed.data.code);
      if (!session || session.adminSocketId !== socket.id) return;

      if (session.phase === 'question_active') {
        socket.emit('error', { message: 'Question already active', code: 'INVALID_STATE' });
        return;
      }

      startQuestionTimer(io, session);
    });

    socket.on('admin:end_question_early', (data: unknown) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) return;

      const session = store.getSession(parsed.data.code);
      if (!session || session.adminSocketId !== socket.id) return;

      if (session.phase !== 'question_active') {
        socket.emit('error', { message: 'No active question to end', code: 'INVALID_STATE' });
        return;
      }

      endQuestion(io, session);
    });

    socket.on('admin:next_question', (data: unknown) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) return;

      const session = store.getSession(parsed.data.code);
      if (!session || session.adminSocketId !== socket.id) return;

      if (session.phase !== 'question_locked') {
        socket.emit('error', { message: 'Cannot advance yet', code: 'INVALID_STATE' });
        return;
      }

      session.currentQuestionIndex++;

      if (session.currentQuestionIndex >= session.quiz.questions.length) {
        // Quiz is finished
        session.phase = 'finished';
        const finalLeaderboard = store.getLeaderboard(session.code);
        io.to(session.code).emit('quiz:finished', { finalLeaderboard });
        log('QUIZ_FINISHED', { code: session.code });
      } else {
        // Ready for next question — wait in a "ready" state
        session.phase = 'question_locked'; // stays locked until admin starts next
        session.questionStartedAt = null;
        session.questionEndsAt = null;
        io.to(session.code).emit('question:ready', {
          questionIndex: session.currentQuestionIndex,
          totalQuestions: session.quiz.questions.length,
        });
      }
    });

    socket.on('admin:end_quiz', (data: unknown) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) return;

      const session = store.getSession(parsed.data.code);
      if (!session || session.adminSocketId !== socket.id) return;

      store.clearQuestionTimer(session.code);
      session.phase = 'finished';
      const finalLeaderboard = store.getLeaderboard(session.code);
      io.to(session.code).emit('quiz:finished', { finalLeaderboard });
      log('QUIZ_FORCE_ENDED', { code: session.code });
    });

    socket.on('admin:kick_participant', (data: unknown) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = kickPayloadSchema.safeParse(data);
      if (!parsed.success) return;

      const session = store.getSession(parsed.data.code);
      if (!session || session.adminSocketId !== socket.id) return;

      const kicked = store.kickParticipant(parsed.data.code, parsed.data.participantId);
      if (kicked) {
        // Notify the kicked participant
        for (const [socketId, meta] of socketMeta.entries()) {
          if (meta.participantToken === parsed.data.participantId && meta.code === parsed.data.code) {
            io.to(socketId).emit('participant:kicked');
            const kickedSocket = io.sockets.sockets.get(socketId);
            if (kickedSocket) {
              kickedSocket.leave(parsed.data.code);
            }
            socketMeta.delete(socketId);
            break;
          }
        }
        // Update lobby
        io.to(session.code).emit('lobby:update', buildLobbyUpdate(session));
      }
    });

    // ─── Participant Events ───────────────────────────────────────────

    socket.on('participant:join', (data: unknown, callback?: Function) => {
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded', code: 'RATE_LIMITED' });
        return;
      }

      const parsed = joinPayloadSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid join data', code: 'INVALID_PAYLOAD' });
        return;
      }

      const code = parsed.data.code.toUpperCase();
      const result = store.addParticipant(code, parsed.data.name, socket.id);

      if ('error' in result) {
        socket.emit('error', { message: result.error, code: 'JOIN_FAILED' });
        return;
      }

      socket.join(code);
      socketMeta.set(socket.id, {
        role: 'participant',
        code,
        participantToken: result.token,
      });

      const session = store.getSession(code)!;

      // Ack participant with their token and session info
      const ackPayload = {
        participantToken: result.token,
        participantId: result.participant.id,
        name: result.participant.name,
        sessionState: buildSessionState(session, false),
      };

      if (typeof callback === 'function') {
        callback(ackPayload);
      }
      socket.emit('participant:joined', ackPayload);

      // Update lobby for admin + display
      io.to(code).emit('lobby:update', buildLobbyUpdate(session));
    });

    socket.on('participant:rejoin', (data: unknown, callback?: Function) => {
      if (!checkRateLimit(socket.id)) return;

      const parsed = rejoinPayloadSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid rejoin data', code: 'INVALID_PAYLOAD' });
        return;
      }

      const result = store.rejoinParticipant(parsed.data.participantToken, socket.id);

      if ('error' in result) {
        socket.emit('error', { message: result.error, code: 'REJOIN_FAILED' });
        return;
      }

      const { session, participant } = result;

      socket.join(session.code);
      socketMeta.set(socket.id, {
        role: 'participant',
        code: session.code,
        participantToken: participant.id,
      });

      const ackPayload = {
        participantToken: participant.id,
        participantId: participant.id,
        name: participant.name,
        sessionState: buildSessionState(session, false),
      };

      if (typeof callback === 'function') {
        callback(ackPayload);
      }
      socket.emit('participant:rejoined', ackPayload);

      // Update lobby
      io.to(session.code).emit('lobby:update', buildLobbyUpdate(session));
    });

    socket.on('participant:submit_answer', (data: unknown, callback?: Function) => {
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded', code: 'RATE_LIMITED' });
        return;
      }

      const parsed = submitAnswerPayloadSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid answer data', code: 'INVALID_PAYLOAD' });
        return;
      }

      const code = parsed.data.code.toUpperCase();
      const session = store.getSession(code);
      if (!session) {
        socket.emit('error', { message: 'Quiz not found', code: 'NOT_FOUND' });
        return;
      }

      if (session.phase !== 'question_active') {
        socket.emit('error', { message: 'Not accepting answers', code: 'INVALID_STATE' });
        return;
      }

      const now = Date.now();
      if (session.questionEndsAt && now > session.questionEndsAt) {
        socket.emit('error', { message: 'Time expired', code: 'TIME_EXPIRED' });
        return;
      }

      // Find participant
      const meta = socketMeta.get(socket.id);
      if (!meta || meta.role !== 'participant' || !meta.participantToken) {
        socket.emit('error', { message: 'Not a participant', code: 'UNAUTHORIZED' });
        return;
      }

      const participant = session.participants[meta.participantToken];
      if (!participant) {
        socket.emit('error', { message: 'Participant not found', code: 'NOT_FOUND' });
        return;
      }

      const question = session.quiz.questions[session.currentQuestionIndex];
      if (question.id !== parsed.data.questionId) {
        socket.emit('error', { message: 'Wrong question', code: 'INVALID_STATE' });
        return;
      }

      // Guard against double-submission
      if (participant.answers[question.id]) {
        socket.emit('error', { message: 'Already answered this question', code: 'ALREADY_ANSWERED' });
        return;
      }

      // Validate option index
      if (parsed.data.optionIndex < 0 || parsed.data.optionIndex >= question.options.length) {
        socket.emit('error', { message: 'Invalid option index', code: 'INVALID_PAYLOAD' });
        return;
      }

      // Calculate score
      const correct = parsed.data.optionIndex === question.correctIndex;
      const timeTakenMs = now - (session.questionStartedAt || now);
      const totalTimeMs = question.timeLimitSeconds * 1000;
      const remainingTimeMs = totalTimeMs - timeTakenMs;
      const pointsAwarded = correct ? calculateScore(question.points, remainingTimeMs, totalTimeMs) : 0;

      // Record answer
      participant.answers[question.id] = {
        optionIndex: parsed.data.optionIndex,
        correct,
        timeTakenMs,
        pointsAwarded,
      };
      participant.score += pointsAwarded;

      // Ack — confirm locked in, but do NOT reveal correctness
      const ack = { lockedIn: true, questionId: question.id };
      if (typeof callback === 'function') {
        callback(ack);
      }
      socket.emit('participant:answer_locked', ack);

      // Notify admin + display of updated answer count
      const answeredCount = store.getAnsweredCount(code, question.id);
      const totalParticipants = Object.keys(session.participants).length;
      io.to(code).emit('question:answer_count', {
        answeredCount,
        totalParticipants,
      });

      log('ANSWER_SUBMITTED', {
        code,
        questionId: question.id,
        participant: participant.name,
        correct,
        pointsAwarded,
        timeTakenMs,
      });
    });

    // ─── Display Events ───────────────────────────────────────────────

    socket.on('display:join', (data: unknown) => {
      const parsed = codePayloadSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid code', code: 'INVALID_PAYLOAD' });
        return;
      }

      const code = parsed.data.code.toUpperCase();
      const session = store.getSession(code);
      if (!session) {
        socket.emit('error', { message: 'Quiz not found', code: 'NOT_FOUND' });
        return;
      }

      socket.join(code);
      socketMeta.set(socket.id, { role: 'display', code });

      // Send current session state
      socket.emit('session:state', buildSessionState(session, false));
      socket.emit('lobby:update', buildLobbyUpdate(session));
    });

    // ─── Disconnect Handling ──────────────────────────────────────────

    socket.on('disconnect', () => {
      const meta = socketMeta.get(socket.id);
      if (meta) {
        if (meta.role === 'participant' && meta.participantToken) {
          store.disconnectParticipant(meta.participantToken);
          const session = store.getSession(meta.code);
          if (session) {
            io.to(meta.code).emit('lobby:update', buildLobbyUpdate(session));
          }
        } else if (meta.role === 'admin') {
          const session = store.getSession(meta.code);
          if (session) {
            // Don't clear adminSocketId — allow reconnect
            log('ADMIN_DISCONNECTED', { code: meta.code });
          }
        }
        socketMeta.delete(socket.id);
      }

      socketRateLimits.delete(socket.id);
      log('SOCKET_DISCONNECTED', { socketId: socket.id });
    });
  });
}
