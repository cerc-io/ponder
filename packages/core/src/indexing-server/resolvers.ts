import type { IFieldResolver, IResolvers } from "@graphql-tools/utils";
import ApolloBigInt from "apollo-type-bigint";
import { PubSub } from "graphql-subscriptions";

import { EventStore } from "@/event-store/store";
import { blobToBigInt } from "@/utils/decode";
import { intToBlob } from "@/utils/encode";

export const HISTORICAL_CHECKPOINT = "historicalCheckpoint";

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
    },
  };
};
