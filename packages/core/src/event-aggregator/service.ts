import type Emittery from "emittery";
import type { Hex } from "viem";

import type { LogFilterName } from "@/build/handlers.js";
import type { LogEventMetadata } from "@/config/logFilters.js";
import type { Block } from "@/types/block.js";
import type { Log } from "@/types/log.js";
import type { Transaction } from "@/types/transaction.js";

export type LogEvent = {
  logFilterName: string;
  eventName: string;
  params: any;
  log: Log;
  block: Block;
  transaction: Transaction;
};

export type EventAggregatorEvents = {
  /**
   * Emitted when a new event checkpoint is reached. This is the minimum timestamp
   * at which events are available across all registered networks.
   */
  newCheckpoint: { timestamp: number };
  /**
   * Emitted when a new finality checkpoint is reached. This is the minimum timestamp
   * at which events are finalized across all registered networks.
   */
  newFinalityCheckpoint: { timestamp: number };
  /**
   * Emitted when a reorg has been detected on any registered network.
   */
  reorg: { commonAncestorTimestamp: number };
};

export type EventAggregatorMetrics = {};

export interface EventAggregatorService
  extends Emittery<EventAggregatorEvents> {
  // Minimum timestamp at which events are available (across all networks).
  checkpoint: number;
  // Minimum finalized timestamp (across all networks).
  finalityCheckpoint: number;

  // Timestamp at which the historical sync was completed (across all networks).
  historicalSyncCompletedAt?: number;

  metrics: EventAggregatorMetrics;

  /** Fetches events for all registered log filters between the specified timestamps.
   *
   * @param options.fromTimestamp Timestamp to start including events (inclusive).
   * @param options.toTimestamp Timestamp to stop including events (inclusive).
   * @param options.includeLogFilterEvents Map of log filter name -> selector -> ABI event item for which to include full event objects.
   * @returns A promise resolving to an array of log events.
   */
  getEvents({
    fromTimestamp,
    toTimestamp,
    includeLogFilterEvents,
  }: {
    fromTimestamp: number;
    toTimestamp: number;
    includeLogFilterEvents: {
      [logFilterName: LogFilterName]:
        | {
            bySelector: { [selector: Hex]: LogEventMetadata };
          }
        | undefined;
    };
  }): AsyncGenerator<{
    events: LogEvent[];
    metadata: {
      pageEndsAtTimestamp: number;
      counts: {
        logFilterName: string;
        selector: Hex;
        count: number;
      }[];
    };
  }>;

  handleNewHistoricalCheckpoint({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }): void;

  handleHistoricalSyncComplete({ chainId }: { chainId: number }): void;

  handleNewRealtimeCheckpoint({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }): void;

  handleNewFinalityCheckpoint({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }): void;

  handleReorg({
    commonAncestorTimestamp,
  }: {
    commonAncestorTimestamp: number;
  }): void;
}
