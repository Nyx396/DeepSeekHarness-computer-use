import os from 'node:os';
import path from 'node:path';
import { DesktopController } from './controller.js';
import { createTools, GUIDANCE } from './tools.js';
import { createSkillProvider } from './skill.js';

export const name = 'dsh-desktop-control';
export const inject = ['tools', 'attachments', 'llm', 'connection', 'systemPrompt', 'skills'];
export const ROUTE = '/api/plugins/desktop-control';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export function resolveDataHome(value = process.env.DSH_HOME) {
  const configured = typeof value === 'string' && value.trim() ? value : path.join(os.homedir(), '.dsh');
  const expanded = configured === '~' ? os.homedir() : /^~[/\\]/u.test(configured) ? path.join(os.homedir(), configured.slice(2)) : configured;
  return path.resolve(expanded);
}

export function createRoute(controller) {
  return { path: ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: '需要 JSON 配置。' }, 415);
        const text = await request.text();
        if (text.length > 1024) return json({ error: '配置过大。' }, 413);
        await controller.saveSettings(JSON.parse(text));
      }
      return json(await controller.status());
    } catch (error) { return json({ error: error.message }, 400); }
  } };
}
export async function apply(ctx) {
  const controller = new DesktopController(ctx, { configPath: path.join(resolveDataHome(), 'dsh-desktop-control.json') });
  await controller.init();
  ctx.effect(() => () => controller.close());
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider()));
  for (const tool of createTools(controller)) ctx.effect(() => ctx.tools.register(tool));
  ctx.effect(() => ctx.connection.fetch.register(createRoute(controller)));
  ctx.effect(() => ctx.systemPrompt.section({ name: 'desktop-control', order: 75, interpolate: false, text: () => controller.settings.enabled ? GUIDANCE : 'Desktop control is paused in plugin settings. Do not attempt desktop input.' }));
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') return controller.release(session.id, event.data.turn);
  }, { global: true });
}
export default { name, inject, apply };
