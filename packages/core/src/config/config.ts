import type { PaymentsConfig } from "@cerc-io/util";
import type { AbiEvent } from "abitype";
import { build } from "esbuild";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { ensureDirExists } from "@/utils/exists.js";

import type { AppMode } from "./options.js";

export type RemoteNitro = {
  address: string;
  /** Funding amounts for Nitro channels created with the node */
  fundingAmounts: {
    directFund: string;
    virtualFund: string;
  };
};

type RemoteNetworkNitro = {
  multiAddr: string;
} & RemoteNitro;

export type ResolvedConfig = {
  /** Database to use for storing blockchain & entity data. Default: `"postgres"` if `DATABASE_URL` env var is present, otherwise `"sqlite"`. */
  database?:
    | {
        kind: "sqlite";
        /** Path to SQLite database directory. Default: `"./.ponder/cache"`. */
        directory?: string;
      }
    | {
        kind: "postgres";
        /** PostgreSQL database connection string. Default: `process.env.DATABASE_URL`. */
        connectionString?: string;
      };
  /** List of blockchain networks. */
  networks: {
    /** Network name. Must be unique across all networks. */
    name: string;
    /** Chain ID of the network. */
    chainId: number;
    /** RPC URL. Default: if available, a public RPC provider. */
    rpcUrl?: string;
    /** Indexer URL for fetching network data. */
    indexerUrl?: string;
    /** Polling frequency (in ms). Default: `1_000`. */
    pollingInterval?: number;
    /** Maximum concurrency of RPC requests during the historical sync. Default: `10`. */
    maxRpcRequestConcurrency?: number;
    /** Configuration of payments required for network requests */
    payments?: {
      /** Config for Nitro node payments will be made to */
      nitro: RemoteNetworkNitro;
      /** List of RPC methods which require payment */
      paidRPCMethods: string[];
      /** Amount to be paid for each network request */
      amount: string;
    };
  }[];
  /** List of contracts to fetch & handle events from. Contracts defined here will be present in `context.contracts`. */
  contracts?: {
    /** Contract name. Must be unique across `contracts` and `filters`. */
    name: string;
    /** Network that this contract is deployed to. Must match a network name in `networks`. */
    network: string; // TODO: narrow this type to TNetworks[number]['name']
    /** Contract ABI as a file path or an Array object. Accepts a single ABI or a list of ABIs to be merged. */
    abi: string | any[] | readonly any[] | (string | any[] | readonly any[])[];
    /** Contract address. */
    address: `0x${string}`;
    /** Block number at which to start processing events (inclusive). Default: `0`. */
    startBlock?: number;
    /** Block number at which to stop processing events (inclusive). If `undefined`, events will be processed in real-time. Default: `undefined`. */
    endBlock?: number;
    /** Maximum block range to use when calling `eth_getLogs`. Default: `10_000`. */
    maxBlockRange?: number;
    /** Whether to fetch & process event logs for this contract. If `false`, this contract will still be present in `context.contracts`. Default: `true`. */
    isLogEventSource?: boolean;
  }[];
  /** List of log filters from which to fetch & handle event logs. */
  filters?: {
    /** Filter name. Must be unique across `contracts` and `filters`. */
    name: string;
    /** Network that this filter is deployed to. Must match a network name in `networks`. */
    network: string; // TODO: narrow this type to TNetworks[number]['name']
    /** Log filter ABI as a file path or an Array object. Accepts a single ABI or a list of ABIs to be merged. */
    abi: string | any[] | readonly any[] | (string | any[] | readonly any[])[];
    /** Log filter options. */
    filter: {
      /** Contract addresses to include. If `undefined`, no filter will be applied. Default: `undefined`. */
      address?: `0x${string}` | `0x${string}`[];
    } & (
      | {
          /** Event signature to include. If `undefined`, no filter will be applied. Default: `undefined`. */
          event?: AbiEvent;
          /** Event arguments to include. If `undefined`, no filter will be applied. Default: `undefined`. */
          args?: any[];
        }
      | {
          event?: never;
          args?: never;
        }
    );
    /** Block number at which to start processing events (inclusive). Default: `0`. */
    startBlock?: number;
    /** Block number at which to stop processing events (inclusive). If `undefined`, events will be processed in real-time. Default: `undefined`. */
    endBlock?: number;
    /** Maximum block range to use when calling `eth_getLogs`. Default: `10_000`. */
    maxBlockRange?: number;
  }[];
  /** Configuration for Ponder internals. */
  options?: {
    /** Maximum number of seconds to wait for event processing to be complete before responding as healthy. If event processing exceeds this duration, the API may serve incomplete data. Default: `240` (4 minutes). */
    maxHealthcheckDuration?: number;
    /** Mode of the ponder app */
    mode?: AppMode;
  };
  /** Indexer config required when running app in watcher mode */
  indexer?: {
    /** GQL endpoint of the indexer */
    gqlEndpoint?: string;
    payments?: {
      /** Config for Nitro node payments will be made to */
      nitro: RemoteNitro;
      /** Amount to be paid for each network request */
      amount: string;
    };
  };
  /** Configuration for setting up Nitro node */
  nitro?: {
    privateKey: string;
    chainPrivateKey: string;
    chainUrl: string;
    contractAddresses: { [key: string]: string };
    relayMultiAddr: string;
    store: string;
    payments: PaymentsConfig;
  };
};

export type Config =
  | ResolvedConfig
  | Promise<ResolvedConfig>
  | (() => ResolvedConfig)
  | (() => Promise<ResolvedConfig>);

export const buildConfig = async ({ configFile }: { configFile: string }) => {
  if (!existsSync(configFile)) {
    throw new Error(`Ponder config file not found, expected: ${configFile}`);
  }

  const buildFile = path.join(path.dirname(configFile), "__ponder__.js");
  ensureDirExists(buildFile);

  // Delete the build file before attempting to write it.
  rmSync(buildFile, { force: true });

  try {
    await build({
      entryPoints: [configFile],
      outfile: buildFile,
      platform: "node",
      format: "esm",
      bundle: false,
      logLevel: "silent",
    });

    const { default: rawDefault, config: rawConfig } = await import(buildFile);
    rmSync(buildFile, { force: true });

    if (!rawConfig) {
      if (rawDefault) {
        throw new Error(
          `Ponder config not found. ${path.basename(
            configFile
          )} must export a variable named "config" (Cannot be a default export)`
        );
      }
      throw new Error(
        `Ponder config not found. ${path.basename(
          configFile
        )} must export a variable named "config"`
      );
    }

    let resolvedConfig: ResolvedConfig;

    if (typeof rawConfig === "function") {
      resolvedConfig = await rawConfig();
    } else {
      resolvedConfig = await rawConfig;
    }

    return resolvedConfig;
  } catch (err) {
    rmSync(buildFile, { force: true });
    throw err;
  }
};
