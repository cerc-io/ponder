import type { Generated, Insertable } from "kysely";
import type { Address, Hash, Hex } from "viem";
import {
  type RpcBlock,
  type RpcLog,
  type RpcTransaction,
  hexToNumber,
  toHex,
} from "viem";

import { blobToBigInt } from "@/utils/decode.js";
import { intToBlob } from "@/utils/encode.js";

type BlocksTable = {
  baseFeePerGas: Buffer | null; // BigInt
  difficulty: Buffer; // BigInt
  extraData: Hex;
  gasLimit: Buffer; // BigInt
  gasUsed: Buffer; // BigInt
  hash: Hash;
  logsBloom: Hex;
  miner: Address;
  mixHash: Hash;
  nonce: Hex;
  number: Buffer; // BigInt
  parentHash: Hash;
  receiptsRoot: Hex;
  sha3Uncles: Hash;
  size: Buffer; // BigInt
  stateRoot: Hash;
  timestamp: Buffer; // BigInt
  totalDifficulty: Buffer; // BigInt
  transactionsRoot: Hash;

  chainId: number;
};

export type InsertableBlock = Insertable<BlocksTable>;

export function rpcToSqliteBlock(
  block: RpcBlock
): Omit<InsertableBlock, "chainId"> {
  return {
    baseFeePerGas: block.baseFeePerGas ? intToBlob(block.baseFeePerGas) : null,
    difficulty: intToBlob(block.difficulty),
    extraData: block.extraData,
    gasLimit: intToBlob(block.gasLimit),
    gasUsed: intToBlob(block.gasUsed),
    hash: block.hash!,
    logsBloom: block.logsBloom!,
    miner: block.miner,
    mixHash: block.mixHash,
    nonce: block.nonce!,
    number: intToBlob(block.number!),
    parentHash: block.parentHash,
    receiptsRoot: block.receiptsRoot,
    sha3Uncles: block.sha3Uncles,
    size: intToBlob(block.size),
    stateRoot: block.stateRoot,
    timestamp: intToBlob(block.timestamp),
    totalDifficulty: intToBlob(block.totalDifficulty!),
    transactionsRoot: block.transactionsRoot,
  };
}

export function sqliteToRpcBlock(
  block: Omit<InsertableBlock, "chainId">,
  transactions: RpcTransaction[] | Hash[]
): RpcBlock {
  return {
    baseFeePerGas: block.baseFeePerGas ? toHex(block.baseFeePerGas) : null,
    difficulty: toHex(blobToBigInt(block.difficulty)),
    extraData: block.extraData,
    gasLimit: toHex(blobToBigInt(block.gasLimit)),
    gasUsed: toHex(blobToBigInt(block.gasUsed)),
    hash: block.hash,
    logsBloom: block.logsBloom,
    miner: block.miner,
    mixHash: block.mixHash,
    nonce: block.nonce,
    number: toHex(blobToBigInt(block.number)),
    parentHash: block.parentHash,
    receiptsRoot: block.receiptsRoot,
    sha3Uncles: block.sha3Uncles,
    size: toHex(blobToBigInt(block.size)),
    stateRoot: block.stateRoot,
    timestamp: toHex(blobToBigInt(block.timestamp)),
    totalDifficulty: toHex(blobToBigInt(block.totalDifficulty)),
    transactions,
    transactionsRoot: block.transactionsRoot,

    // Set empty fields to satisfy RpcBlock type
    // Following fields are not stored in event store DB by the indexer
    sealFields: [],
    uncles: [],
  };
}

type TransactionsTable = {
  blockHash: Hash;
  blockNumber: Buffer; // BigInt
  from: Address;
  gas: Buffer; // BigInt
  hash: Hash;
  input: Hex;
  nonce: number;
  r: Hex;
  s: Hex;
  to: Address | null;
  transactionIndex: number;
  v: Buffer; // BigInt
  value: Buffer; // BigInt

  type: Hex;
  gasPrice: Buffer | null; // BigInt
  maxFeePerGas: Buffer | null; // BigInt
  maxPriorityFeePerGas: Buffer | null; // BigInt
  accessList: string | null;

  chainId: number;
};

export type InsertableTransaction = Insertable<TransactionsTable>;

export function rpcToSqliteTransaction(
  transaction: RpcTransaction
): Omit<InsertableTransaction, "chainId"> {
  return {
    accessList: transaction.accessList
      ? JSON.stringify(transaction.accessList)
      : undefined,
    blockHash: transaction.blockHash!,
    blockNumber: intToBlob(transaction.blockNumber!),
    from: transaction.from,
    gas: intToBlob(transaction.gas),
    gasPrice: transaction.gasPrice ? intToBlob(transaction.gasPrice) : null,
    hash: transaction.hash,
    input: transaction.input,
    maxFeePerGas: transaction.maxFeePerGas
      ? intToBlob(transaction.maxFeePerGas)
      : null,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas
      ? intToBlob(transaction.maxPriorityFeePerGas)
      : null,
    nonce: hexToNumber(transaction.nonce),
    r: transaction.r,
    s: transaction.s,
    to: transaction.to ? transaction.to : null,
    transactionIndex: Number(transaction.transactionIndex),
    type: transaction.type ?? "0x0",
    value: intToBlob(transaction.value),
    v: intToBlob(transaction.v),
  };
}

export function sqliteToRpcTransaction(
  transaction: InsertableTransaction
): RpcTransaction {
  const txWithoutFeeValues = {
    blockHash: transaction.blockHash,
    blockNumber: toHex(blobToBigInt(transaction.blockNumber)),
    from: transaction.from,
    gas: toHex(blobToBigInt(transaction.gas)),
    hash: transaction.hash,
    input: transaction.input,
    nonce: toHex(transaction.nonce),
    r: transaction.r,
    s: transaction.s,
    to: transaction.to ?? null,
    transactionIndex: toHex(transaction.transactionIndex),
    v: toHex(blobToBigInt(transaction.v)),
    value: toHex(blobToBigInt(transaction.value)),
  };

  if (transaction.type === "0x0") {
    return {
      ...txWithoutFeeValues,
      chainId: toHex(transaction.chainId),
      type: transaction.type,
      gasPrice: toHex(blobToBigInt(transaction.gasPrice!)),
    };
  }

  if (transaction.type === "0x1") {
    return {
      ...txWithoutFeeValues,
      accessList: JSON.parse(transaction.accessList!),
      chainId: toHex(transaction.chainId),
      type: transaction.type,
      gasPrice: toHex(blobToBigInt(transaction.gasPrice!)),
    };
  }

  return {
    ...txWithoutFeeValues,
    accessList: JSON.parse(transaction.accessList!),
    chainId: toHex(transaction.chainId),
    type: transaction.type as "0x2",
    maxFeePerGas: toHex(transaction.maxFeePerGas!),
    maxPriorityFeePerGas: toHex(transaction.maxPriorityFeePerGas!),
  };
}

type LogsTable = {
  id: string;
  address: Address;
  blockHash: Hash;
  blockNumber: Buffer; // BigInt
  data: Hex;
  logIndex: number;
  transactionHash: Hash;
  transactionIndex: number;

  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;

  chainId: number;
};

export type InsertableLog = Insertable<LogsTable>;

export function rpcToSqliteLog(log: RpcLog): Omit<InsertableLog, "chainId"> {
  return {
    address: log.address,
    blockHash: log.blockHash!,
    blockNumber: intToBlob(log.blockNumber!),
    data: log.data,
    id: `${log.blockHash}-${log.logIndex}`,
    logIndex: Number(log.logIndex!),
    topic0: log.topics[0] ? log.topics[0] : null,
    topic1: log.topics[1] ? log.topics[1] : null,
    topic2: log.topics[2] ? log.topics[2] : null,
    topic3: log.topics[3] ? log.topics[3] : null,
    transactionHash: log.transactionHash!,
    transactionIndex: Number(log.transactionIndex!),
  };
}

export function sqliteToRpcLog(
  log: Omit<InsertableLog, "chainId">,
  removed = false
): RpcLog {
  return {
    address: log.address,
    blockHash: log.blockHash!,
    blockNumber: toHex(blobToBigInt(log.blockNumber!)),
    data: log.data,
    logIndex: toHex(log.logIndex!),
    topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(
      (t): t is Hex => t !== null
    ) as [Hex, ...Hex[]] | [],
    transactionHash: log.transactionHash!,
    transactionIndex: toHex(log.transactionIndex!),
    removed,
  };
}

type ContractReadResultsTable = {
  address: string;
  blockNumber: Buffer; // BigInt
  chainId: number;
  data: Hex;
  result: Hex;
};

type LogFilterCachedRangesTable = {
  id: Generated<number>;
  filterKey: string;
  startBlock: Buffer; // BigInt
  endBlock: Buffer; // BigInt
  endBlockTimestamp: Buffer; // BigInt
};

export type EventStoreTables = {
  blocks: BlocksTable;
  transactions: TransactionsTable;
  logs: LogsTable;
  contractReadResults: ContractReadResultsTable;
  logFilterCachedRanges: LogFilterCachedRangesTable;
};
