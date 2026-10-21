import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The slice of the SDK's query() that one-shot runs use, injectable so
 *  tests can drive fake streams (hung, result-less, throwing, errored). */
export type QueryFactory = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export const sdkQuery: QueryFactory = query;

/** A warm streaming-input query: the messages it streams plus the controls
 *  a live session uses between and during turns. */
export type LiveQuery = AsyncIterable<SDKMessage> &
  Pick<Query, "interrupt" | "setModel" | "applyFlagSettings">;

/** The slice of query() live (interactive) sessions use: the prompt is the
 *  session's input stream. Injectable so tests drive fake CLI processes. */
export type LiveQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => LiveQuery;

export const sdkLiveQuery: LiveQueryFactory = query;
