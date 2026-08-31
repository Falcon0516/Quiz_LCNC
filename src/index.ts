// ─── Server Entry Point ─────────────────────────────────────────────────────

import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import routes from './routes';
import { setupSocketHandlers } from './socket-handlers';
import { log } from './utils';

const app = express();
const server = http.createServer(app);

// ─── CORS ───────────────────────────────────────────────────────────────────

app.use(cors({
  origin: config.allowedOrigins,
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// ─── Rate Limiting (REST) ───────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later' },
});

app.use('/api', apiLimiter);

// ─── Routes ─────────────────────────────────────────────────────────────────

app.use(routes);

// ─── Socket.IO ──────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: config.socketIO.pingInterval,
  pingTimeout: config.socketIO.pingTimeout,
  // Allow polling fallback for unreliable classroom wifi
  transports: ['websocket', 'polling'],
});

setupSocketHandlers(io);

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function gracefulShutdown(signal: string): void {
  log('SHUTDOWN_INITIATED', { signal });

  // Notify all connected clients
  io.emit('server:shutdown', { message: 'Server is shutting down, please wait…' });

  // Give clients a moment to receive the notification
  setTimeout(() => {
    io.close(() => {
      log('SOCKET_IO_CLOSED');
      server.close(() => {
        log('HTTP_SERVER_CLOSED');
        process.exit(0);
      });
    });
  }, 1000);

  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => {
    log('FORCED_SHUTDOWN');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start Server ───────────────────────────────────────────────────────────

server.listen(config.port, () => {
  log('SERVER_STARTED', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});

export { app, server, io };
