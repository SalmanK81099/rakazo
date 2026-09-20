import { ACTIVE_RUN_STATUSES, abortableDelay, callClientNonce, isFarewell } from "@rakazo/core";
import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useSyncExternalStore } from "react";
import {
  applyMobileThreadEvent,
  blockText,
  captureApiRequestContext,
  type MobileMessage,
  type MobileSnapshot,
  rpc,
  subscribeThread,
} from "./api";
import { t } from "./i18n";
import { speakText } from "./voice";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export type CallState = {
  botId: string;
  botName: string;
  botColor: string;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
};

export type CallClip = { base64: string; mimeType: string };

/** Everything that touches the device or the server, so the loop stays testable. */
export type CallDeps = {
  record: (signal: AbortSignal) => Promise<CallClip | null>;
  transcribe: (clip: CallClip, signal: AbortSignal) => Promise<string>;
  send: (botId: string, text: string, clientNonce: string) => Promise<void>;
  speak: (botId: string, text: string) => Promise<void>;
  watch: (
    botId: string,
    onReply: (messageId: string, text: string) => void,
    onCallEnded: (callId: string | undefined) => void,
  ) => () => void;
};

/** How long a goodbye waits for a reply that may never come before hanging up anyway. */
const FAREWELL_TIMEOUT_MS = 20_000;
/** A call that cannot reach the microphone or the server this many turns in a row hangs up. */
const MAX_TURN_FAILURES = 3;

// ponytail: naive fixed-threshold endpointing. Swap for a VAD model if rooms
// with steady background noise start cutting people off mid-sentence.
const SPEECH_LEVEL_DB = -35;
const SILENCE_HANG_MS = 1_200;
const METER_POLL_MS = 200;
const MAX_CLIP_MS = 30_000;

let state: CallState | null = null;
/** Shared by every message this call sends, so the thread can group one call's exchange. */
let callId = "";
let deps: CallDeps = productionDeps();
let turn: AbortController | null = null;
let unwatch: (() => void) | null = null;
let hangUpAfterReply = false;
let hangUpTimer: ReturnType<typeof setTimeout> | null = null;
let spokenMessageId: string | null = null;
let failures = 0;
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

export function startCall(
  call: { botId: string; botName: string; botColor?: string },
  overrides: Partial<CallDeps> = {},
): void {
  endCall();
  deps = { ...productionDeps(), ...overrides };
  callId = randomId();
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    phase: "listening",
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  unwatch = deps.watch(call.botId, onReply, onCallEnded);
  emit();
  void listen();
}

export function endCall(): void {
  turn?.abort();
  turn = null;
  unwatch?.();
  unwatch = null;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  hangUpAfterReply = false;
  spokenMessageId = null;
  failures = 0;
  if (!state) return;
  state = null;
  emit();
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: "" });
  if (muted) {
    turn?.abort();
    turn = null;
    return;
  }
  if (state.phase === "listening") void listen();
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

async function listen(): Promise<void> {
  if (!state) return;
  // The caller said goodbye: every path back to listening hangs up instead.
  if (hangUpAfterReply) {
    endCall();
    return;
  }
  set({ phase: "listening", heard: "", caption: "" });
  if (state.muted) return;
  const controller = new AbortController();
  turn = controller;
  const { botId } = state;
  const mine = () => !controller.signal.aborted && state?.botId === botId;
  try {
    const clip = await deps.record(controller.signal);
    if (!mine()) return;
    const text = clip ? (await deps.transcribe(clip, controller.signal)).trim() : "";
    if (!mine()) return;
    failures = 0;
    if (!text) {
      void listen();
      return;
    }
    set({
      phase: "thinking",
      heard: text,
      exchanges: [...state.exchanges, { role: "user", text }],
    });
    if (isFarewell(text)) {
      hangUpAfterReply = true;
      hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT_MS);
    }
    await deps.send(botId, text, callClientNonce(callId));
  } catch (error) {
    if (!mine()) return;
    failures += 1;
    if (failures >= MAX_TURN_FAILURES) {
      endCall();
      return;
    }
    set({ phase: "listening", caption: errorText(error, t("Could not hear that.")) });
    void listen();
  }
}

function onReply(messageId: string, text: string): void {
  if (!state || messageId === spokenMessageId) return;
  spokenMessageId = messageId;
  turn?.abort();
  turn = null;
  const { botId } = state;
  set({ phase: "speaking", heard: "", exchanges: [...state.exchanges, { role: "bot", text }] });
  void deps
    .speak(botId, text)
    .catch((error: unknown) => {
      if (state?.botId === botId) set({ caption: errorText(error, t("Could not speak that.")) });
    })
    .finally(() => {
      if (state?.botId !== botId) return;
      void listen();
    });
}

/** The bot hung up mid-run: speak the reply it is finishing, then end the call. */
function onCallEnded(endedCallId: string | undefined): void {
  if (!state || endedCallId !== callId || hangUpAfterReply) return;
  hangUpAfterReply = true;
  hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT_MS);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function productionDeps(): CallDeps {
  return {
    record: recordClip,
    transcribe: transcribeClip,
    send: sendHeard,
    speak: speakReply,
    watch: watchReplies,
  };
}

/** Records one hands-free turn: wait for speech, stop once the speaker goes quiet. */
async function recordClip(signal: AbortSignal): Promise<CallClip | null> {
  const { AudioModule, RecordingPresets, setAudioModeAsync } = await import("expo-audio");
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  if (!permission.granted) throw new Error(t("Allow microphone access to call a bot."));
  let recorder: AudioRecorder | undefined;
  let heardSpeech = false;
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    recorder = new AudioModule.AudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    await recorder.prepareToRecordAsync();
    recorder.record();
    let quietMs = 0;
    for (let elapsed = 0; elapsed < MAX_CLIP_MS && !signal.aborted; elapsed += METER_POLL_MS) {
      await abortableDelay(METER_POLL_MS, signal);
      if (signal.aborted) break;
      // Platforms without metering report nothing; keep recording to the cap.
      const level = recorder.getStatus().metering ?? 0;
      if (level > SPEECH_LEVEL_DB) {
        heardSpeech = true;
        quietMs = 0;
      } else if (heardSpeech) {
        quietMs += METER_POLL_MS;
        if (quietMs >= SILENCE_HANG_MS) break;
      }
    }
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri || !heardSpeech || signal.aborted) {
      deleteQuietly(uri);
      return null;
    }
    const file = new File(uri);
    const base64 = await file.base64();
    deleteQuietly(uri);
    return { base64, mimeType: "audio/m4a" };
  } finally {
    recorder?.release();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  }
}

function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // The clip is disposable; a leftover in the cache is fine.
  }
}

async function transcribeClip(clip: CallClip, signal: AbortSignal): Promise<string> {
  const { apiBase, headers } = await captureApiRequestContext();
  const res = await fetch(`${apiBase}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
    body: JSON.stringify({ audioBase64: clip.base64, mimeType: clip.mimeType }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? t("Could not transcribe that."));
  return body.text ?? "";
}

async function sendHeard(botId: string, text: string, clientNonce: string): Promise<void> {
  await rpc("threads/send", { botId, clientNonce, text });
}

async function speakReply(botId: string, text: string): Promise<void> {
  if (!(await speakText(text, { botId }))) {
    throw new Error(t("Add a voice provider in Voice settings."));
  }
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchReplies(
  botId: string,
  onNewReply: (messageId: string, text: string) => void,
  onEnded: (callId: string | undefined) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    let snapshot = await rpc<MobileSnapshot>(
      "threads/get",
      { botId },
      { signal: controller.signal },
    );
    let lastSeen = lastBotMessage(snapshot)?.id ?? null;
    await subscribeThread(
      { botId },
      snapshot.cursor ?? 0,
      (event) => {
        if (event.type === "thread.call.ended") {
          onEnded(typeof event.payload?.callId === "string" ? event.payload.callId : undefined);
          return;
        }
        snapshot = applyMobileThreadEvent(snapshot, event) ?? snapshot;
        // Wait for the run to settle so half-written blocks are never spoken.
        if (snapshot.run && ACTIVE_RUN_STATUSES.some((s) => s === snapshot.run?.status)) return;
        const message = lastBotMessage(snapshot);
        if (!message || message.id === lastSeen) return;
        const text = blockText(message).trim();
        if (!text) return;
        lastSeen = message.id;
        onNewReply(message.id, text);
      },
      controller.signal,
    );
  })().catch(() => undefined);
  return () => controller.abort();
}

function lastBotMessage(snapshot: MobileSnapshot | null): MobileMessage | undefined {
  if (!snapshot) return undefined;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.role === "bot") return message;
  }
  return undefined;
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
