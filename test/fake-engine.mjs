import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return send({ id: request.id, result: { capabilities: { tools: {} } } });
  if (request.method === 'notifications/cancelled') return send({ method: 'cancel-observed', params: request.params });
  if (request.method !== 'tools/call') return;
  if (request.params.arguments.hang) return;
  send({ id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] } });
});
