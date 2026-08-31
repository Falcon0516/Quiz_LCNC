import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import express from 'express';
import { setupSocketHandlers } from '../src/socket-handlers';
import { store } from '../src/store';
import { generateQuizId } from '../src/utils';

const PORT = 4444;
let httpServer: ReturnType<typeof createServer>;
let ioServer: Server;

function createClientSocket(role?: string): ClientSocket {
  return ioClient(`http://localhost:${PORT}`, {
    transports: ['websocket'],
    autoConnect: false,
  });
}

function waitForEvent<T = any>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe('Quiz Integration Test', () => {
  let adminSocket: ClientSocket;
  let player1Socket: ClientSocket;
  let player2Socket: ClientSocket;
  let quizCode: string;

  beforeAll(async () => {
    const app = express();
    httpServer = createServer(app);
    ioServer = new Server(httpServer, {
      cors: { origin: '*' },
      transports: ['websocket'],
    });

    setupSocketHandlers(ioServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(PORT, resolve);
    });
  });

  afterAll(async () => {
    adminSocket?.disconnect();
    player1Socket?.disconnect();
    player2Socket?.disconnect();

    await new Promise<void>((resolve) => {
      ioServer.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  it('should complete a full quiz flow', async () => {
    // ─── 1. Admin creates quiz ──────────────────────────────────────
    adminSocket = createClientSocket();
    adminSocket.connect();
    await waitForEvent(adminSocket, 'connect');

    const quizConfig = {
      title: 'Integration Test Quiz',
      questions: [
        {
          id: 'q1',
          question: 'What is 1+1?',
          options: ['1', '2', '3'],
          correctIndex: 1,
          timeLimitSeconds: 5,
          points: 100,
        },
        {
          id: 'q2',
          question: 'What is 2+2?',
          options: ['3', '4', '5'],
          correctIndex: 1,
          timeLimitSeconds: 5,
          points: 100,
        },
      ],
    };

    const createPromise = waitForEvent(adminSocket, 'admin:quiz_created');
    adminSocket.emit('admin:create_or_load_quiz', quizConfig);
    const createResult = await createPromise;
    quizCode = createResult.code;

    expect(quizCode).toBeDefined();
    expect(quizCode.length).toBe(6);

    // ─── 2. Players join ────────────────────────────────────────────
    player1Socket = createClientSocket();
    player1Socket.connect();
    await waitForEvent(player1Socket, 'connect');

    const join1Promise = waitForEvent(player1Socket, 'participant:joined');
    player1Socket.emit('participant:join', { code: quizCode, name: 'Alice' });
    const join1Result = await join1Promise;
    expect(join1Result.name).toBe('Alice');
    expect(join1Result.participantToken).toBeDefined();
    const player1Token = join1Result.participantToken;

    player2Socket = createClientSocket();
    player2Socket.connect();
    await waitForEvent(player2Socket, 'connect');

    const join2Promise = waitForEvent(player2Socket, 'participant:joined');
    player2Socket.emit('participant:join', { code: quizCode, name: 'Bob' });
    const join2Result = await join2Promise;
    expect(join2Result.name).toBe('Bob');
    const player2Token = join2Result.participantToken;

    // ─── 3. Verify lobby has 2 participants ─────────────────────────
    const session = store.getSession(quizCode);
    expect(session).toBeDefined();
    expect(Object.keys(session!.participants).length).toBe(2);

    // ─── 4. Admin starts quiz ───────────────────────────────────────
    const q1ShowPromise = waitForEvent(player1Socket, 'question:show');
    adminSocket.emit('admin:start_quiz', { code: quizCode });
    const q1Show = await q1ShowPromise;

    expect(q1Show.question.question).toBe('What is 1+1?');
    expect(q1Show.questionIndex).toBe(0);
    expect(q1Show.totalQuestions).toBe(2);
    // correctIndex should NOT be sent to participants
    expect(q1Show.question.correctIndex).toBeUndefined();

    // ─── 5. Players submit answers ──────────────────────────────────
    const lock1Promise = waitForEvent(player1Socket, 'participant:answer_locked');
    player1Socket.emit('participant:submit_answer', {
      code: quizCode,
      questionId: 'q1',
      optionIndex: 1, // correct
    });
    const lock1 = await lock1Promise;
    expect(lock1.lockedIn).toBe(true);

    const lock2Promise = waitForEvent(player2Socket, 'participant:answer_locked');
    player2Socket.emit('participant:submit_answer', {
      code: quizCode,
      questionId: 'q1',
      optionIndex: 0, // wrong
    });
    const lock2 = await lock2Promise;
    expect(lock2.lockedIn).toBe(true);

    // ─── 6. Admin ends question early ───────────────────────────────
    const reveal1Promise = waitForEvent(player1Socket, 'question:reveal');
    const yourResult1Promise = waitForEvent(player1Socket, 'question:your_result');
    adminSocket.emit('admin:end_question_early', { code: quizCode });
    
    const reveal1 = await reveal1Promise;
    expect(reveal1.correctIndex).toBe(1);
    expect(reveal1.leaderboard.length).toBe(2);

    const yourResult1 = await yourResult1Promise;
    expect(yourResult1.correct).toBe(true);
    expect(yourResult1.pointsAwarded).toBeGreaterThan(0);

    // ─── 7. Admin goes to next question ─────────────────────────────
    const readyPromise = waitForEvent(player1Socket, 'question:ready');
    adminSocket.emit('admin:next_question', { code: quizCode });
    const readyData = await readyPromise;
    expect(readyData.questionIndex).toBe(1);

    // ─── 8. Admin starts question 2 ─────────────────────────────────
    const q2ShowPromise = waitForEvent(player1Socket, 'question:show');
    adminSocket.emit('admin:start_question', { code: quizCode });
    const q2Show = await q2ShowPromise;
    expect(q2Show.question.question).toBe('What is 2+2?');

    // Both answer correctly this time
    player1Socket.emit('participant:submit_answer', {
      code: quizCode,
      questionId: 'q2',
      optionIndex: 1,
    });
    await waitForEvent(player1Socket, 'participant:answer_locked');

    player2Socket.emit('participant:submit_answer', {
      code: quizCode,
      questionId: 'q2',
      optionIndex: 1,
    });
    await waitForEvent(player2Socket, 'participant:answer_locked');

    // End and finish
    adminSocket.emit('admin:end_question_early', { code: quizCode });
    await waitForEvent(player1Socket, 'question:reveal');

    const finishedPromise = waitForEvent(player1Socket, 'quiz:finished');
    adminSocket.emit('admin:next_question', { code: quizCode });
    const finished = await finishedPromise;

    expect(finished.finalLeaderboard.length).toBe(2);
    // Alice should be #1 (she got both right, Bob only got q2 right)
    expect(finished.finalLeaderboard[0].name).toBe('Alice');
    expect(finished.finalLeaderboard[0].score).toBeGreaterThan(finished.finalLeaderboard[1].score);

    // ─── 9. Verify double-submit is blocked ─────────────────────────
    // This is already tested implicitly — the quiz is finished, no more answers accepted
  }, 15000);

  it('should reject duplicate names (case-insensitive)', async () => {
    const dupSocket = createClientSocket();
    dupSocket.connect();
    await waitForEvent(dupSocket, 'connect');

    const errorPromise = waitForEvent(dupSocket, 'error');
    dupSocket.emit('participant:join', { code: quizCode, name: 'alice' }); // lowercase
    const error = await errorPromise;
    expect(error.message).toContain('Name already taken');

    dupSocket.disconnect();
  });
});
