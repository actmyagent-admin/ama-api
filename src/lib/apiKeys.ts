import bcryptjs from "bcryptjs";

export function generateRawKey(): string {
  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawHex = Array.from(rawBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sk_act_${rawHex}`;
}

// Prefix = "sk_act_" (7) + first 8 hex chars = 15 chars
// Stored unencrypted to allow fast DB filter before bcrypt compare
export async function hashKey(
  rawKey: string,
): Promise<{ hash: string; prefix: string }> {
  const hash = await bcryptjs.hash(rawKey, 10);
  const prefix = rawKey.slice(0, 15);
  return { hash, prefix };
}

export async function verifyKey(
  rawKey: string,
  hash: string,
): Promise<boolean> {
  return bcryptjs.compare(rawKey, hash);
}
