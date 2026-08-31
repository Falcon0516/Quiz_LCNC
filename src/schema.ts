import { z } from 'zod';

// ─── Question Schema ────────────────────────────────────────────────────────

export const questionSchema = z.object({
  id: z.string().min(1, 'Question id is required'),
  question: z.string().min(1, 'Question text is required'),
  options: z
    .array(z.string().min(1, 'Option text cannot be empty'))
    .min(2, 'At least 2 options are required')
    .max(6, 'At most 6 options are allowed'),
  correctIndex: z.number().int().min(0),
  timeLimitSeconds: z.number().int().min(5, 'Timer must be at least 5 seconds').max(300),
  points: z.number().int().min(1, 'Points must be at least 1'),
  imageUrl: z.string().url().optional(),
}).refine(
  (q) => q.correctIndex < q.options.length,
  (q) => ({
    message: `Question ${q.id}: correctIndex ${q.correctIndex} is out of range for ${q.options.length} options`,
  })
);

// ─── Quiz Config Schema ─────────────────────────────────────────────────────

export const quizConfigSchema = z.object({
  title: z.string().min(1, 'Quiz title is required'),
  questions: z
    .array(questionSchema)
    .min(1, 'At least 1 question is required')
    .max(100, 'At most 100 questions are allowed'),
}).refine(
  (config) => {
    const ids = config.questions.map((q) => q.id);
    return new Set(ids).size === ids.length;
  },
  { message: 'All question IDs must be unique within a quiz' }
);

// ─── Socket Event Payload Schemas ───────────────────────────────────────────

export const joinPayloadSchema = z.object({
  code: z.string().length(6, 'Join code must be 6 characters'),
  name: z.string().min(1, 'Name is required').max(30, 'Name must be 30 characters or less'),
});

export const rejoinPayloadSchema = z.object({
  code: z.string().length(6),
  participantToken: z.string().min(1),
});

export const codePayloadSchema = z.object({
  code: z.string().length(6),
});

export const submitAnswerPayloadSchema = z.object({
  code: z.string().length(6),
  questionId: z.string().min(1),
  optionIndex: z.number().int().min(0),
});

export const kickPayloadSchema = z.object({
  code: z.string().length(6),
  participantId: z.string().min(1),
});

export const adminAuthPayloadSchema = z.object({
  passcode: z.string().min(1),
});

// ─── Type Exports ───────────────────────────────────────────────────────────

export type QuizConfigInput = z.infer<typeof quizConfigSchema>;
export type JoinPayload = z.infer<typeof joinPayloadSchema>;
export type RejoinPayload = z.infer<typeof rejoinPayloadSchema>;
export type CodePayload = z.infer<typeof codePayloadSchema>;
export type SubmitAnswerPayload = z.infer<typeof submitAnswerPayloadSchema>;
export type KickPayload = z.infer<typeof kickPayloadSchema>;
