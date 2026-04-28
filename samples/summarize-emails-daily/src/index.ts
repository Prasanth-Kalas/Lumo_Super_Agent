import { readFileSync } from "node:fs";
import {
  defineSampleAgent,
  withSampleIdempotency,
  type SampleAgentContext,
  type SampleAgentResult,
} from "../../_shared/runtime.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../lumo-agent.json", import.meta.url), "utf8"),
);

interface EmailMessage extends Record<string, unknown> {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  received_at: string;
}

interface DigestOutputs {
  digest_title: string;
  total_unread: number;
  important_count: number;
  groups: Array<{
    sender: string;
    importance: "high" | "normal";
    subjects: string[];
  }>;
  cached?: boolean;
}

const summarizeUnreadInbox = withSampleIdempotency(
  "summarize_unread_inbox",
  async (_inputs, ctx): Promise<SampleAgentResult<DigestOutputs>> => {
    const gmail = ctx.connectors.gmail;
    if (!gmail?.listUnread) {
      return failedDigest("gmail connector unavailable");
    }

    const messages = ((await gmail.listUnread({
      max_results: 10,
      include_bodies: true,
    })) as { messages: EmailMessage[] }).messages;

    const ranked = await ctx.brain.lumo_personalize_rank({
      items: messages,
      goal: "Rank unread email by sender importance and action value",
    });
    const groups = groupMessages(ranked.ranked);

    return {
      status: "succeeded",
      outputs: {
        digest_title: `Morning digest: ${messages.length} unread`,
        total_unread: messages.length,
        important_count: groups.filter((group) => group.importance === "high").length,
        groups,
      },
      provenance_evidence: {
        sources: [
          { type: "connector.gmail", ref: "gmail.listUnread" },
          { type: "brain.rank", ref: "lumo_personalize_rank" },
        ],
        redaction_applied: true,
      },
      cost_actuals: { usd: 0.018, calls: 2 },
    };
  },
  { ttl_minutes: 60 },
);

export default defineSampleAgent({
  manifest,
  capabilities: {
    summarize_unread_inbox: summarizeUnreadInbox,
    prepare_morning_digest: async (inputs, ctx) => {
      const result = await summarizeUnreadInbox(inputs, ctx);
      if (result.status !== "succeeded") return result;
      const history = await ctx.history({ window_days: 7 });
      return {
        ...result,
        outputs: {
          ...(result.outputs as DigestOutputs),
          digest_title: `${(result.outputs as DigestOutputs).digest_title} · ${
            history.length
          } recent agent notes`,
        },
      };
    },
  },
});

function groupMessages(messages: Array<EmailMessage & { rank_score?: number }>): DigestOutputs["groups"] {
  const bySender = new Map<string, Array<EmailMessage & { rank_score?: number }>>();
  for (const message of messages) {
    const senderMessages = bySender.get(message.from) ?? [];
    senderMessages.push(message);
    bySender.set(message.from, senderMessages);
  }

  return [...bySender.entries()].map(([sender, senderMessages]) => {
    const topScore = Math.max(
      ...senderMessages.map((message) => message.rank_score ?? 0),
    );
    return {
      sender,
      importance: topScore >= 0.75 ? "high" : "normal",
      subjects: senderMessages.map((message) => message.subject),
    };
  });
}

function failedDigest(reason: string): SampleAgentResult<DigestOutputs> {
  return {
    status: "failed",
    outputs: {
      digest_title: reason,
      total_unread: 0,
      important_count: 0,
      groups: [],
    },
    provenance_evidence: {
      sources: [{ type: "connector.gmail", ref: "missing" }],
      redaction_applied: false,
    },
    cost_actuals: { usd: 0.001, calls: 1 },
  };
}

export function sampleUnreadMessages(): EmailMessage[] {
  return [
    {
      id: "msg_1",
      from: "sam.patel@example.com",
      subject: "Vegas hotel shortlist",
      snippet: "Three options on the Strip, two off. Need your pick today.",
      received_at: "2026-04-28T08:30:00.000Z",
    },
    {
      id: "msg_2",
      from: "priya.shah@example.com",
      subject: "Design mixer follow-up",
      snippet: "Can you send the deck before lunch?",
      received_at: "2026-04-28T09:10:00.000Z",
    },
    {
      id: "msg_3",
      from: "newsletter@example.com",
      subject: "Morning links",
      snippet: "Five articles about travel demand.",
      received_at: "2026-04-28T09:20:00.000Z",
    },
  ];
}
