import type { Kysely, Migrator } from "kysely";
import type { Address, Hex, RpcBlock, RpcLog, RpcTransaction } from "viem";

import type { Block } from "@/types/block.js";
import type { Log } from "@/types/log.js";
import type { Transaction } from "@/types/transaction.js";

/**
 * A record representing a range of blocks that have been added
 * to the event store for a given log filter.
 */
export type LogFilterCachedRange = {
  filterKey: string;
  startBlock: number;
  endBlock: number;
  endBlockTimestamp: number;
};

/**
 * A record representing a call to a contract made at a specific block height.
 */
export type ContractReadResult = {
  address: string;
  blockNumber: bigint;
  chainId: number;
  data: Hex;
  result: Hex;
};

export type Cursor = {
  timestamp: Buffer;
  chainId: number;
  blockNumber: Buffer;
  logIndex: number;
};

export interface EventStore {
  kind: "sqlite" | "postgres";
  db: Kysely<any>;
  migrator: Migrator;

  migrateUp(): Promise<void>;
  migrateDown(): Promise<void>;

  insertHistoricalLogs(options: {
    chainId: number;
    logs: RpcLog[];
  }): Promise<void>;

  insertHistoricalBlock(options: {
    chainId: number;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logFilterRange: {
      logFilterKey: string;
      blockNumberToCacheFrom: number;
    };
  }): Promise<void>;

  insertRealtimeBlock(options: {
    chainId: number;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
  }): Promise<void>;

  deleteRealtimeData(options: {
    chainId: number;
    fromBlockNumber: number;
  }): Promise<void>;

  insertLogFilterCachedRanges(options: {
    logFilterKeys: string[];
    startBlock: number;
    endBlock: number;
    endBlockTimestamp: number;
  }): Promise<void>;

  mergeLogFilterCachedRanges(options: {
    logFilterKey: string;
    logFilterStartBlockNumber: number;
  }): Promise<{ startingRangeEndTimestamp: number }>;

  getLogFilterCachedRanges(options: {
    logFilterKey: string;
  }): Promise<LogFilterCachedRange[]>;

  insertContractReadResult(options: {
    address: string;
    blockNumber: bigint;
    chainId: number;
    data: Hex;
    result: Hex;
  }): Promise<void>;

  getContractReadResult(options: {
    address: string;
    blockNumber: bigint;
    chainId: number;
    data: Hex;
  }): Promise<ContractReadResult | null>;

  getLogEvents(arg: {
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
    pageSize?: number;
    cursor?: Cursor;
  }): AsyncGenerator<{
    events: {
      logFilterName: string;
      log: Log;
      block: Block;
      transaction: Transaction;
    }[];
    metadata: {
      pageEndsAtTimestamp: number;
      counts: {
        logFilterName: string;
        selector: Hex;
        count: number;
      }[];
      cursor?: Cursor;
    };
  }>;

  // TODO: Implement method in postgres eventStore for getting logs
  getEthLogs(args: {
    chainId: number;
    address?: Address;
    topics?: (Hex | Hex[] | null)[];
    fromBlock?: number;
    toBlock?: number;
    blockHash?: Hex;
  }): Promise<RpcLog[]>;

  // TODO: Implement method in postgres eventStore for getting blocks
  getEthBlock(args: {
    chainId: number;
    blockHash?: Hex;
    blockNumber?: number;
    fullTransactions?: boolean;
    latest?: boolean;
  }): Promise<RpcBlock | undefined>;
}
