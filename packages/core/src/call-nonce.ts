/**
 * clientNonce prefix for messages a client sends from a live voice call. The
 * nonce is the only channel that carries the call's identity: the server reads
 * it to answer in spoken sentences, and clients group one call's exchange into
 * a single transcript card.
 */
export const CALL_CLIENT_NONCE_PREFIX = "call:";

export function callClientNonce(callId: string): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${CALL_CLIENT_NONCE_PREFIX}${callId}:${unique}`;
}

export function isCallClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(CALL_CLIENT_NONCE_PREFIX));
}

export function callIdFromClientNonce(clientNonce: string | null | undefined): string | undefined {
  if (!isCallClientNonce(clientNonce)) return undefined;
  return clientNonce?.slice(CALL_CLIENT_NONCE_PREFIX.length).split(":")[0] || undefined;
}
