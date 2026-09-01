/**
 * L0 规则判断引擎（方案 §8.2 Phase 1）。
 *
 * 判断"值不值得存、什么类型、什么权限级别、什么标签"，全部本地完成，
 * 明文不出设备。L0 是永久兜底：即使 L1/L2 模型不可用，显式保存永远可用。
 *
 * 权限级别 0-4：
 *   0 公开可分享 / 1 团队可分享 / 2 默认（授权 Agent 可读）
 *   3 敏感（需显式授权）/ 4 高度敏感（默认不参与任何自动共享，PIPL 映射）
 */

export type MemoryType =
  | "profile"
  | "preference"
  | "entity"
  | "event"
  | "relationship"
  | "skill"
  | "task"
  | "temporary";

export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

export interface JudgeInput {
  text: string;
  /** 显式保存（用户对 Agent 说"记住这个" / MCP save_memory 直接调用） */
  explicit?: boolean;
  sourceAgent?: string;
  sourceSession?: string;
}

export interface JudgeResult {
  shouldStore: boolean;
  type: MemoryType;
  permissionLevel: PermissionLevel;
  /** 仅脱敏类别级标签，必须落在白名单内（敏感标签走 encrypted_tags） */
  tags: string[];
  /** 命中的敏感标签（写入 encrypted_tags，禁入明文 tags 列） */
  sensitiveTags: string[];
  importance: number;
  reason: string;
  engineVersion: string;
}

export const L0_ENGINE_VERSION = "mb-judge-l0-rules-v1";

/** 类别级标签白名单（方案 §3.3：写入侧 SDK 强制校验） */
export const TAG_WHITELIST = new Set([
  "work",
  "finance",
  "personal",
  "health",
  "tech",
  "travel",
  "family",
  "legal",
  "study",
  "project",
]);

interface Rule {
  name: string;
  pattern: RegExp;
  type?: MemoryType;
  permissionLevel?: PermissionLevel;
  tags?: string[];
  sensitiveTags?: string[];
  importance?: number;
  forceStore?: boolean;
}

/** 规则按优先级从上到下匹配，命中即定级；多条命中取最高权限级别。 */
const RULES: Rule[] = [
  // —— Level 4 高度敏感：凭证/证件/密钥 ——
  {
    name: "credential",
    pattern:
      /(密码|口令|私钥|助记词|密钥|身份证|护照|银行卡|信用卡|社保|cvv|password|passwd|secret\s*key|private\s*key|api\s*key|token|ssn|passport)/i,
    permissionLevel: 4,
    sensitiveTags: ["credential"],
    importance: 0.9,
    forceStore: true,
  },
  // —— Level 3 敏感：健康/财务细节 ——
  {
    name: "health",
    pattern: /(体检|病历|诊断|用药|过敏|血压|血糖|诊断|hospital|diagnosis|allergy)/i,
    permissionLevel: 3,
    tags: ["health"],
    sensitiveTags: ["health-detail"],
    importance: 0.8,
    forceStore: true,
  },
  {
    name: "finance-detail",
    pattern: /(工资|月薪|年薪|存款|欠款|贷款|账户余额|salary|mortgage|loan)/i,
    permissionLevel: 3,
    tags: ["finance"],
    sensitiveTags: ["finance-detail"],
    importance: 0.7,
  },
  // —— 偏好与画像（默认 Level 2） ——
  {
    name: "explicit-remember",
    pattern: /(记住|帮我记|别忘了|请记住|remember this|keep in mind)/i,
    type: "preference",
    permissionLevel: 2,
    importance: 0.8,
    forceStore: true,
  },
  {
    name: "preference",
    pattern: /(我喜欢|我不喜欢|我讨厌|我偏好|习惯用|更喜欢|i prefer|i like|i hate|my favorite)/i,
    type: "preference",
    permissionLevel: 2,
    importance: 0.7,
    forceStore: true,
  },
  {
    name: "profile",
    pattern: /(我叫|我的名字是|我是.{0,12}(工程师|设计师|经理|学生|医生|律师)|我在.{1,20}工作|my name is|i am a|i work (at|for))/i,
    type: "profile",
    permissionLevel: 2,
    importance: 0.75,
    forceStore: true,
  },
  {
    name: "task",
    pattern: /(待办|提醒我|明天要|下周要|todo|remind me|deadline|截止)/i,
    type: "task",
    permissionLevel: 2,
    importance: 0.65,
  },
  {
    name: "relationship",
    pattern: /(我(老婆|丈夫|老公|妻子|儿子|女儿|父亲|母亲|同事|老板|客户)|my (wife|husband|son|daughter|colleague|manager|client))/i,
    type: "relationship",
    permissionLevel: 2,
    tags: ["family"],
    importance: 0.6,
  },
  {
    name: "tech-pref",
    pattern: /(用\s?(typescript|rust|python|go|react|vue)|技术栈|框架用|database|tech stack)/i,
    type: "preference",
    permissionLevel: 2,
    tags: ["tech"],
    importance: 0.6,
  },
];

const CATEGORY_TAG_PATTERNS: Array<[string, RegExp]> = [
  ["work", /(工作|项目|会议|客户|上线|review|meeting|project|deploy)/i],
  ["finance", /(股票|基金|投资|预算|报销|stock|fund|budget|invoice)/i],
  ["travel", /(机票|酒店|签证|行程|flight|hotel|visa|trip)/i],
  ["study", /(学习|课程|论文|考试|course|paper|exam)/i],
  ["legal", /(合同|协议|法务|contract|agreement|compliance)/i],
];

/** 噪音模式：明显不值得存的短闲聊。 */
const NOISE_PATTERN =
  /^(你好|您好|谢谢|ok|okay|hi|hello|嗯|好的|收到|哈哈|lol|thanks|thank you)[!！。.~ ]*$/i;

export function judgeByRules(input: JudgeInput): JudgeResult {
  const text = input.text.trim();
  let permissionLevel: PermissionLevel = 2;
  let type: MemoryType = "temporary";
  let importance = 0.4;
  const tags = new Set<string>();
  const sensitiveTags = new Set<string>();
  const reasons: string[] = [];
  let forceStore = false;
  let matched = false;

  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    matched = true;
    reasons.push(rule.name);
    if (rule.permissionLevel !== undefined && rule.permissionLevel > permissionLevel) {
      permissionLevel = rule.permissionLevel as PermissionLevel;
    }
    if (rule.type && type === "temporary") type = rule.type;
    rule.tags?.forEach((t) => tags.add(t));
    rule.sensitiveTags?.forEach((t) => sensitiveTags.add(t));
    if (rule.importance !== undefined) {
      importance = Math.max(importance, rule.importance);
    }
    if (rule.forceStore) forceStore = true;
  }

  // 类别标签兜底：只加白名单内的类别级标签
  for (const [tag, pattern] of CATEGORY_TAG_PATTERNS) {
    if (pattern.test(text) && TAG_WHITELIST.has(tag)) tags.add(tag);
  }

  // 白名单硬校验：任何规则产物都不得绕过（验收 S7）
  const safeTags = [...tags].filter((t) => TAG_WHITELIST.has(t));

  const isNoise = !input.explicit && !forceStore && (NOISE_PATTERN.test(text) || text.length < 8);
  const shouldStore = input.explicit === true || forceStore || (matched && !isNoise);

  if (input.explicit && !matched) {
    type = "preference";
    importance = Math.max(importance, 0.6);
    reasons.push("explicit-save");
  }

  if (type === "temporary" && shouldStore) type = "event";

  return {
    shouldStore,
    type,
    permissionLevel,
    tags: safeTags,
    sensitiveTags: [...sensitiveTags],
    importance,
    reason: reasons.length > 0 ? reasons.join("+") : isNoise ? "noise" : "no-rule",
    engineVersion: L0_ENGINE_VERSION,
  };
}
