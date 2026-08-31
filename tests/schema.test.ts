import { describe, it, expect } from 'vitest';
import { quizConfigSchema, questionSchema, joinPayloadSchema, submitAnswerPayloadSchema } from '../src/schema';

describe('questionSchema', () => {
  it('validates a correct question', () => {
    const result = questionSchema.safeParse({
      id: 'q1',
      question: 'What is 2+2?',
      options: ['3', '4', '5', '6'],
      correctIndex: 1,
      timeLimitSeconds: 20,
      points: 100,
    });
    expect(result.success).toBe(true);
  });

  it('rejects correctIndex out of range', () => {
    const result = questionSchema.safeParse({
      id: 'q1',
      question: 'What is 2+2?',
      options: ['3', '4', '5'],
      correctIndex: 3,
      timeLimitSeconds: 20,
      points: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('correctIndex 3 is out of range for 3 options');
    }
  });

  it('rejects fewer than 2 options', () => {
    const result = questionSchema.safeParse({
      id: 'q1',
      question: 'What is 2+2?',
      options: ['4'],
      correctIndex: 0,
      timeLimitSeconds: 20,
      points: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 6 options', () => {
    const result = questionSchema.safeParse({
      id: 'q1',
      question: 'What is 2+2?',
      options: ['1', '2', '3', '4', '5', '6', '7'],
      correctIndex: 0,
      timeLimitSeconds: 20,
      points: 100,
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional imageUrl', () => {
    const result = questionSchema.safeParse({
      id: 'q1',
      question: 'What animal is this?',
      options: ['Cat', 'Dog'],
      correctIndex: 0,
      timeLimitSeconds: 15,
      points: 100,
      imageUrl: 'https://example.com/cat.jpg',
    });
    expect(result.success).toBe(true);
  });

  it('rejects timer less than 5 seconds', () => {
    const result = questionSchema.safeParse({
      id: 'q1',
      question: 'Quick!',
      options: ['A', 'B'],
      correctIndex: 0,
      timeLimitSeconds: 3,
      points: 100,
    });
    expect(result.success).toBe(false);
  });
});

describe('quizConfigSchema', () => {
  const validQuestion = {
    id: 'q1',
    question: 'What is 2+2?',
    options: ['3', '4', '5', '6'],
    correctIndex: 1,
    timeLimitSeconds: 20,
    points: 100,
  };

  it('validates a correct quiz config', () => {
    const result = quizConfigSchema.safeParse({
      title: 'Test Quiz',
      questions: [validQuestion],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate question IDs', () => {
    const result = quizConfigSchema.safeParse({
      title: 'Test Quiz',
      questions: [
        { ...validQuestion, id: 'q1' },
        { ...validQuestion, id: 'q1' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('unique');
    }
  });

  it('rejects empty questions array', () => {
    const result = quizConfigSchema.safeParse({
      title: 'Test Quiz',
      questions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = quizConfigSchema.safeParse({
      title: '',
      questions: [validQuestion],
    });
    expect(result.success).toBe(false);
  });
});

describe('joinPayloadSchema', () => {
  it('validates correct join payload', () => {
    const result = joinPayloadSchema.safeParse({ code: 'K7QX2A', name: 'Alice' });
    expect(result.success).toBe(true);
  });

  it('rejects short code', () => {
    const result = joinPayloadSchema.safeParse({ code: 'ABC', name: 'Alice' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = joinPayloadSchema.safeParse({ code: 'K7QX2A', name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects name over 30 chars', () => {
    const result = joinPayloadSchema.safeParse({
      code: 'K7QX2A',
      name: 'A'.repeat(31),
    });
    expect(result.success).toBe(false);
  });
});

describe('submitAnswerPayloadSchema', () => {
  it('validates correct answer payload', () => {
    const result = submitAnswerPayloadSchema.safeParse({
      code: 'K7QX2A',
      questionId: 'q1',
      optionIndex: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative option index', () => {
    const result = submitAnswerPayloadSchema.safeParse({
      code: 'K7QX2A',
      questionId: 'q1',
      optionIndex: -1,
    });
    expect(result.success).toBe(false);
  });
});
