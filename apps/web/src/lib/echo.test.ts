import { describe, expect, it } from "vitest";
import { isEchoOfSpeech } from "./echo.js";

const SPOKEN = "I'm here and hearing you…";

describe("isEchoOfSpeech", () => {
  it("catches a fragment of the reply that just played", () => {
    expect(isEchoOfSpeech("I am here in", SPOKEN)).toBe(true);
  });

  it("catches a fragment with filler around it", () => {
    expect(isEchoOfSpeech("hey I am here and here", SPOKEN)).toBe(true);
  });

  it("keeps a genuine short turn", () => {
    expect(isEchoOfSpeech("what should we do next", SPOKEN)).toBe(false);
  });

  it("keeps a long turn that happens to share words", () => {
    expect(
      isEchoOfSpeech(
        "I am not sure you are hearing me so let me say the whole thing again from the top",
        SPOKEN,
      ),
    ).toBe(false);
  });

  it("drops a looser overlap only at the playback threshold", () => {
    expect(isEchoOfSpeech("I am here what about that", SPOKEN)).toBe(false);
    expect(isEchoOfSpeech("I am here what about that", SPOKEN, 0.4)).toBe(true);
  });

  it("keeps everything when nothing was spoken", () => {
    expect(isEchoOfSpeech("I am here in", "")).toBe(false);
  });
});
