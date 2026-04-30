import {
  getProfile,
  listHighConfidencePatterns,
  retrieveRelevantFacts,
} from "../../memory.ts";
import { SubAgent } from "../subagent-base.ts";
import type { MeshSubagentInput } from "../supervisor.ts";

export interface MemoryRetrievalResult {
  profilePresent: boolean;
  homeCity: string | null;
  preferredAirlineSeat: string | null;
  preferredAirlineClass: string | null;
  facts: Array<{ category: string; fact: string; confidence: number }>;
  patterns: Array<{ kind: string; description: string; confidence: number }>;
}

export function createMemoryRetrievalSubAgent(): SubAgent<MeshSubagentInput, MemoryRetrievalResult> {
  return new SubAgent<MeshSubagentInput, MemoryRetrievalResult>({
    name: "memory-retrieval",
    model: "fast",
    timeoutMs: 800,
    run: async (input) => {
      if (!input.userId || input.userId === "anon") {
        return emptyMemoryResult();
      }
      const [profile, facts, patterns] = await Promise.all([
        getProfile(input.userId),
        retrieveRelevantFacts(input.userId, input.query, 8),
        listHighConfidencePatterns(input.userId, 0.7, 8),
      ]);
      return {
        profilePresent: profile !== null,
        homeCity: profile?.home_address?.city ?? null,
        preferredAirlineSeat: profile?.preferred_airline_seat ?? null,
        preferredAirlineClass: profile?.preferred_airline_class ?? null,
        facts: facts.slice(0, 8).map((fact) => ({
          category: fact.category,
          fact: fact.fact,
          confidence: fact.confidence,
        })),
        patterns: patterns.slice(0, 8).map((pattern) => ({
          kind: pattern.pattern_kind,
          description: pattern.description,
          confidence: pattern.confidence,
        })),
      };
    },
    fallback: async () => emptyMemoryResult(),
    summarize: (result) => {
      const prefs = [
        result.homeCity ? `home city ${result.homeCity}` : null,
        result.preferredAirlineClass ? `${result.preferredAirlineClass} cabin` : null,
        result.preferredAirlineSeat ? `${result.preferredAirlineSeat} seat` : null,
      ].filter(Boolean);
      return [
        result.profilePresent ? "profile present" : "no profile",
        prefs.length ? `preferences: ${prefs.join(", ")}` : "no flight preferences",
        `${result.facts.length} relevant facts`,
        `${result.patterns.length} patterns`,
      ].join("; ");
    },
  });
}

function emptyMemoryResult(): MemoryRetrievalResult {
  return {
    profilePresent: false,
    homeCity: null,
    preferredAirlineSeat: null,
    preferredAirlineClass: null,
    facts: [],
    patterns: [],
  };
}
