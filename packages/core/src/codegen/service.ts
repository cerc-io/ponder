import Emittery from "emittery";
import { GraphQLSchema, printSchema } from "graphql";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { Contract } from "@/config/contracts.js";
import type { LogFilter } from "@/config/logFilters.js";
import type { Common } from "@/Ponder.js";
import type { Schema } from "@/schema/types.js";
import { ensureDirExists } from "@/utils/exists.js";

import { buildContractTypes } from "./contract.js";
import { buildEntityTypes } from "./entity.js";
import { buildEventTypes } from "./event.js";
import { formatPrettier } from "./prettier.js";

export class CodegenService extends Emittery {
  private common: Common;
  private contracts: Contract[];
  private logFilters: LogFilter[];

  constructor({
    common,
    contracts,
    logFilters,
  }: {
    common: Common;
    contracts: Contract[];
    logFilters: LogFilter[];
  }) {
    super();
    this.common = common;
    this.contracts = contracts;
    this.logFilters = logFilters;
  }

  generateAppFile({ schema }: { schema?: Schema } = {}) {
    console.log("\n\n Ponder Codegennnn \n\n");

    const entities = schema?.entities || [];

    const raw = `
      /* Autogenerated file. Do not edit manually. */

      import fs from "node:fs";

      import packageJson from "../package.json";

      console.log(packageJson)

      console.log(fs.readFileSync("./node_modules/@ponder/core/src/index.js", "utf8"));
  
      import { PonderApp } from "@ponder/core";
      import type { Block, Log, Transaction, Model, ReadOnlyContract } from "@ponder/core";
      import type { AbiParameterToPrimitiveType } from "abitype";
      import type { BlockTag, Hash } from "viem";

      /* ENTITY TYPES */

      ${buildEntityTypes(entities)}
  
      /* CONTRACT TYPES */

      ${buildContractTypes(this.contracts)}

      /* CONTEXT TYPES */

      export type Context = {
        contracts: {
          ${this.contracts
            .map((contract) => `${contract.name}: ${contract.name};`)
            .join("")}
        },
        entities: {
          ${entities
            .map((entity) => `${entity.name}: Model<${entity.name}>;`)
            .join("")}
        },
      }

  
      /* HANDLER TYPES */
    
      ${buildEventTypes(this.logFilters)}

      export const ponder = new PonderApp<AppType>();
    `;

    const final = formatPrettier(raw);

    const filePath = path.join(this.common.options.generatedDir, "index.ts");

    ensureDirExists(filePath);

    console.log({ filePath });
    writeFileSync(filePath, final, "utf8");

    this.common.logger.debug({
      service: "codegen",
      msg: `Wrote new file at generated/index.ts`,
    });
    console.log("Generating js file");
  }

  generateSchemaFile({ graphqlSchema }: { graphqlSchema: GraphQLSchema }) {
    console.log("\n\n GraphQL Codegennnn \n\n");
    const header = `
      """ Autogenerated file. Do not edit manually. """
    `;

    const body = printSchema(graphqlSchema);
    const final = formatPrettier(header + body, { parser: "graphql" });

    const filePath = path.join(
      this.common.options.generatedDir,
      "schema.graphql"
    );
    ensureDirExists(filePath);
    writeFileSync(filePath, final, "utf8");

    this.common.logger.debug({
      service: "codegen",
      msg: `Wrote new file at generated/schema.graphql`,
    });
  }
}
