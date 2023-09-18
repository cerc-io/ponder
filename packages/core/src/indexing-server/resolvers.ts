import type { IFieldResolver, IResolvers } from "@graphql-tools/utils";
import ApolloBigInt from "apollo-type-bigint";
import { PubSub } from "graphql-subscriptions";

import { EventStore } from "@/event-store/store";
import { blobToBigInt } from "@/utils/decode";
import { intToBlob } from "@/utils/encode";

export const HISTORICAL_CHECKPOINT = "historicalCheckpoint";
export const SYNC_COMPLETE = "syncComplete";
export const REALTIME_CHECKPOINT = "realtimeCheckpoint";
export const FINALITY_CHECKPOINT = "finalityCheckpoint";
export const SHALLOW_REORG = "shallowReorg";

const PAGE_SIZE = 10_000;

export const getResolvers = (
  eventStore: EventStore,
  pubsub: PubSub
): IResolvers<any, unknown> => {
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

  return {
    BigInt: new ApolloBigInt("bigInt"),

    Query: {
      getLogEvents,
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
