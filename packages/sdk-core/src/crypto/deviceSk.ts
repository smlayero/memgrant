/**
 * 设备私钥：0600 文件，与 MK 分开放。丢失后用助记词 recover 登记新设备。
 */
import path from "node:path";
import { FileKeychain } from "./keychain.js";

export async function saveDeviceSk(
  dir: string,
  secretKey: Uint8Array,
): Promise<void> {
  const file = new FileKeychain(path.join(dir, "device.sk"));
  await file.setMk(secretKey);
}

export async function loadDeviceSk(dir: string): Promise<Uint8Array | null> {
  const file = new FileKeychain(path.join(dir, "device.sk"));
  return file.getMk();
}
