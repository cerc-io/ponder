import type { IFieldResolver, IResolvers } from "@graphql-tools/utils";
import type { PubSub } from "graphql-subscriptions";
import { createRequire } from "node:module";

import type { EventStore } from "@/event-store/store.js";
import { blobToBigInt } from "@/utils/decode.js";
import { intToBlob } from "@/utils/encode.js";

export const HISTORICAL_CHECKPOINT = "historicalCheckpoint";
export const SYNC_COMPLETE = "syncComplete";
export const REALTIME_CHECKPOINT = "realtimeCheckpoint";
export const FINALITY_CHECKPOINT = "finalityCheckpoint";
export const SHALLOW_REORG = "shallowReorg";

const require = createRequire(import.meta.url);
const { default: ApolloBigInt } = require("apollo-type-bigint");

const PAGE_SIZE = 10_000;

export type NetworkCheckpoints = Record<
  number,
  {
    isHistoricalSyncComplete: boolean;
    historicalCheckpoint: number;
  }
>;

export const getResolvers = ({
  eventStore,
  pubsub,
  networkCheckpoints,
}: {
  eventStore: EventStore;
  pubsub: PubSub;
  networkCheckpoints: NetworkCheckpoints;
}): IResolvers<any, unknown> => {
  const getLogEvents: IFieldResolver<any, unknown> = async (_, args) => {
    const { fromTimestamp, toTimestamp, filters, cursor } = args;

    const iterator = eventStore.getLogEvents({
      fromTimestamp,
      toTimestamp,
      filters,
      cursor: cursor && {
        ...cursor,
        timestamp: intToBlob(cursor.timestamp),
        blockNumber: intToBlob(cursor.blockNumber),
      },
      pageSize: PAGE_SIZE,
    });

    for await (const page of iterator) {
      const { events, metadata } = page;

      return {
        events,
        metadata: {
          ...metadata,
          cursor: metadata.cursor && {
            ...metadata.cursor,
            timestamp: Number(blobToBigInt(metadata.cursor.timestamp)),
            blockNumber: Number(blobToBigInt(metadata.cursor.blockNumber)),
          },
          isLastPage: events.length < PAGE_SIZE,
        },
      };
    }

    throw new Error("getLogEvents iterator should run atleast once");
  };

  const getNetworkHistoricalSync: IFieldResolver<any, unknown> = async (
    _,
    args
  ) => {
    const { chainId } = args;
    const { historicalCheckpoint, isHistoricalSyncComplete } =
      networkCheckpoints[chainId];

    return {
      checkpoint: historicalCheckpoint,
      isSyncComplete: isHistoricalSyncComplete,
    };
  };

  const getEthLogs: IFieldResolver<any, unknown> = async (_, args) => {
    const { chainId, ...filterArgs } = args;

    // Log type returned by getEthLogs satisfied RpcLog type in viem
    return eventStore.getEthLogs({
      chainId: args.chainId,
      ...filterArgs,
    });
  };

  return {
    BigInt: new ApolloBigInt("bigInt"),

    Query: {
      getLogEvents,
      getNetworkHistoricalSync,
      getEthLogs,
    },

    Subscription: {
      onNewHistoricalCheckpoint: {
        subscribe: () => pubsub.asyncIterator(HISTORICAL_CHECKPOINT),
      },
      onHistoricalSyncComplete: {
        subscribe: () => pubsub.asyncIterator(SYNC_COMPLETE),
      },
      onNewRealtimeCheckpoint: {
        subscribe: () => pubsub.asyncIterator(REALTIME_CHECKPOINT),
      },
      onNewFinalityCheckpoint: {
        subscribe: () => pubsub.asyncIterator(FINALITY_CHECKPOINT),
      },
      onReorg: {
        subscribe: () => pubsub.asyncIterator(SHALLOW_REORG),
      },
    },
  };
};
