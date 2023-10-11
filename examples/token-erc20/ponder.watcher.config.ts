import { type Config, AppMode } from "@ponder/core";

export const config: Config = {
  networks: [{ name: "mainnet", chainId: 1 }],
  contracts: [
    {
      name: "AdventureGold",
      network: "mainnet",
      abi: "./abis/AdventureGold.json",
      address: "0x32353A6C91143bfd6C7d363B546e62a9A2489A20",
      startBlock: 13142655,
      endBlock: 13150000,
    },
  ],
  options: {
    mode: AppMode.Watcher,
  },
};
