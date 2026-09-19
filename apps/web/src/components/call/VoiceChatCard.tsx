import { useLingui } from "@lingui/react/macro";
import { speechFromBlocks } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { AudioLines, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  type VoiceChatGroup,
  voiceChatDuration,
  voiceChatSummary,
} from "../../lib/voice-chat-groups";

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceChatCard({ group }: { group: VoiceChatGroup }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const summary = voiceChatSummary(group);
  return (
    <div
      data-testid="voice-chat-card"
      className="w-full rounded-2xl border border-border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-[14px] font-medium text-foreground">{t`Voice chat`}</span>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {clock(voiceChatDuration(group))}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t`Hide transcript` : t`Show transcript`}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="ms-auto grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {!open && summary ? (
        <p className="mt-1.5 truncate text-[13px] text-muted-foreground" dir="auto">
          {summary}
        </p>
      ) : null}
      {open ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {group.messages.map((message) => {
            const text = speechFromBlocks(message.blocks).trim();
            if (!text) return null;
            return (
              <p
                key={message.id}
                dir="auto"
                className={cn(
                  "text-[13.5px] leading-[1.5]",
                  message.role === "user"
                    ? "self-end text-end text-muted-foreground"
                    : "self-start rounded-xl bg-muted px-3 py-1.5 text-foreground",
                )}
              >
                {text}
              </p>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
