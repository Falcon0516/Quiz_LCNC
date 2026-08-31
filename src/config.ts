import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  adminPasscode: process.env.ADMIN_PASSCODE || 'changeme123',
  socketIO: {
    pingInterval: 25000,  // 25s — reasonable for classroom wifi
    pingTimeout: 60000,   // 60s — generous for occasional drops
  },
};
