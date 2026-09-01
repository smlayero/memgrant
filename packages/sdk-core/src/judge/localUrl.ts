/** 本机模型默认只应打回环地址；指到公网等于明文离机。 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function warnIfRemoteModelUrl(kind: string, url: string): void {
  if (isLoopbackUrl(url)) return;
  console.warn(
    `[memory-backbone] ${kind} baseUrl is not loopback (${url}). Plaintext will leave this device.`,
  );
}
