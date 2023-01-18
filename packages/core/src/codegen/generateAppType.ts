import { writeFileSync } from "node:fs";
import path from "node:path";

import { ensureDirExists } from "@/common/utils";
import type { Ponder } from "@/Ponder";

import { buildEntityTypes } from "./buildEntityTypes";
import { buildEventTypes } from "./buildEventTypes";
import { formatPrettier } from "./utils";

export const generateAppType = ({ ponder }: { ponder: Ponder }) => {
  const contractNames = ponder.sources.map((source) => source.name);
  const entities = ponder.schema?.entities || [];

  const raw = `
    /* Autogenerated file. Do not edit manually. */

    import type { Block, Log, Transaction } from "@ponder/core";
    import type { BigNumber, BytesLike } from "ethers";

    ${contractNames
      .map((name) => `import type { ${name} } from "./contracts/${name}";`)
      .join("\n")}

    /* CONTEXT TYPES */

    ${buildEntityTypes(entities)}

    export type Context = {
      contracts: {
        ${contractNames.map((name) => `${name}: ${name};`).join("")}
      },
      entities: {
        ${entities
          .map((entity) => `${entity.name}: ${entity.name}Model;`)
          .join("")}
      },
    }

    /* HANDLER TYPES */

    type Hash = string;

    ${buildEventTypes(ponder.sources)}
  `;

  const final = formatPrettier(raw);

  const filePath = path.join(ponder.options.GENERATED_DIR_PATH, "app.ts");
  ensureDirExists(filePath);
  writeFileSync(filePath, final, "utf8");
};
