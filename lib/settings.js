export const DEFAULTS = Object.freeze({ enabled: true, screenshotWidth: 1280 });
export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是对象。');
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('配置包含未知字段。');
  const settings = { ...DEFAULTS, ...value };
  if (typeof settings.enabled !== 'boolean') throw new Error('enabled 必须是布尔值。');
  if (![960, 1280, 1600, 1920].includes(settings.screenshotWidth)) throw new Error('截图宽度须为 960、1280、1600 或 1920。');
  return settings;
}
