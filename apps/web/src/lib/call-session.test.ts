import type { ProductEvent, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { callIdFromClientNonce, runThreadSubscription } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECHO_GUARD_MS, endCall, getSnapshot, startCall, toggleMute } from "./call-session";
import { dictation } from "./dictation.js";
import { rpc } from "./rpc.js";
import { reduceThreadSnapshot } from "./thread-events.js";
import { speaker } from "./tts.js";
import { groupVoiceChats } from "./voice-chat-groups.js";

// The macro compiles away in the app build; tests run the source, so tag the template as-is.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/core")>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));

vi.mock("./dictation.js", () => ({
  dictation: {
    listen: vi.fn(async () => undefined),
    stop: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("./tts.js", () => ({
  speaker: {
    speak: vi.fn(async () => undefined),
    stop: vi.fn(),
    isSpeaking: vi.fn(() => false),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("./rpc.js", () => ({
  rpc: {
    threads: {
      answer: vi.fn(),
      followUp: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(),
    },
  },
}));

const listen = vi.mocked(dictation.listen);
const speak = vi.mocked(speaker.speak);
const isSpeaking = vi.mocked(speaker.isSpeaking);
const send = vi.mocked(rpc.threads.send);
const getThread = vi.mocked(rpc.threads.get);

describe("call session", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
    vi.useFakeTimers();
    isSpeaking.mockReturnValue(false);
    listen.mockResolvedValue(undefined);
    getThread.mockResolvedValue(snapshot([]) as never);
    send.mockResolvedValue({ runId: "run-1", taskId: "task-1" } as never);
  });

  afterEach(() => {
    endCall();
    vi.useRealTimers();
  });

  it("starts listening for the bot on the call", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: true });
    await Promise.resolve();

    expect(getSnapshot()).toMatchObject({
      botId: "call-bot",
      botName: "Ada",
      phase: "listening",
      muted: false,
    });
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ transcribe: true }));
  });

  it("sends what it heard to the bot on the call, not the bot on screen", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "book the flight" }),
    );
    expect(getSnapshot()).toMatchObject({
      phase: "thinking",
      exchanges: [{ role: "user", text: "book the flight" }],
    });
  });

  it("tags every message in one call with the same call id", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");
    await heard("window seat please");

    const nonces = send.mock.calls.map((call) => String(call[0]?.clientNonce));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]?.startsWith("call:")).toBe(true);
    expect(callIdFromClientNonce(nonces[0])).toBe(callIdFromClientNonce(nonces[1]));
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("speaks a reply from the call's own feed, then listens again", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await heard("book the flight");

    expect(speak).toHaveBeenCalledWith(
      "Booked for Friday",
      expect.objectContaining({ botId: "call-bot", messageId: "message-1" }),
    );
    expect(getSnapshot()?.exchanges.at(-1)).toEqual({ role: "bot", text: "Booked for Friday" });

    const speech = vi.mocked(speaker.subscribe).mock.calls[0]?.[0];
    listen.mockClear();
    speech?.({ status: "speaking", caption: "Booked for Friday" });
    await Promise.resolve();
    expect(getSnapshot()?.phase).toBe("speaking");
    // Dictation runs through playback so the caller can cut in.
    expect(listen).toHaveBeenCalledTimes(1);

    listen.mockClear();
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(getSnapshot()?.phase).toBe("listening");
    expect(listen).not.toHaveBeenCalled();
  });

  it("waits out the echo guard when the mic was shut through playback", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await Promise.resolve();
    toggleMute();
    listen.mockClear();

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Booked for Friday" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS * 2);
    expect(listen).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");

    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS - 1);
    expect(getSnapshot()?.phase).toBe("speaking");

    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("ignores the reply leaking into the mic while it plays", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("I'm here and hearing you");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("hey I am here and here");

    expect(send).not.toHaveBeenCalled();
    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("stops the reply when the caller talks over it", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const speech = await speakingReply("Booked for Friday");
    send.mockClear();
    speak.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("wait, what about the deploy");

    expect(speaker.stop).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: "wait, what about the deploy" }),
    );
    expect(getSnapshot()?.phase).toBe("thinking");

    // The cut-off reply is spoken, so nothing resumes it and no guard runs.
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(speak).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("thinking");
  });

  it("lets a one-word interruption cut the reply short", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("Booked for Friday");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("stop");

    expect(speaker.stop).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "stop" }));
  });

  it("keeps playing through a one-word backchannel", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("Booked for Friday");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("yeah");

    expect(send).not.toHaveBeenCalled();
    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("drops a transcript that is the reply coming back through the mic", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(
      snapshot([botMessage("message-1", "I'm here and hearing you")]) as never,
    );
    await heard("book the flight");
    send.mockClear();
    listen.mockClear();

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    await heard("hey I am here and here");

    expect(send).not.toHaveBeenCalled();
    expect(getSnapshot()?.exchanges.at(-1)).toEqual({
      role: "bot",
      text: "I'm here and hearing you",
    });
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("stops listening while muted", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await Promise.resolve();
    listen.mockClear();

    toggleMute();
    expect(getSnapshot()).toMatchObject({ muted: true, heard: "" });
    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(listen).not.toHaveBeenCalled();

    toggleMute();
    await Promise.resolve();
    expect(getSnapshot()?.muted).toBe(false);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("aborts the call feed and clears the store on hang up", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    expect(feed?.signal.aborted).toBe(false);

    endCall();

    expect(feed?.signal.aborted).toBe(true);
    expect(getSnapshot()).toBeNull();
    expect(speaker.stop).toHaveBeenCalled();
  });

  it("tears the previous call down before opening the next call's feed", async () => {
    const unsubSpeech = vi.fn();
    const unsubDictation = vi.fn();
    vi.mocked(speaker.subscribe).mockReturnValueOnce(unsubSpeech);
    vi.mocked(dictation.subscribe).mockReturnValueOnce(unsubDictation);
    startCall({ botId: "bot-a", botName: "Ada", transcribe: false });
    const feedA = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];

    let abortedWhenNextOpened: boolean | null = null;
    vi.mocked(runThreadSubscription).mockImplementationOnce(async () => {
      abortedWhenNextOpened = feedA?.signal.aborted ?? null;
    });
    startCall({ botId: "bot-b", botName: "Grace", transcribe: false });
    await Promise.resolve();

    expect(unsubSpeech).toHaveBeenCalledTimes(1);
    expect(unsubDictation).toHaveBeenCalledTimes(1);
    expect(abortedWhenNextOpened).toBe(true);
    expect(getSnapshot()?.botId).toBe("bot-b");
  });

  it("hangs up once the bot has answered a goodbye", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Talk soon")]) as never);
    await heard("that's all, bye");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "that's all, bye" }),
    );
    expect(speak).toHaveBeenCalledWith(
      "Talk soon",
      expect.objectContaining({ messageId: "message-1" }),
    );

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);

    expect(getSnapshot()).toBeNull();
  });

  it("speaks a streaming reply once, with the text its run finished on", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked")], runningRun) as never);
    await heard("book the flight");
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(
      snapshot([botMessage("message-1", "Booked for Friday")], runningRun) as never,
    );
    await feed?.refresh();
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "Booked for Friday",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it("does not speak a message a refresh re-delivers", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await heard("book the flight");
    expect(speak).toHaveBeenCalledTimes(1);

    await feed?.refresh();
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("does not start dictation while the speaker is still speaking", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await heard("book the flight");
    listen.mockClear();

    // The previous utterance reports idle after the next one already started playing.
    isSpeaking.mockReturnValue(true);
    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).not.toBe("listening");

    isSpeaking.mockReturnValue(false);
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("tags the call's user message for the thread card before the server copy lands", async () => {
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");

    const callId = callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce));
    const live = reduceThreadSnapshot(snapshot([]), userMessageEvent("run-1"));
    expect(live?.messages[0]?.callId).toBe(callId);
    expect(groupVoiceChats(live?.messages ?? [])).toEqual([
      { kind: "voiceChat", callId, messages: live?.messages },
    ]);
  });
});

/** Drives a call to the point where the bot's reply is playing and the mic is open. */
async function speakingReply(text: string) {
  getThread.mockResolvedValue(snapshot([botMessage("message-1", text)]) as never);
  await heard("book the flight");
  const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
  speech?.({ status: "speaking", caption: text });
  await Promise.resolve();
  return speech;
}

async function heard(text: string) {
  const onFinal = listen.mock.calls.at(-1)?.[0]?.onFinal;
  await onFinal?.(text);
  await Promise.resolve();
}

function botMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 4,
    role: "bot",
    runId: "run-1",
    blocks: [{ kind: "text", text }],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

const runningRun = {
  id: "run-1",
  botId: "call-bot",
  threadId: "thread-1",
  taskId: "task-1",
  status: "running",
  trigger: "user",
  routineId: null,
  modelProvider: null,
  modelId: null,
  error: null,
  startedAt: "2026-09-20T00:00:00.000Z",
  completedAt: null,
  createdAt: "2026-09-20T00:00:00.000Z",
} as ThreadSnapshot["run"];

function userMessageEvent(runId: string): ProductEvent {
  return {
    id: "event-1",
    seq: 5,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "call-bot",
    runId,
    type: "thread.message.created",
    payload: { messageId: "message-user", role: "user", blocks: [] },
    createdAt: "2026-09-20T00:00:00.000Z",
  } as ProductEvent;
}

function snapshot(messages: ThreadMessage[], run: ThreadSnapshot["run"] = null): ThreadSnapshot {
  return {
    botId: "call-bot",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor: null,
    run,
  };
}
