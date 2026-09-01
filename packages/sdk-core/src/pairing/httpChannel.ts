/**
 * 生产配对通道：对接自托管节点的 KV 信箱。
 * 云端只见 SPAKE2 公开消息，不含 MK。
 */
import type { PairingChannel, PairingMessage } from "./pairing.js";

export class HttpPairingChannel implements PairingChannel {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.endpoint.replace(/\/$/, "")}${path}`;
  }

  async create(code: string, first: PairingMessage): Promise<void> {
    const res = await this.fetchImpl(this.url("/api/pairing/session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, message: first }),
    });
    if (!res.ok) {
      throw new Error(`pairing create failed: HTTP ${res.status}`);
    }
  }

  async post(code: string, message: PairingMessage): Promise<void> {
    const res = await this.fetchImpl(this.url(`/api/pairing/session/${code}/message`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      throw new Error(`pairing post failed: HTTP ${res.status}`);
    }
  }

  async poll(code: string, sinceIndex: number): Promise<PairingMessage[] | null> {
    const res = await this.fetchImpl(this.url(`/api/pairing/session/${code}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`pairing poll failed: HTTP ${res.status}`);
    const body = (await res.json()) as { messages: PairingMessage[] };
    return (body.messages ?? []).slice(sinceIndex);
  }
}
