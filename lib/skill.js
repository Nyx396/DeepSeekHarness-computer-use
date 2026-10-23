import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'computer-use';
export const SKILL_DIRECTORY = fileURLToPath(new URL('../skills/computer-use/', import.meta.url));
const file = new URL('../skills/computer-use/SKILL.md', import.meta.url);
const description = 'computer use — 普通任务仅在显著提高质量、减轻工作或任务必需时使用，优先 API/文件/命令行。用户明确指定桌面操作方法或测试时，按指定步骤实际使用桌面工具，不得仅加载后用命令或文件操作替代。普通权限须明确授权；宿主完全访问可免首次审批。Esc 后均须人工恢复确认，不得自行重启或重复尝试。';
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
