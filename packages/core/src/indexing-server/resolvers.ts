import { EventStore } from "@/event-store/store";
import { blobToBigInt } from "@/utils/decode";
import { intToBlob } from "@/utils/encode";

const PAGE_SIZE = 10_000;

export const getResolvers = (eventStore: EventStore) => {
  const getLogEvents = async (args: any) => {
    try {
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
          events: events.map((event) => ({
            ...event,
            log: {
              ...event.log,
              // TODO: Resolve bigint types in GQL
              blockNumber: event.log.blockNumber.toString(),
            },
            block: {
              ...event.block,
              // TODO: Resolve bigint types in GQL
              baseFeePerGas:
                event.block.baseFeePerGas !== null &&
                event.block.baseFeePerGas.toString(),
              difficulty: event.block.difficulty.toString(),
              gasLimit: event.block.gasLimit.toString(),
              gasUsed: event.block.gasUsed.toString(),
              number: event.block.number.toString(),
              size: event.block.size.toString(),
              timestamp: event.block.timestamp.toString(),
              totalDifficulty: event.block.totalDifficulty.toString(),
            },
            transaction: {
              ...event.transaction,
              // TODO: Resolve bigint types in GQL
              blockNumber: event.transaction.blockNumber.toString(),
              gas: event.transaction.gas.toString(),
              v: event.transaction.v.toString(),
              value: event.transaction.value.toString(),
              gasPrice:
                event.transaction.gasPrice !== undefined &&
                event.transaction.gasPrice.toString(),
              maxFeePerGas:
                event.transaction.maxFeePerGas !== undefined &&
                event.transaction.maxFeePerGas.toString(),
              maxPriorityFeePerGas:
                event.transaction.maxPriorityFeePerGas !== undefined &&
                event.transaction.maxPriorityFeePerGas.toString(),
            },
          })),
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
    } catch (err) {
      console.error(err);
      throw new Error("Debug error in GQL server");
    }
  };

  return {
    getLogEvents,
  };
};
