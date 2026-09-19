import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { runThreadSubscription } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { endCall, getSnapshot, startCall, toggleMute } from "./call-session";
import { dictation } from "./dictation.js";
import { rpc } from "./rpc.js";
import { speaker } from "./tts.js";

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
const send = vi.mocked(rpc.threads.send);
const getThread = vi.mocked(rpc.threads.get);

describe("call session", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
    listen.mockResolvedValue(undefined);
    getThread.mockResolvedValue(snapshot([]) as never);
    send.mockResolvedValue({ runId: "run-1", taskId: "task-1" } as never);
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
    speech?.({ status: "speaking", caption: "Booked for Friday" });
    expect(getSnapshot()?.phase).toBe("speaking");

    listen.mockClear();
    speech?.({ status: "idle" });
    await Promise.resolve();
    expect(getSnapshot()?.phase).toBe("listening");
    expect(listen).toHaveBeenCalledTimes(1);
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
});

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
    blocks: [{ kind: "text", text }],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

function snapshot(messages: ThreadMessage[]): ThreadSnapshot {
  return {
    botId: "call-bot",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor: null,
    run: null,
  };
}
