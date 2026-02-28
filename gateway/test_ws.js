const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3456');

ws.on('open', () => {
  console.log('Connected to gateway');
  ws.send(JSON.stringify({ type: 'prompt', message: 'Say "Token test successful" and nothing else.' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg.type);
  if (msg.type === 'done') {
    console.log('Response done! Token usage:', JSON.stringify(msg.data?.usage, null, 2));
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('Timeout');
  process.exit(1);
}, 30000);
