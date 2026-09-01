/**
 * SyncHub Durable Object（方案 §五）：每用户一个实例，WS 广播变更事件。
 * 事件只含 memory_id + op，绝不含内容；Hibernation 控空闲成本。
 */
export class SyncHub implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      // Hibernation：空闲连接不占用 DO 计费时长
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const event = await request.text();
      this.broadcast(event);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  private broadcast(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // 连接已死，清理
        try {
          ws.close(1011, "send failed");
        } catch {
          /* ignore */
        }
      }
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, "error");
    } catch {
      /* ignore */
    }
  }
}
