import type {
  ApolloClient,
  DocumentNode,
  NormalizedCacheObject,
  ObservableSubscription,
} from "@apollo/client";
import apolloClientPkg from "@apollo/client";
import type { Address } from "viem";
import { type Hex } from "viem";

import type { LogFilterName } from "@/build/handlers";
import type { LogEventMetadata, LogFilter } from "@/config/logFilters";
import type { Network } from "@/config/networks";
import type { Common } from "@/Ponder";
import type { Block } from "@/types/block";
import type { Log } from "@/types/log";
import type { Transaction } from "@/types/transaction";

import { EventAggregatorService } from "./service.js";

const { gql } = apolloClientPkg;

type Cursor = {
  timestamp: number;
  chainId: number;
  blockNumber: number;
  logIndex: number;
};

export class GqlEventAggregatorService extends EventAggregatorService {
  private gqlClient: ApolloClient<NormalizedCacheObject>;
  private subscriptions: ObservableSubscription[] = [];

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
    super({
      common,
      networks,
      logFilters,
    });

    this.metrics = {};

    this.gqlClient = gqlClient;
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

      const decodedEvents = this.decodeEvents(events, includeLogFilterEvents);

      yield { events: decodedEvents, metadata };

      if (metadata.isLastPage) break;
    }
  }

  override async subscribeToSyncEvents() {
    this.subscriptions = [
      this.subscribeGql(
        gql`
          subscription {
            onNewHistoricalCheckpoint {
              chainId
              timestamp
            }
          }
        `,
        ({ data }) => {
          this.handleNewHistoricalCheckpoint(data.onNewHistoricalCheckpoint);
        }
      ),
      this.subscribeGql(
        gql`
          subscription {
            onHistoricalSyncComplete {
              chainId
            }
          }
        `,
        ({ data }) => {
          this.handleHistoricalSyncComplete(data.onHistoricalSyncComplete);
        }
      ),
      this.subscribeGql(
        gql`
          subscription {
            onNewRealtimeCheckpoint {
              chainId
              timestamp
            }
          }
        `,
        ({ data }) => {
          this.handleNewRealtimeCheckpoint(data.onNewRealtimeCheckpoint);
        }
      ),
      this.subscribeGql(
        gql`
          subscription {
            onNewFinalityCheckpoint {
              chainId
              timestamp
            }
          }
        `,
        ({ data }) => {
          this.handleNewFinalityCheckpoint(data.onNewFinalityCheckpoint);
        }
      ),
      this.subscribeGql(
        gql`
          subscription {
            onReorg {
              commonAncestorTimestamp
            }
          }
        `,
        ({ data }) => {
          this.handleReorg(data.onReorg);
        }
      ),
    ];

    await this.fetchHistoricalSync();
  }

  override kill() {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.clearListeners();
  }

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
    // Sanitize filter values for GQL query
    if (variables.filters) {
      variables.filters.forEach((filter) => {
        if (filter.address && !Array.isArray(filter.address)) {
          filter.address = [filter.address];
        }

        if (filter.topics) {
          filter.topics = filter.topics.map((topic) =>
            topic && !Array.isArray(topic) ? [topic] : topic
          );
        }
      });
    }

    const {
      data: { getLogEvents },
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

    // Remove __typename from GQL query result
    const {
      __typename,
      cursor: gqlCursor,
      ...metadata
    } = getLogEvents.metadata;
    let cursor: Cursor | undefined;

    if (gqlCursor) {
      const { __typename, ...cursorData } = gqlCursor;
      cursor = cursorData;
    }

    return {
      events: getLogEvents.events.map((event: any) => ({
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
      metadata: {
        ...metadata,
        cursor,
      },
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
        cursor?: Cursor;
        isLastPage: boolean;
      };
    };
  };

  private subscribeGql(query: DocumentNode, onNext: (value: any) => void) {
    const observable = this.gqlClient.subscribe({ query });

    return observable.subscribe({
      next(data) {
        onNext(data);
      },
    });
  }

  private async fetchHistoricalSync() {
    const queryPromises = Object.keys(this.networkCheckpoints).map(
      async (chainId) => {
        const {
          data: { getNetworkHistoricalSync },
        } = await this.gqlClient.query({
          query: gql`
            query getNetworkHistoricalSync($chainId: Int!) {
              getNetworkHistoricalSync(chainId: $chainId) {
                checkpoint
                isSyncComplete
              }
            }
          `,
          variables: { chainId: Number(chainId) },
        });

        const { checkpoint, isSyncComplete } = getNetworkHistoricalSync;

        if (checkpoint) {
          this.handleNewHistoricalCheckpoint({
            chainId: Number(chainId),
            timestamp: checkpoint,
          });
        }

        if (isSyncComplete) {
          this.handleHistoricalSyncComplete({ chainId: Number(chainId) });
        }
      }
    );

    await Promise.all(queryPromises);
  }
}
