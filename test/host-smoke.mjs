import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactsDir } from './paths.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTools } from '../lib/tools.js';
import plugin, { createRoute } from '../lib/index.js';

const runtime = process.env.DSH_TEST_RUNTIME;
if (!runtime || !path.isAbsolute(runtime)) throw Error('Set DSH_TEST_RUNTIME to an extracted DSH runtime directory containing node_modules.');
const load = name => import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime, assertSupportedJsonSchema, validateJsonSchemaValue }, { default: LocalAttachmentStore }, { default: SkillRegistry }] = await Promise.all([load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-attachment-local'), load('dsh-skill')]);
const artifacts = path.join(artifactsDir, 'host-' + Date.now());
await fs.mkdir(artifacts, { recursive: true });
const previous = process.env.DSH_HOME;
const previousTemp = process.env.TEMP, previousTmp = process.env.TMP;
process.env.DSH_HOME = artifacts;
process.env.TEMP = artifacts; process.env.TMP = artifacts;
// ctx-owned services are real; only the transport and model metadata are local
// fixtures. No profile, credentials, model API or existing sessions are opened.
const ctx = new Context();
const routes = new Map();
ctx.reflect.provide('connection', { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } });
ctx.reflect.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) });
try {
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(LocalAttachmentStore, { dshHome: artifacts }).await();
  await ctx.plugin(SkillRegistry).await();
  const fiber = ctx.plugin(plugin); await fiber.await();
  assert.equal(fiber.state, 2);
  assert.equal(ctx.tools.schemas().length, 11);
  const skill = await ctx.skills.get('computer-use');
  assert.equal(skill.name, 'computer-use');
  assert.equal(skill.provider, 'dsh-desktop-control');
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.ok(skill.content.startsWith('# computer use'));
  assert.ok((await ctx.skills.list()).some(item => item.name === 'computer-use' && item.invocation.modelInvocable && item.invocation.userInvocable));
  for (const tool of createTools({})) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema); }
  const assembly = await ctx.systemPrompt.assemble();
  assert.ok(assembly.sections.some(section => section.name === 'desktop-control'));
  const route = routes.get('/api/plugins/desktop-control'); assert.ok(route);
  const status = await (await route.fetch(new Request('http://localhost/api/plugins/desktop-control'))).json();
  assert.equal(status.settings.enabled, true);
  // Genuine image persistence and request re-encoding, followed by the real
  // ToolRuntime output validator/projector, not a text-only image surrogate.
  const sharp = createRequire(path.join(runtime, 'package.json'))('sharp');
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#7070d0' } }).png().toBuffer();
  const image = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'fixture.png' });
  const sample = { text: '{"ok":true}', images: [image] };
  const definition = createTools({ run: async () => sample })[3];
  definition.name = 'desktop_fixture_image';
  const dispose = ctx.tools.register(definition);
  const execution = await ctx.tools.execute({ name: definition.name, arguments: { window: 1, authorizationId: 'fixture-token' }, callId: 'fixture-image', signal: new AbortController().signal });
  assert.equal(execution.isError, false);
  assert.ok(execution.content.some(block => block.type === 'image' && block.attachment.attachmentId === image.attachmentId), JSON.stringify(execution));
  assert.deepEqual(validateJsonSchemaValue(definition.output.schema, sample), []);
  const requestImage = await ctx.attachments.readImageRequest(image, { width: 1, height: 1, maxBytes: 1024 * 1024 }, new AbortController().signal);
  assert.ok(requestImage);
  dispose();
  await route.fetch(new Request('http://localhost/api/plugins/desktop-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, screenshotWidth: 960 }) }));
  const paused = await (await route.fetch(new Request('http://localhost/api/plugins/desktop-control'))).json(); assert.equal(paused.settings.enabled, false);
  await fiber.dispose();
  assert.equal(ctx.tools.schemas().length, 0); assert.equal(routes.size, 0);
  assert.equal(await ctx.skills.get('computer-use'), undefined);
  console.log(JSON.stringify({ ok: true, toolCount: 11, skill: 'computer-use', imageAttachment: true, imageRequest: true, prompt: true, disposal: true, artifacts }));
} finally {
  await ctx.fiber.dispose();
  for (const [key, value] of Object.entries({ DSH_HOME: previous, TEMP: previousTemp, TMP: previousTmp })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
