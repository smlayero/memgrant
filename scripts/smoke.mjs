/** 端到端冒烟：助记词→MK→写入→outbox 载荷→用户路径解密→Agent 路径解密→隔离验证 */
import {
  generateMnemonicBundle,
  deriveMkFromMnemonic,
  InMemoryKeychain,
  LocalStore,
  MemoryService,
  generateAgentKeyPair,
} from "../packages/sdk-core/dist/index.js";

const agent = generateAgentKeyPair();
const keychain = new InMemoryKeychain();
const bundle = generateMnemonicBundle();
await keychain.setMk(bundle.mk);

// 模拟第二台设备用同一助记词恢复
const recovered = deriveMkFromMnemonic(bundle.mnemonic, bundle.fixedSaltHex);
console.log("S1 双设备 MK 一致:", Buffer.from(recovered).equals(Buffer.from(bundle.mk)));

const store = await LocalStore.open();
const service = new MemoryService(keychain, store, () => [
  {
    agentId: "claude-code",
    agentPublicKey: agent.publicKey,
    permissionMask: 2,
    status: "active",
  },
]);

const saved = await service.saveMemory({
  text: "我喜欢用 pnpm 管理依赖，所有项目统一",
  explicit: true,
  sourceAgent: "claude-code",
});
console.log("写入:", saved.stored, "| type:", saved.judge.type, "| level:", saved.judge.permissionLevel, "| grants:", saved.grants.length);

const payload = JSON.parse(store.dueOutbox()[0].payload);
console.log("outbox 载荷无明文:", !payload.ciphertext.includes("pnpm"), "| keys:", Object.keys(payload).join(","));

const asUser = await service.decryptAsUser(payload.ciphertext, payload.wrapped_dek);
console.log("用户路径解密:", asUser.includes("pnpm"));

const asAgent = await MemoryService.decryptAsAgent(
  payload.ciphertext,
  saved.grants[0].encDekB64,
  agent.secretKey,
);
console.log("Agent 路径解密:", asAgent.includes("pnpm"));

const stranger = generateAgentKeyPair();
let blocked = false;
try {
  await MemoryService.decryptAsAgent(payload.ciphertext, saved.grants[0].encDekB64, stranger.secretKey);
} catch {
  blocked = true;
}
console.log("未授权 Agent 被拒:", blocked);
