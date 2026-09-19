import { t } from "@lingui/core/macro";
import type { ThreadSnapshot } from "@rakazo/contracts";
import {
  isSecretAskBlock,
  narrateTool,
  runThreadSubscription,
  speechFromBlocks,
  spokenDecision,
} from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { dictation } from "./dictation.js";
import { rpc } from "./rpc.js";
import { isThreadSnapshotEvent, reduceThreadSnapshot } from "./thread-events.js";
import { speaker } from "./tts.js";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export interface CallState {
  botId: string;
  botName: string;
  botColor: string;
  startedAt: number;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
}

const RUN_ACTIVE = ["running", "queued", "leased"];

let state: CallState | null = null;
let transcribe = false;
let thread: ThreadSnapshot | null = null;
let feed: AbortController | null = null;
let spokenMessageId: string | null = null;
let unsubSpeech: (() => void) | null = null;
let unsubDictation: (() => void) | null = null;
const narrated = new Set<string>();
const watchers = new Set<() => void>();

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

export function useCallSession(): CallState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  state = { ...state, ...patch };
  emit();
}

export function startCall(call: {
  botId: string;
  botName: string;
  botColor?: string;
  transcribe: boolean;
}): void {
  endCall();
  transcribe = call.transcribe;
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    startedAt: Date.now(),
    phase: "listening",
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  unsubSpeech = speaker.subscribe((speech) => {
    if (!state) return;
    if (speech.status === "speaking") {
      set({ phase: "speaking", caption: speech.caption ?? "" });
    } else if (speech.status === "idle" && state.phase !== "listening") {
      set({ caption: "" });
      void listen();
    }
    if (speech.error) set({ caption: speech.error });
  });
  unsubDictation = dictation.subscribe((heard) => {
    if (!state) return;
    if (heard.status === "listening") {
      set({ heard: pendingSecretAsk(thread) ? "" : heard.transcript });
    }
    if (heard.error) set({ caption: heard.error });
  });
  watchThread(call.botId);
  emit();
  void listen();
}

export function endCall(): void {
  feed?.abort();
  feed = null;
  unsubSpeech?.();
  unsubDictation?.();
  unsubSpeech = null;
  unsubDictation = null;
  dictation.stop("cancel");
  speaker.stop();
  thread = null;
  spokenMessageId = null;
  narrated.clear();
  if (!state) return;
  state = null;
  emit();
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted });
  if (muted) {
    dictation.stop("cancel");
    set({ heard: "" });
    return;
  }
  if (state.phase === "listening") void listen();
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchThread(botId: string) {
  const controller = new AbortController();
  feed = controller;
  const load = async () => commit(await rpc.threads.get({ botId }, { signal: controller.signal }));
  void runThreadSubscription({
    signal: controller.signal,
    loadInitial: load,
    loadHead: () => rpc.threads.head({ botId }, { signal: controller.signal }),
    refresh: load,
    currentSnapshot: () => thread,
    subscribe: (cursor) => rpc.threads.subscribe({ botId, cursor }, { signal: controller.signal }),
    applyEvent: (event) => {
      if (isThreadSnapshotEvent(event)) commit(reduceThreadSnapshot(thread, event));
    },
    onEvent: () => undefined,
  });
}

function commit(next: ThreadSnapshot | null) {
  if (!next) return null;
  thread = next;
  reactToThread();
  return next;
}

async function listen() {
  if (!state) return;
  set({ phase: "listening", heard: "" });
  speaker.stop();
  if (state.muted || pendingSecretAsk(thread)) {
    dictation.stop("cancel");
    return;
  }
  try {
    await dictation.listen({
      mode: "endpoint",
      transcribe,
      onFinal: (text) => void handleTranscript(text),
    });
  } catch (error) {
    set({ caption: errorText(error, t`Microphone failed`) });
  }
}

async function handleTranscript(text: string) {
  if (!state) return;
  if (!text.trim()) {
    void listen();
    return;
  }
  dictation.stop("submit");
  if (pendingSecretAsk(thread)) {
    set({ heard: "", caption: t`Hang up, then enter the code on screen.` });
    return;
  }
  const { botId, exchanges } = state;
  const askId = latestAskId(thread);
  const askMessage = thread?.messages.find((message) => message.id === askId);
  set({ heard: text, phase: "thinking", exchanges: [...exchanges, { role: "user", text }] });
  try {
    if (askMessage) {
      await rpc.threads.answer({
        botId,
        runId: askMessage.runId ?? "",
        messageId: askMessage.id,
        answer: spokenDecision(text) ?? text,
      });
    } else if (runActive(thread)) {
      await rpc.threads.followUp({ botId, text });
    } else {
      await rpc.threads.send({ botId, clientNonce: clientNonce(), text });
    }
    if (state?.botId !== botId) return;
    commit(await rpc.threads.get({ botId }, { signal: feed?.signal }));
  } catch (error) {
    if (state?.botId !== botId) return;
    set({ caption: errorText(error, t`Could not send that`) });
    void listen();
  }
}

/** Speak whatever the call's bot said last, then narrate progress while it keeps working. */
function reactToThread() {
  if (!state) return;
  if (pendingSecretAsk(thread)) {
    dictation.stop("cancel");
    set({ heard: "" });
  }
  if (state.phase === "listening") return;
  const { botId } = state;
  const messages = thread?.messages ?? [];
  const lastBot = [...messages].reverse().find((message) => message.role === "bot");
  if (lastBot && lastBot.id !== spokenMessageId) {
    const text = speechFromBlocks(lastBot.blocks);
    const ask = lastBot.blocks.find((block) => block.kind === "ask" && block.status !== "answered");
    const secretAsk = ask && isSecretAskBlock(ask);
    if (text) {
      spokenMessageId = lastBot.id;
      dictation.stop("cancel");
      set({ exchanges: [...state.exchanges, { role: "bot", text }] });
      void speaker.speak(
        secretAsk
          ? `${text}. ${t`Hang up first, then enter the code on screen.`}`
          : ask
            ? `${text}. ${t`Say yes or no, or answer in a sentence.`}`
            : text,
        { botId, messageId: lastBot.id },
      );
      return;
    }
    if (!runActive(thread)) {
      spokenMessageId = lastBot.id;
      void listen();
      return;
    }
  }
  if (!runActive(thread)) return;
  const phrases: string[] = [];
  let lastKey = "";
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== "progress" && block.kind !== "subagent") continue;
      const key = `${message.id}:${block.kind}:${block.kind === "subagent" ? block.status : block.text}`;
      if (narrated.has(key)) continue;
      const phrase =
        block.kind === "subagent"
          ? narrateTool("run_subagent")
          : (narrateTool(block.text.split(/\s+/)[0] ?? "") ?? speakableProgress(block.text));
      if (!phrase) continue;
      narrated.add(key);
      phrases.push(phrase);
      lastKey = key;
    }
  }
  if (phrases.length) {
    void speaker.speak(phrases.join(". "), { botId, messageId: `narrate:${lastKey}` });
  }
}

function runActive(snapshot: ThreadSnapshot | null) {
  return Boolean(snapshot?.run && RUN_ACTIVE.includes(snapshot.run.status));
}

function pendingSecretAsk(snapshot: ThreadSnapshot | null) {
  const askId = latestAskId(snapshot);
  const askMessage = snapshot?.messages.find((message) => message.id === askId);
  return Boolean(
    askMessage?.blocks.some(
      (block) => block.kind === "ask" && isSecretAskBlock(block) && block.status !== "answered",
    ),
  );
}

function latestAskId(snapshot: ThreadSnapshot | null): string | null {
  if (snapshot?.run?.status !== "waiting_input") return null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.runId !== snapshot.run.id) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      return message.id;
    }
  }
  return null;
}

function speakableProgress(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function clientNonce(): string {
  const webCrypto = globalThis.crypto;
  return typeof webCrypto?.randomUUID === "function"
    ? webCrypto.randomUUID()
    : `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
