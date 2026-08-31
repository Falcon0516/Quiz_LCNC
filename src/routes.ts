import { Router, Request, Response } from 'express';
import { store } from './store';
import { quizConfigSchema } from './schema';
import { generateQuizId, log } from './utils';
import { config } from './config';

const router = Router();

// ─── Health Check ───────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Admin Auth ─────────────────────────────────────────────────────────────

router.post('/api/admin/auth', (req: Request, res: Response) => {
  const { passcode } = req.body;
  if (passcode === config.adminPasscode) {
    // Simple token — not cryptographically secure, but sufficient for classroom use
    const token = Buffer.from(`admin:${Date.now()}:${config.adminPasscode}`).toString('base64');
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid passcode' });
  }
});

// Middleware to verify admin token
export function verifyAdmin(req: Request, res: Response, next: Function): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Admin authentication required' });
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    if (decoded.startsWith('admin:') && decoded.endsWith(`:${config.adminPasscode}`)) {
      next();
    } else {
      res.status(401).json({ message: 'Invalid admin token' });
    }
  } catch {
    res.status(401).json({ message: 'Invalid admin token' });
  }
}

// ─── Create Quiz Session ────────────────────────────────────────────────────

router.post('/api/quizzes', verifyAdmin, (req: Request, res: Response) => {
  const result = quizConfigSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      message: 'Invalid quiz configuration',
      errors: result.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  const quizConfig = {
    id: generateQuizId(),
    title: result.data.title,
    questions: result.data.questions,
  };

  try {
    const session = store.createSession(quizConfig);
    res.status(201).json({ code: session.code, title: session.quiz.title });
  } catch (err: any) {
    log('ERROR_CREATE_SESSION', { error: err.message });
    res.status(500).json({ message: 'Failed to create quiz session' });
  }
});

// ─── Check Session Exists ───────────────────────────────────────────────────

router.get('/api/quizzes/:code', (req: Request, res: Response) => {
  const { code } = req.params;
  const session = store.getSession(code.toUpperCase());
  if (!session) {
    res.status(404).json({ message: 'Quiz not found' });
    return;
  }
  res.json({
    code: session.code,
    title: session.quiz.title,
    phase: session.phase,
    participantCount: Object.keys(session.participants).length,
  });
});

export default router;
