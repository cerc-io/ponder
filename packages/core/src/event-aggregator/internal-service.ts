import { type Hex } from "viem";

import type { LogFilterName } from "@/build/handlers";
import type { LogEventMetadata, LogFilter } from "@/config/logFilters";
import type { Network } from "@/config/networks";
import type { EventStore } from "@/event-store/store";
import type { Common } from "@/Ponder";

import { EventAggregatorService } from "./service.js";

export class InternalEventAggregatorService extends EventAggregatorService {
  private eventStore: EventStore;

  constructor({
    common,
    eventStore,
    networks,
    logFilters,
  }: {
    common: Common;
    eventStore: EventStore;
    networks: Network[];
    logFilters: LogFilter[];
  }) {
    super({
      common,
      networks,
      logFilters,
    });

    this.eventStore = eventStore;
  }

  /** Fetches events for all registered log filters between the specified timestamps.
   *
   * @param options.fromTimestamp Timestamp to start including events (inclusive).
   * @param options.toTimestamp Timestamp to stop including events (inclusive).
   * @param options.includeLogFilterEvents Map of log filter name -> selector -> ABI event item for which to include full event objects.
   * @returns A promise resolving to an array of log events.
   */
  async *getEvents({
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
  }) {
    const iterator = this.eventStore.getLogEvents({
      fromTimestamp,
      toTimestamp,
      filters: this.logFilters.map((logFilter) => ({
        name: logFilter.name,
        chainId: logFilter.filter.chainId,
        address: logFilter.filter.address,
        topics: logFilter.filter.topics,
        fromBlock: logFilter.filter.startBlock,
        toBlock: logFilter.filter.endBlock,
        includeEventSelectors: Object.keys(
          includeLogFilterEvents[logFilter.name]?.bySelector ?? {}
        ) as Hex[],
      })),
    });

    for await (const page of iterator) {
      const { events, metadata } = page;

      const decodedEvents = this.decodeEvents(events, includeLogFilterEvents);

      yield { events: decodedEvents, metadata };
    }
  }
}
