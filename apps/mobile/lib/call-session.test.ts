import { callIdFromClientNonce } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallClip, CallDeps, CallEnded } from "./call-session";
import { endCall, getSnapshot, startCall, subscribe, toggleMute } from "./call-session";

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("./voice", () => ({ speakText: vi.fn() }));
vi.mock("./api", () => ({
  applyMobileThreadEvent: vi.fn(),
  blockText: vi.fn(),
  captureApiRequestContext: vi.fn(),
  rpc: vi.fn(),
  subscribeThread: vi.fn(),
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakes() {
  const recordings: Array<Deferred<CallClip | null>> = [];
  const signals: AbortSignal[] = [];
  const speeches: Array<Deferred<void>> = [];
  const send = vi.fn(async (_botId: string, _text: string, _clientNonce: string) => undefined);
  const closeCall = vi.fn(async (_botId: string, _callId: string) => undefined);
  const unwatch = vi.fn();
  let reply: (messageId: string, text: string) => void = () => undefined;
  let ended: (ended: CallEnded) => void = () => undefined;
  const spoken: string[] = [];
  const deps: CallDeps = {
    record: (signal) => {
      signals.push(signal);
      const next = deferred<CallClip | null>();
      recordings.push(next);
      return next.promise;
    },
    // The fake clip carries the words, so transcription is the identity.
    transcribe: async (clip) => clip.base64,
    send,
    endCall: closeCall,
    speak: (_botId, text) => {
      spoken.push(text);
      const next = deferred<void>();
      speeches.push(next);
      return next.promise;
    },
    watch: (_botId, onReply, onCallEnded) => {
      reply = onReply;
      ended = onCallEnded;
      return unwatch;
    },
  };
  return {
    deps,
    recordings,
    signals,
    speeches,
    spoken,
    send,
    closeCall,
    unwatch,
    say: (text: string) =>
      recordings[recordings.length - 1]?.resolve({ base64: text, mimeType: "audio/m4a" }),
    replyWith: (messageId: string, text: string) => reply(messageId, text),
    endedCall: (callId: string | undefined, farewell?: string) => ended({ callId, farewell }),
  };
}

afterEach(() => endCall());

describe("mobile call session", () => {
  it("starts listening for the bot on the call", () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    expect(getSnapshot()).toMatchObject({ botId: "bot-1", botName: "Ada", phase: "listening" });
    expect(fake.recordings).toHaveLength(1);
  });

  it("sends what it heard to the call's bot", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("how is the deploy going");
    await flush();
    expect(fake.send).toHaveBeenCalledWith(
      "bot-1",
      "how is the deploy going",
      expect.stringMatching(/^call:/),
    );
    expect(getSnapshot()).toMatchObject({ phase: "thinking", heard: "how is the deploy going" });
  });

  it("tags every message in one call with the same call id", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("how is the deploy going");
    await flush();
    fake.replyWith("message-1", "It is green.");
    fake.speeches[0]?.resolve();
    await flush();
    fake.say("and the tests");
    await flush();

    const nonces = fake.send.mock.calls.map((call) => call[2]);
    expect(nonces).toHaveLength(2);
    expect(callIdFromClientNonce(nonces[0])).toBe(callIdFromClientNonce(nonces[1]));
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("speaks a reply, then listens again", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(getSnapshot()?.exchanges).toEqual([
      { role: "user", text: "status please" },
      { role: "bot", text: "It is green." },
    ]);
    fake.speeches[0]?.resolve();
    await flush();
    expect(getSnapshot()?.phase).toBe("listening");
    expect(fake.recordings).toHaveLength(2);
  });

  it("stops recording while muted", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    toggleMute();
    await flush();
    expect(fake.signals[0]?.aborted).toBe(true);
    expect(getSnapshot()).toMatchObject({ muted: true, phase: "listening" });
    expect(fake.recordings).toHaveLength(1);
  });

  it("hangs up once the bot has answered a goodbye", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("that's all, bye");
    await flush();
    expect(fake.send).toHaveBeenCalledWith(
      "bot-1",
      "that's all, bye",
      expect.stringMatching(/^call:/),
    );
    fake.replyWith("message-1", "Talk soon.");
    expect(getSnapshot()?.phase).toBe("speaking");
    fake.speeches[0]?.resolve();
    await flush();
    expect(getSnapshot()).toBeNull();
    expect(fake.unwatch).toHaveBeenCalled();
  });

  it("speaks the farewell and hangs up when the bot ends the call itself", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("end the call and make me a list");
    await flush();
    fake.endedCall(callIdFromClientNonce(fake.send.mock.calls[0]?.[2]), "Talk soon.");
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(fake.spoken).toEqual(["Talk soon."]);
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()).toBeNull();
  });

  it("never speaks the work the bot files after it hung up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("end the call and make me a list");
    await flush();
    fake.endedCall(callIdFromClientNonce(fake.send.mock.calls[0]?.[2]), "Talk soon.");
    fake.replyWith("message-1", "Here is the list.");

    expect(fake.spoken).toEqual(["Talk soon."]);
  });

  it("ignores a call ended event from another call", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("status please");
    await flush();
    fake.endedCall("someone-elses-call", "Talk soon.");
    fake.replyWith("message-1", "It is green.");
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("reports a failed recording and retries, then hangs up cleanly", async () => {
    const fake = fakes();
    let attempts = 0;
    startCall(
      { botId: "bot-1", botName: "Ada" },
      {
        ...fake.deps,
        record: (signal) => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error("mic busy")) : fake.deps.record(signal);
        },
      },
    );
    const captions: string[] = [];
    const stop = subscribe(() => {
      const caption = getSnapshot()?.caption;
      if (caption) captions.push(caption);
    });
    await flush();
    stop();
    expect(captions).toContain("mic busy");
    expect(getSnapshot()?.phase).toBe("listening");
    expect(attempts).toBe(2);
    endCall();
    expect(getSnapshot()).toBeNull();
  });

  it("aborts the bot feed on hang up", () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    endCall();
    expect(fake.unwatch).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toBeNull();
  });

  it("closes the call server-side when the caller presses hang up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("status please");
    await flush();
    const callId = callIdFromClientNonce(fake.send.mock.calls[0]?.[2]);

    endCall();

    expect(fake.closeCall).toHaveBeenCalledWith("bot-1", callId);
  });

  it("closes the call server-side once when the caller says goodbye", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("that's all, bye");
    await flush();
    const callId = callIdFromClientNonce(fake.send.mock.calls[0]?.[2]);
    fake.replyWith("message-1", "Talk soon.");
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()).toBeNull();
    expect(fake.closeCall).toHaveBeenCalledTimes(1);
    expect(fake.closeCall).toHaveBeenCalledWith("bot-1", callId);
  });

  it("does not close the call again when the bot ended it", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    fake.say("end the call and make me a list");
    await flush();
    fake.endedCall(callIdFromClientNonce(fake.send.mock.calls[0]?.[2]), "Talk soon.");
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()).toBeNull();
    expect(fake.closeCall).not.toHaveBeenCalled();
  });
});
