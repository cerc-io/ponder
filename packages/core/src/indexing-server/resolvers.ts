import type { IFieldResolver, IResolvers } from "@graphql-tools/utils";
import type { PubSub } from "graphql-subscriptions";
import assert from "node:assert";
import { createRequire } from "node:module";
import { type RpcBlock, numberToHex } from "viem";

import type { Network } from "@/config/networks.js";
import type { EventStore } from "@/event-store/store.js";
import type { RealtimeSyncService } from "@/realtime-sync/service.js";
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
  networkSyncServices,
}: {
  eventStore: EventStore;
  pubsub: PubSub;
  networkCheckpoints: NetworkCheckpoints;
  networkSyncServices: {
    network: Network;
    realtimeSyncService: RealtimeSyncService;
  }[];
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

  const getEthBlock: IFieldResolver<any, unknown> = async (_, args) => {
    const { chainId, ...filterArgs } = args;
    let { blockNumber } = filterArgs;
    const { blockHash, fullTransactions } = filterArgs;

    let blockTag =
      blockHash ?? (blockNumber && numberToHex(blockNumber)) ?? "latest";

    const networkSyncService = networkSyncServices.find(
      ({ network }) => network.chainId === chainId
    );

    assert(networkSyncService, `chainId ${chainId} not supported by Indexer`);
    const { network, realtimeSyncService } = networkSyncService;

    // Check for latest blockTag and try to get realtime sync service head block
    if (blockTag === "latest") {
      const headBlock = realtimeSyncService.headBlock;

      if (headBlock) {
        // Set to realtime sync service headBlock if it exists
        // This is to keep consuming indexer behind this indexer
        blockTag = numberToHex(headBlock.number);
        blockNumber = headBlock.number;
      }
    }

    let rpcBlock: RpcBlock | null = null;

    if (blockHash || blockNumber) {
      // Try fetching block from DB if blockHash or blockNumber specified
      rpcBlock = await eventStore.getEthBlock({
        chainId: args.chainId,
        blockHash,
        blockNumber,
        fullTransactions,
      });
    }

    // If the block is not fetched from DB, check for blockTag
    // If blockTag is latest, realtime sync service has not started
    // And no blocks in DB stored by historical sync service
    // Do not fetch latest block from RPC in this scenario and return null
    if (!rpcBlock && blockTag == "latest") {
      return null;
    }

    if (!rpcBlock) {
      // Fetch from network client if block not found in DB
      // TODO: Cache network RPC calls for already fetched blocks
      rpcBlock = await network!.client.request({
        method: blockHash ? "eth_getBlockByHash" : "eth_getBlockByNumber",
        params: [blockTag, fullTransactions],
      });
    }

    return rpcBlock
      ? {
          ...rpcBlock,
          // sealFields doesn't exist in block returned by RPC endpoint
          sealFields: rpcBlock.sealFields ?? [],
          txHashes: !fullTransactions ? rpcBlock.transactions : null,
          transactions: fullTransactions ? rpcBlock.transactions : null,
        }
      : null;
  };

  return {
    BigInt: new ApolloBigInt("bigInt"),

    Query: {
      getLogEvents,
      getNetworkHistoricalSync,
      getEthLogs,
      getEthBlock,
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
