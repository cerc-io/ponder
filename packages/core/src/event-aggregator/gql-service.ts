import type { ApolloClient, NormalizedCacheObject } from "@apollo/client";
import Emittery from "emittery";
import { type Hex, Address, decodeEventLog } from "viem";

import type { LogFilterName } from "@/build/handlers";
import type { LogEventMetadata, LogFilter } from "@/config/logFilters";
import type { Network } from "@/config/networks";
import type { Common } from "@/Ponder";
import type { Block } from "@/types/block";
import type { Log } from "@/types/log";
import type { Transaction } from "@/types/transaction";
import { formatShortDate } from "@/utils/date";

import type {
  EventAggregatorEvents,
  EventAggregatorMetrics,
  EventAggregatorService,
  LogEvent,
} from "./service";

type Cursor = {
  timestamp: number;
  chainId: number;
  blockNumber: number;
  logIndex: number;
};

export class GqlEventAggregatorService
  extends Emittery<EventAggregatorEvents>
  implements EventAggregatorService
{
  private common: Common;
  // TODO: Replace with actual type
  private gqlClient: ApolloClient<NormalizedCacheObject>;
  private logFilters: LogFilter[];
  private networks: Network[];

  // Minimum timestamp at which events are available (across all networks).
  checkpoint: number;
  // Minimum finalized timestamp (across all networks).
  finalityCheckpoint: number;

  // Timestamp at which the historical sync was completed (across all networks).
  historicalSyncCompletedAt?: number;

  // Per-network event timestamp checkpoints.
  private networkCheckpoints: Record<
    number,
    {
      isHistoricalSyncComplete: boolean;
      historicalCheckpoint: number;
      realtimeCheckpoint: number;
      finalityCheckpoint: number;
    }
  >;

  metrics: EventAggregatorMetrics;

  constructor({
    common,
    gqlClient,
    networks,
    logFilters,
  }: {
    common: Common;
    gqlClient: ApolloClient<NormalizedCacheObject>;
    networks: Network[];
    logFilters: LogFilter[];
  }) {
    super();

    this.common = common;
    this.logFilters = logFilters;
    this.networks = networks;
    this.metrics = {};

    this.gqlClient = gqlClient;

    this.checkpoint = 0;
    this.finalityCheckpoint = 0;

    this.networkCheckpoints = {};
    this.networks.forEach((network) => {
      this.networkCheckpoints[network.chainId] = {
        isHistoricalSyncComplete: false,
        historicalCheckpoint: 0,
        realtimeCheckpoint: 0,
        finalityCheckpoint: 0,
      };
    });
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
    let cursor: Cursor | undefined;

    while (true) {
      const { events, metadata } = await this.getLogEvents({
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
        cursor,
      });

      // Set cursor to fetch next batch of events from indexingClient GQL query
      cursor = metadata.cursor;

      const decodedEvents = events.reduce<LogEvent[]>((acc, event) => {
        const selector = event.log.topics[0];
        if (!selector) {
          throw new Error(
            `Received an event log with no selector: ${event.log}`
          );
        }

        const logEventMetadata =
          includeLogFilterEvents[event.logFilterName]?.bySelector[selector];
        if (!logEventMetadata) {
          throw new Error(
            `Metadata for event ${event.logFilterName}:${selector} not found in includeLogFilterEvents`
          );
        }
        const { abiItem, safeName } = logEventMetadata;

        try {
          const decodedLog = decodeEventLog({
            abi: [abiItem],
            data: event.log.data,
            topics: event.log.topics,
          });

          acc.push({
            logFilterName: event.logFilterName,
            eventName: safeName,
            params: decodedLog.args || {},
            log: event.log,
            block: event.block,
            transaction: event.transaction,
          });
        } catch (err) {
          // TODO: emit a warning here that a log was not decoded.
          this.common.logger.error({
            service: "app",
            msg: `Unable to decode log (skipping it): ${event.log}`,
            error: err as Error,
          });
        }

        return acc;
      }, []);

      yield { events: decodedEvents, metadata };

      if (metadata.isLastPage) break;
    }
  }

  // TODO: Refactor common methods in event aggregator services
  handleNewHistoricalCheckpoint = ({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }) => {
    this.networkCheckpoints[chainId].historicalCheckpoint = timestamp;

    this.common.logger.trace({
      service: "aggregator",
      msg: `New historical checkpoint at ${timestamp} [${formatShortDate(
        timestamp
      )}] (chainId=${chainId})`,
    });

    this.recalculateCheckpoint();
  };

  handleHistoricalSyncComplete = ({ chainId }: { chainId: number }) => {
    this.networkCheckpoints[chainId].isHistoricalSyncComplete = true;
    this.recalculateCheckpoint();

    // If every network has completed the historical sync, set the metric.
    const networkCheckpoints = Object.values(this.networkCheckpoints);
    if (networkCheckpoints.every((n) => n.isHistoricalSyncComplete)) {
      const maxHistoricalCheckpoint = Math.max(
        ...networkCheckpoints.map((n) => n.historicalCheckpoint)
      );
      this.historicalSyncCompletedAt = maxHistoricalCheckpoint;

      this.common.logger.debug({
        service: "aggregator",
        msg: `Completed historical sync across all networks`,
      });
    }
  };

  handleNewRealtimeCheckpoint = ({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }) => {
    this.networkCheckpoints[chainId].realtimeCheckpoint = timestamp;

    this.common.logger.trace({
      service: "aggregator",
      msg: `New realtime checkpoint at ${timestamp} [${formatShortDate(
        timestamp
      )}] (chainId=${chainId})`,
    });

    this.recalculateCheckpoint();
  };

  handleNewFinalityCheckpoint = ({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }) => {
    this.networkCheckpoints[chainId].finalityCheckpoint = timestamp;
    this.recalculateFinalityCheckpoint();
  };

  handleReorg = ({
    commonAncestorTimestamp,
  }: {
    commonAncestorTimestamp: number;
  }) => {
    this.emit("reorg", { commonAncestorTimestamp });
  };

  private recalculateCheckpoint = () => {
    const checkpoints = Object.values(this.networkCheckpoints).map((n) =>
      n.isHistoricalSyncComplete
        ? Math.max(n.historicalCheckpoint, n.realtimeCheckpoint)
        : n.historicalCheckpoint
    );
    const newCheckpoint = Math.min(...checkpoints);

    if (newCheckpoint > this.checkpoint) {
      this.checkpoint = newCheckpoint;

      this.common.logger.trace({
        service: "aggregator",
        msg: `New event checkpoint at ${this.checkpoint} [${formatShortDate(
          this.checkpoint
        )}]`,
      });

      this.emit("newCheckpoint", { timestamp: this.checkpoint });
    }
  };

  private recalculateFinalityCheckpoint = () => {
    const newFinalityCheckpoint = Math.min(
      ...Object.values(this.networkCheckpoints).map((n) => n.finalityCheckpoint)
    );

    if (newFinalityCheckpoint > this.finalityCheckpoint) {
      this.finalityCheckpoint = newFinalityCheckpoint;

      this.common.logger.trace({
        service: "aggregator",
        msg: `New finality checkpoint at ${
          this.finalityCheckpoint
        } [${formatShortDate(this.finalityCheckpoint)}]`,
      });

      this.emit("newFinalityCheckpoint", {
        timestamp: this.finalityCheckpoint,
      });
    }
  };

  private getLogEvents = async (variables: {
    fromTimestamp: number;
    toTimestamp: number;
    filters?: {
      name: string;
      chainId: number;
      address?: Address | Address[];
      topics?: (Hex | Hex[] | null)[];
      fromBlock?: number;
      toBlock?: number;
      includeEventSelectors?: Hex[];
    }[];
    cursor?: Cursor;
  }) => {
    const { gql } = await import("@apollo/client/core");

    const {
      data: {
        getLogEvents: { events, metadata },
      },
    } = await this.gqlClient.query({
      query: gql`
        query getLogEvents(
          $fromTimestamp: Int!
          $toTimestamp: Int!
          $filters: [Filter!]
          $cursor: CursorInput
        ) {
          getLogEvents(
            fromTimestamp: $fromTimestamp
            toTimestamp: $toTimestamp
            filters: $filters
            cursor: $cursor
          ) {
            events {
              logFilterName
              log {
                id
                address
                blockHash
                blockNumber
                data
                logIndex
                removed
                topics
                transactionHash
                transactionIndex
              }
              block {
                baseFeePerGas
                difficulty
                extraData
                gasLimit
                gasUsed
                hash
                logsBloom
                miner
                mixHash
                nonce
                number
                parentHash
                receiptsRoot
                sha3Uncles
                size
                stateRoot
                timestamp
                totalDifficulty
                transactionsRoot
              }
              transaction {
                blockHash
                blockNumber
                from
                gas
                hash
                input
                nonce
                r
                s
                to
                transactionIndex
                v
                value
                type
                gasPrice
                accessList {
                  address
                  storageKeys
                }
                maxFeePerGas
                maxPriorityFeePerGas
              }
            }
            metadata {
              pageEndsAtTimestamp
              counts {
                logFilterName
                selector
                count
              }
              cursor {
                timestamp
                chainId
                blockNumber
                logIndex
              }
              isLastPage
            }
          }
        }
      `,
      variables,
    });

    return {
      events: events.map((event: any) => ({
        ...event,
        log: {
          ...event.log,
          blockNumber: BigInt(event.log.blockNumber),
        },
        block: {
          ...event.block,
          baseFeePerGas:
            event.block.baseFeePerGas && BigInt(event.block.baseFeePerGas),
          difficulty: BigInt(event.block.difficulty),
          gasLimit: BigInt(event.block.gasLimit),
          gasUsed: BigInt(event.block.gasUsed),
          number: BigInt(event.block.number),
          size: BigInt(event.block.size),
          timestamp: BigInt(event.block.timestamp),
          totalDifficulty: BigInt(event.block.totalDifficulty),
        },
        transaction: {
          ...event.transaction,
          blockNumber: BigInt(event.transaction.blockNumber),
          gas: BigInt(event.transaction.gas),
          v: BigInt(event.transaction.v),
          value: BigInt(event.transaction.value),
          gasPrice:
            event.transaction.gasPrice && BigInt(event.transaction.gasPrice),
          maxFeePerGas:
            event.transaction.maxFeePerGas &&
            BigInt(event.transaction.maxFeePerGas),
          maxPriorityFeePerGas:
            event.transaction.maxPriorityFeePerGas &&
            BigInt(event.transaction.maxPriorityFeePerGas),
        },
      })),
      metadata,
    } as {
      events: {
        logFilterName: string;
        log: Log;
        block: Block;
        transaction: Transaction;
      }[];
      metadata: {
        pageEndsAtTimestamp: number;
        counts: any[];
        cursor: Cursor;
        isLastPage: boolean;
      };
    };
  };
}
