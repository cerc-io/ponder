import cors from "cors";
import express from "express";
import { graphqlHTTP } from "express-graphql";
import { createHttpTerminator } from "http-terminator";
import { createServer, Server } from "node:http";

import { EventStore } from "@/event-store/store";
import type { Common } from "@/Ponder";

import { getResolvers } from "./resolvers";
import { indexingSchema } from "./schema";

// TODO: Refactor common GQL server code with ServerService
export class IndexingServerService {
  private common: Common;
  private eventStore: EventStore;

  port: number;
  app?: express.Express;

  private terminate?: () => Promise<void>;

  isSyncComplete = false;

  constructor({
    common,
    eventStore,
  }: {
    common: Common;
    eventStore: EventStore;
  }) {
    this.common = common;
    this.eventStore = eventStore;
    this.port = this.common.options.indexingPort;
  }

  async start() {
    this.app = express();
    this.app.use(cors());

    // TODO: Register metrics for IndexingServerService similar to ServerService

    const server = await new Promise<Server>((resolve, reject) => {
      const server = createServer(this.app)
        .on("error", (error) => {
          if ((error as any).code === "EADDRINUSE") {
            this.common.logger.warn({
              service: "indexing-server",
              msg: `Port ${this.port} was in use, trying port ${this.port + 1}`,
            });
            this.port += 1;
            setTimeout(() => {
              server.close();
              server.listen(this.port);
            }, 5);
          } else {
            reject(error);
          }
        })
        .on("listening", () => {
          // TODO: Set metrics for indexing server port
          resolve(server);
        })
        .listen(this.port);
    });

    const terminator = createHttpTerminator({ server });
    this.terminate = () => terminator.terminate();

    this.common.logger.info({
      service: "indexing-server",
      msg: `Started listening on port ${this.port}`,
    });

    // TODO: Add server request handlers for metrics

    // Server will respond as unhealthy until historical events have
    // been processed OR 4.5 minutes have passed since the app was created.
    // Similar to implementation in ServerService
    this.app.get("/health", (_, res) => {
      if (this.isSyncComplete) {
        return res.status(200).send();
      }

      const max = this.common.options.maxHealthcheckDuration;
      const elapsed = Math.floor(process.uptime());

      if (elapsed > max) {
        this.common.logger.warn({
          service: "indexing-server",
          msg: `Historical sync duration has exceeded the max healthcheck duration of ${max} seconds (current: ${elapsed}). Sevice is now responding as healthy and may serve incomplete data.`,
        });
        return res.status(200).send();
      }

      return res.status(503).send();
    });

    const graphqlMiddleware = graphqlHTTP({
      schema: indexingSchema,
      rootValue: getResolvers(this.eventStore),
      graphiql: true,
    });

    this.app.use("/", graphqlMiddleware);
  }

  async kill() {
    await this.terminate?.();
    this.common.logger.debug({
      service: "indexing-server",
      msg: `Stopped listening on port ${this.port}`,
    });
  }

  setIsSyncComplete() {
    this.isSyncComplete = true;

    this.common.logger.info({
      service: "indexing-server",
      msg: `Started responding as healthy`,
    });
  }
}
