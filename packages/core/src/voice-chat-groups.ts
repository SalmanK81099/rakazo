import type { MessageBlock } from "@rakazo/contracts";
import { speechFromBlocks } from "./speech-text.js";

/** The fields grouping reads; web `ThreadMessage` and mobile `MobileMessage` both satisfy it. */
export type VoiceChatMessage = {
  id: string;
  role: string;
  runId?: string;
  callId?: string;
  createdAt?: string;
  blocks: MessageBlock[];
};

export type VoiceChatGroup<T extends VoiceChatMessage = VoiceChatMessage> = {
  kind: "voiceChat";
  callId: string;
  messages: T[];
  /** The `voice_call` message the bot left when it hung up; it closes the group. */
  marker?: T;
};
export type ThreadItem<T extends VoiceChatMessage = VoiceChatMessage> =
  | { kind: "message"; message: T }
  | VoiceChatGroup<T>;

const SUMMARY_MAX = 120;

/**
 * Collapses each run of consecutive call messages into one group: a user
 * message carrying the call's `callId`, or a bot reply to a run already in the
 * group. Anything else ends the run — a typed user message breaks the group
 * even when it reuses the run of a call turn. The bot's `voice_call` marker
 * closes the group, so the work it does after hanging up renders as chat.
 */
export function groupVoiceChats<T extends VoiceChatMessage>(messages: T[]): ThreadItem<T>[] {
  const items: ThreadItem<T>[] = [];
  let open: VoiceChatGroup<T> | undefined;
  let openRunIds = new Set<string>();
  for (const message of messages) {
    if (open) {
      const joinsByRun = Boolean(
        message.role === "bot" && message.runId && openRunIds.has(message.runId),
      );
      if (message.callId === open.callId || joinsByRun) {
        open.messages.push(message);
        if (isCallMarker(message)) {
          open.marker = message;
          open = undefined;
          continue;
        }
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

function isCallMarker(message: VoiceChatMessage): boolean {
  return message.role === "bot" && message.blocks[0]?.kind === "voice_call";
}

/** The title the bot hung up with, else the first sentence of its first spoken reply. */
export function voiceChatSummary(group: VoiceChatGroup): string {
  const marker = group.marker?.blocks[0];
  const title = marker?.kind === "voice_call" ? marker.title.trim() : "";
  if (title) return title;
  const reply = group.messages.find(
    (message) => message.role === "bot" && message !== group.marker,
  );
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
  const seconds = (Date.parse(last.createdAt ?? "") - Date.parse(first.createdAt ?? "")) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}
