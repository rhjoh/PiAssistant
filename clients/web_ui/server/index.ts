import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// Serve static files from dist folder
app.use(express.static(resolve(__dirname, '../dist')));

// Fallback to index.html for SPA
app.get('*', (_req, res) => {
  res.sendFile(resolve(__dirname, '../dist/index.html'));
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});
