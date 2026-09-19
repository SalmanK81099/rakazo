import type { ThreadMessage } from "@rakazo/contracts";
import { speechFromBlocks } from "@rakazo/core";

export type VoiceChatGroup = { kind: "voiceChat"; callId: string; messages: ThreadMessage[] };
export type ThreadItem = { kind: "message"; message: ThreadMessage } | VoiceChatGroup;

const SUMMARY_MAX = 120;

/**
 * Collapses each run of consecutive call messages into one group: a user
 * message carrying the call's `callId`, or a bot reply to a run already in the
 * group. Anything else ends the run.
 */
export function groupVoiceChats(messages: ThreadMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let open: VoiceChatGroup | undefined;
  let openRunIds = new Set<string>();
  for (const message of messages) {
    if (open) {
      if (message.callId === open.callId || (message.runId && openRunIds.has(message.runId))) {
        open.messages.push(message);
        if (message.callId === open.callId && message.runId) openRunIds.add(message.runId);
        continue;
      }
      open = undefined;
    }
    if (message.callId) {
      open = { kind: "voiceChat", callId: message.callId, messages: [message] };
      openRunIds = new Set(message.runId ? [message.runId] : []);
      items.push(open);
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

/** First sentence of the call's first spoken reply, for the collapsed card. */
export function voiceChatSummary(group: VoiceChatGroup): string {
  const reply = group.messages.find((message) => message.role === "bot");
  const spoken = reply ? speechFromBlocks(reply.blocks).trim() : "";
  if (!spoken) return "";
  const end = spoken.search(/[.!?](\s|$)/u);
  const sentence = end === -1 ? spoken : spoken.slice(0, end + 1);
  return sentence.length > SUMMARY_MAX
    ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : sentence;
}

/** Whole seconds between the call's first and last message. */
export function voiceChatDuration(group: VoiceChatGroup): number {
  const first = group.messages[0];
  const last = group.messages[group.messages.length - 1];
  if (!first || !last) return 0;
  const seconds = (Date.parse(last.createdAt) - Date.parse(first.createdAt)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}
