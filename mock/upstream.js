// Mock new-api upstream for local testing — emulates /v1/models and
// /v1/chat/completions (SSE + non-stream). Requires Authorization: Bearer <key>.
const http = require('http');

const MODELS = ['gpt-4o-mini', 'claude-3-5-haiku-20241022', 'deepseek-chat'];

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'missing key' } }));
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
    }));
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad json' } }));
    }
    if (!MODELS.includes(parsed.model)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `unknown model ${parsed.model}` } }));
    }

    const last = (parsed.messages || []).filter((m) => m.role === 'user').pop();
    const reply = `You said: "${(last?.content || '').slice(0, 120)}" — I'm the mock ${parsed.model}. Everything works end-to-end. 🎉`;

    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const words = reply.split(' ');
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 60));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: reply } }],
    }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(3000, '127.0.0.1', () => console.log('mock new-api upstream on http://127.0.0.1:3000'));
