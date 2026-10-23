import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'computer-use';
export const SKILL_DIRECTORY = fileURLToPath(new URL('../skills/computer-use/', import.meta.url));
const file = new URL('../skills/computer-use/SKILL.md', import.meta.url);
const description = 'computer use — 用户须明确提出使用 computer use/桌面控制或同意此前申请；只描述窗口输入点击目标不算授权，应先询问。授权当前任务后，且能显著提高完成/验收质量、明显减轻工作或任务必需时才加载。优先使用足够的 API、文件和命令行工具，普通任务不自动加载。';
const summary = {
  name: SKILL_NAME, description, provider: 'dsh-desktop-control', source: 'bundled',
  invocation: { modelInvocable: true, userInvocable: true },
  resourceBase: { kind: 'directory', path: SKILL_DIRECTORY },
};

// Package-owned provider: no global skill copies, profile edits or npm imports.
// Cordis owns registration/disposal and DSH's normal precedence still applies.
export function createSkillProvider() {
  return {
    name: summary.provider,
    list: async () => [{ ...summary, rank: 600, locator: SKILL_NAME }],
    async get(candidate, options = {}) {
      if (candidate.locator !== SKILL_NAME) return undefined;
      const raw = await readFile(file, { encoding: 'utf8', signal: options.signal });
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
      if (!header || !/^name:\s*computer-use\s*$/mu.test(header[1])) throw new Error('computer-use 技能文件缺失或名称不匹配。');
      return { ...summary, path: fileURLToPath(file), content: raw.slice(header[0].length).trim() };
    },
  };
}
