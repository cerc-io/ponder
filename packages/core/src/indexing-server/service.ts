import { makeExecutableSchema } from "@graphql-tools/schema";
import cors from "cors";
import express from "express";
import { graphqlHTTP } from "express-graphql";
import { PubSub } from "graphql-subscriptions";
import { useServer } from "graphql-ws/lib/use/ws";
import { createHttpTerminator } from "http-terminator";
import { createServer, Server } from "node:http";
import { Server as WebSocketServer } from "ws";

import { EventStore } from "@/event-store/store";
import type { Common } from "@/Ponder";

import { getResolvers, HISTORICAL_CHECKPOINT } from "./resolvers";
import { indexingSchema } from "./schema";

// TODO: Refactor common GQL server code with ServerService
export class IndexingServerService {
  private common: Common;
  private eventStore: EventStore;
  private pubsub: PubSub;

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

    // https://www.apollographql.com/docs/apollo-server/data/subscriptions#the-pubsub-class
    this.pubsub = new PubSub();
  }

  async start() {
    this.app = express();
    this.app.use(cors());

    // TODO: Register metrics for IndexingServerService similar to ServerService

    const schema = makeExecutableSchema({
      typeDefs: indexingSchema,
      resolvers: getResolvers(this.eventStore, this.pubsub),
    });

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
      schema,
      graphiql: true,
    });

    this.app.use("/graphql", graphqlMiddleware);

    // create and use the websocket server
    const wsServer = new WebSocketServer({
      server,
      path: "/graphql",
    });

    useServer({ schema }, wsServer);
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

  handleNewHistoricalCheckpoint(data: { chainId: number; timestamp: number }) {
    this.pubsub.publish(HISTORICAL_CHECKPOINT, {
      onNewHistoricalCheckpoint: data,
    });
  }
}
