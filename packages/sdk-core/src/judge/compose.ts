/**
 * 可插拔判断器：L0 规则是永久地板；可选 L1（本机 OpenAI 兼容模型）只能加严或补漏，不能降级。
 */
import {
  judgeByRules,
  TAG_WHITELIST,
  type JudgeInput,
  type JudgeResult,
  type MemoryType,
  type PermissionLevel,
} from "./rules.js";

export type Judge = (input: JudgeInput) => Promise<JudgeResult>;

const MEMORY_TYPES = new Set<MemoryType>([
  "profile",
  "preference",
  "entity",
  "event",
  "relationship",
  "skill",
  "task",
  "temporary",
]);

/** 同步 L0 的异步包装；未配置 L1 时 MemoryService 默认走它。 */
export const rulesJudge: Judge = async (input) => judgeByRules(input);

function clampLevel(n: number): PermissionLevel {
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(4, Math.round(n))) as PermissionLevel;
}

function sanitizeTags(tags: string[]): string[] {
  return [...new Set(tags.filter((t) => TAG_WHITELIST.has(t)))];
}

function mergeJudge(
  floor: JudgeResult,
  extra: JudgeResult,
  input: JudgeInput,
): JudgeResult {
  const permissionLevel = clampLevel(
    Math.max(floor.permissionLevel, extra.permissionLevel),
  );
  const shouldStore =
    input.explicit === true || floor.shouldStore || extra.shouldStore;

  const keepFloorType =
    floor.permissionLevel >= 3 ||
    floor.sensitiveTags.length > 0 ||
    !MEMORY_TYPES.has(extra.type);
  const type: MemoryType = keepFloorType ? floor.type : extra.type;

  const tags = sanitizeTags([...floor.tags, ...extra.tags]);
  const sensitiveTags = [
    ...new Set([...floor.sensitiveTags, ...extra.sensitiveTags]),
  ];

  let outType = type;
  if (outType === "temporary" && shouldStore) outType = "event";

  return {
    shouldStore,
    type: outType,
    permissionLevel,
    tags,
    sensitiveTags,
    importance: Math.max(floor.importance, extra.importance),
    reason: `${floor.reason}+${extra.reason}`,
    engineVersion: `${floor.engineVersion}+${extra.engineVersion}`,
  };
}

/**
 * L0 始终先跑。L1 失败 / 超时则只用 L0。
 * permissionLevel 取 max；L0 命中凭证/敏感时类型不得被模型改掉。
 */
export function composeJudge(l0: Judge, l1?: Judge): Judge {
  if (!l1) return l0;
  return async (input) => {
    const floor = await l0(input);
    try {
      const extra = await l1(input);
      return mergeJudge(floor, extra, input);
    } catch {
      return floor;
    }
  };
}
