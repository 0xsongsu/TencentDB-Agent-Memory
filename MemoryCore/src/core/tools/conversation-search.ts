/**
 * conversation_search tool: Agent-callable tool for searching L0 conversation records.
 *
 * Supports three search strategies with automatic degradation:
 *   1. **hybrid** (default) — FTS5 keyword + vector embedding in parallel,
 *      merged with explicit keyword/vector candidate slots.
 *   2. **embedding** — pure vector similarity (when FTS5 is unavailable).
 *   3. **fts** — pure FTS5 keyword search (when embedding is unavailable).
 *
 * The tool is registered via `api.registerTool()` in index.ts.
 */

import type {
  IMemoryStore,
  IsolationFilter,
  L0SearchResult,
} from "../store/types.js";
import { buildFtsQuery } from "../store/tokenize.js";
import {
  hasClientEmbedding,
  embeddingSearchQuery,
  type EmbeddingService,
} from "../store/embedding.js";
import type { Logger } from "../types.js";

// ============================
// Types
// ============================

export interface ConversationSearchResultItem {
  id: string;
  session_key: string;
  session_id: string;
  user_id: string;
  agent_id: string;
  /** Role of the message sender: "user" or "assistant" */
  role: string;
  /** Text content of this single message */
  content: string;
  score: number;
  recorded_at: string;
  timestamp: number;
}

export interface ConversationSearchResult {
  results: ConversationSearchResultItem[];
  total: number;
  /** Actual search strategy used: "hybrid", "embedding", "fts", or "none". */
  strategy: string;
  /** Optional message, e.g. when embedding is not configured. */
  message?: string;
}

const TAG = "[memory-tdai][tdai_conversation_search]";

function buildAnchorFtsQuery(raw: string): string | null {
  const monthAnchors = [...raw.matchAll(/20\d{2}年\s*(1[0-2]|0?[1-9])月/g)].map(
    (match) => match[1].padStart(2, "0"),
  );
  const anchors = [
    ...new Set([
      ...(raw.match(
        /[A-Z][A-Z0-9.-]{1,}|[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+|20\d{2}/g,
      ) ?? []),
      ...monthAnchors,
    ]),
  ].filter((value) => value !== "AI" && value !== "OS");
  return anchors.length > 0
    ? anchors.map((value) => `"${value}"`).join(" AND ")
    : null;
}

function normalizedSearchText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

// ============================
// Hybrid result merge
// ============================

function mergeHybridL0(
  ftsItems: ConversationSearchResultItem[],
  vecItems: ConversationSearchResultItem[],
  limit: number,
): ConversationSearchResultItem[] {
  const ftsSlots = Math.max(1, Math.floor(limit * 0.5));
  const ranked = [
    ...ftsItems.slice(0, ftsSlots),
    ...vecItems.slice(0, limit - ftsSlots),
    ...ftsItems.slice(ftsSlots),
    ...vecItems.slice(limit - ftsSlots),
  ];
  const seen = new Set<string>();
  return ranked.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// ============================
// Search implementation
// ============================

export async function executeConversationSearch(params: {
  query: string;
  limit: number;
  sessionKey?: string;
  filter?: IsolationFilter;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<ConversationSearchResult> {
  const {
    query,
    limit,
    sessionKey: sessionFilter,
    filter: isolationFilter,
    vectorStore,
    embeddingService,
    logger,
  } = params;

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
      `sessionFilter=${sessionFilter ?? "(none)"}, ` +
      `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
      `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  if (!query || query.trim().length === 0) {
    logger?.debug?.(`${TAG} Empty query, returning empty`);
    return { results: [], total: 0, strategy: "none" };
  }

  if (!vectorStore) {
    logger?.warn?.(`${TAG} VectorStore not available`);
    return { results: [], total: 0, strategy: "none" };
  }

  // ── Determine available capabilities ──
  const hasEmbedding = hasClientEmbedding(embeddingService);
  const hasFts = vectorStore.isFtsAvailable();

  if (!hasEmbedding && !hasFts) {
    logger?.warn?.(
      `${TAG} Neither EmbeddingService nor FTS5 available — cannot search`,
    );
    return {
      results: [],
      total: 0,
      strategy: "none",
      message:
        "Embedding service is not configured and FTS is not available. " +
        "Conversation search requires an embedding provider or FTS5 support. " +
        "Please configure an embedding provider in the embedding.provider setting (e.g. openai_compatible).",
    };
  }

  // ── Over-retrieve for later filtering and RRF merging ──
  const candidateK = sessionFilter ? limit * 4 : limit * 3;

  // ── Native hybrid short-circuit (TCVDB) ──
  // If the store natively supports hybrid search (dense + sparse + RRF in a
  // single API call), skip the dual-path FTS+Vector logic to avoid a redundant
  // second HTTP request with garbled FTS tokens as embedding input.
  if (
    vectorStore.getCapabilities().nativeHybridSearch &&
    vectorStore.searchL0Hybrid
  ) {
    logger?.debug?.(`${TAG} [native-hybrid] Single-call hybrid search...`);
    const results = await vectorStore.searchL0Hybrid(
      isolationFilter
        ? { query, topK: candidateK, filter: isolationFilter }
        : { query, topK: candidateK },
    );
    let items: ConversationSearchResultItem[] = results.map((r) => ({
      id: r.record_id,
      session_key: r.session_key,
      session_id: r.session_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      role: r.role,
      content: r.message_text,
      score: r.score,
      recorded_at: r.recorded_at,
      timestamp: r.timestamp,
    }));

    // Apply session filter
    if (sessionFilter) {
      items = items.filter((r) => r.session_key === sessionFilter);
    }
    const trimmed = items.slice(0, limit);
    logger?.debug?.(
      `${TAG} RESULT (strategy=native-hybrid): returning ${trimmed.length} messages ` +
        `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
    );
    return { results: trimmed, total: trimmed.length, strategy: "hybrid" };
  }

  const queryEmbedding = hasEmbedding
    ? embeddingService!.embed(embeddingSearchQuery(embeddingService!, query))
    : undefined;

  // ── SQLite dual-path: run FTS5 + Vector in parallel, merge explicit slots ──
  const [ftsItems, vecItems] = await Promise.all([
    // FTS5 keyword search on L0
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        const broadFtsQuery = buildFtsQuery(query);
        if (!broadFtsQuery) {
          logger?.debug?.(
            `${TAG} [hybrid-fts] No usable FTS tokens from query`,
          );
          return [];
        }
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 query: "${broadFtsQuery}"`);
        const broadResults = await vectorStore.searchL0Fts(
          broadFtsQuery,
          candidateK,
          isolationFilter,
        );
        const normalizedQuery = normalizedSearchText(query);
        const queryTerms = normalizedQuery
          .split(" ")
          .filter((term) => term.length >= 2);
        const exactMatch = broadResults.some((result) => {
          const content = normalizedSearchText(result.message_text);
          return (
            content.includes(normalizedQuery) ||
            (queryTerms.length >= 2 &&
              queryTerms.every((term) => content.includes(term)))
          );
        });
        const strictFtsQuery = broadFtsQuery.replaceAll(" OR ", " AND ");
        const strictMatch =
          exactMatch || strictFtsQuery === broadFtsQuery
            ? exactMatch || broadResults.length > 0
            : (
                await vectorStore.searchL0Fts(
                  strictFtsQuery,
                  1,
                  isolationFilter,
                )
              ).length > 0;
        const ftsResults =
          strictMatch || !queryEmbedding
            ? broadResults
            : await vectorStore.searchL0Fts(
                buildAnchorFtsQuery(query) ?? broadFtsQuery,
                candidateK,
                isolationFilter,
                await queryEmbedding,
              );
        logger?.debug?.(
          `${TAG} [hybrid-fts] FTS5 returned ${ftsResults.length} candidates`,
        );
        return ftsResults.map((r) => ({
          id: r.record_id,
          session_key: r.session_key,
          session_id: r.session_id,
          user_id: r.user_id,
          agent_id: r.agent_id,
          role: r.role,
          content: r.message_text,
          score: r.score,
          recorded_at: r.recorded_at,
          timestamp: r.timestamp,
        }));
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-fts] FTS5 search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),

    // Vector embedding search on L0
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        logger?.debug?.(`${TAG} [hybrid-vec] Generating query embedding...`);
        const embedding = await queryEmbedding!;
        logger?.debug?.(
          `${TAG} [hybrid-vec] Embedding OK, dims=${embedding.length}, searching top-${candidateK}...`,
        );
        const vecResults: L0SearchResult[] = isolationFilter
          ? await vectorStore.searchL0Vector(
              embedding,
              candidateK,
              query,
              isolationFilter,
            )
          : await vectorStore.searchL0Vector(embedding, candidateK, query);
        logger?.debug?.(
          `${TAG} [hybrid-vec] Vector search returned ${vecResults.length} candidates`,
        );
        return vecResults.map((r) => ({
          id: r.record_id,
          session_key: r.session_key,
          session_id: r.session_id,
          user_id: r.user_id,
          agent_id: r.agent_id,
          role: r.role,
          content: r.message_text,
          score: r.score,
          recorded_at: r.recorded_at,
          timestamp: r.timestamp,
        }));
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-vec] Embedding search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),
  ]);

  // ── Determine effective strategy ──
  const ftsOk = ftsItems.length > 0;
  const vecOk = vecItems.length > 0;
  let strategy: string;

  if (ftsOk && vecOk) {
    strategy = "hybrid";
  } else if (vecOk) {
    strategy = "embedding";
  } else if (ftsOk) {
    strategy = "fts";
  } else {
    logger?.debug?.(`${TAG} Both search paths returned 0 results`);
    return {
      results: [],
      total: 0,
      strategy: hasEmbedding ? "embedding" : "fts",
    };
  }

  // ── Merge results ──
  let results: ConversationSearchResultItem[];
  if (strategy === "hybrid") {
    results = mergeHybridL0(ftsItems, vecItems, limit);
    logger?.debug?.(
      `${TAG} [hybrid] Slot merged: fts=${ftsItems.length}, vec=${vecItems.length} → ${results.length} unique`,
    );
  } else {
    // Single-source: use whichever list has results (already sorted by score)
    results = ftsOk ? ftsItems : vecItems;
  }

  // ── Apply session key filter ──
  if (sessionFilter) {
    const preFilterCount = results.length;
    results = results.filter((r) => r.session_key === sessionFilter);
    logger?.debug?.(
      `${TAG} After session filter "${sessionFilter}": ${results.length}/${preFilterCount}`,
    );
  }

  // ── Trim to requested limit ──
  const trimmed = results.slice(0, limit);

  logger?.debug?.(
    `${TAG} RESULT (strategy=${strategy}): returning ${trimmed.length} messages ` +
      `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
  );

  return {
    results: trimmed,
    total: trimmed.length,
    strategy,
  };
}

// ============================
// Tool response formatter
// ============================

export function formatConversationSearchResponse(
  result: ConversationSearchResult,
): string {
  if (result.message) {
    return result.message;
  }
  if (result.results.length === 0) {
    return "No matching conversation messages found.";
  }

  const lines: string[] = [`Found ${result.total} matching message(s):`, ""];

  for (const item of result.results) {
    const scoreStr =
      typeof item.score === "number"
        ? ` (score: ${item.score.toFixed(3)})`
        : "";
    const dateStr = item.recorded_at ? ` [${item.recorded_at}]` : "";
    lines.push(`---`);
    lines.push(
      `**[${item.role}]** Session: ${item.session_key}${dateStr}${scoreStr}`,
    );
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }

  return lines.join("\n");
}
