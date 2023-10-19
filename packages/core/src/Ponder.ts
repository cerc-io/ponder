import type { utils } from "@cerc-io/nitro-node";
import assert from "node:assert";
import path from "node:path";
import process from "node:process";

import { BuildService } from "@/build/service.js";
import { CodegenService } from "@/codegen/service.js";
import { type ResolvedConfig } from "@/config/config.js";
import { buildContracts } from "@/config/contracts.js";
import { buildDatabase } from "@/config/database.js";
import { type LogFilter, buildLogFilters } from "@/config/logFilters.js";
import { type Network, buildNetwork } from "@/config/networks.js";
import { type Options, AppMode } from "@/config/options.js";
import { UserErrorService } from "@/errors/service.js";
import { GqlEventAggregatorService } from "@/event-aggregator/gql-service.js";
import { InternalEventAggregatorService } from "@/event-aggregator/internal-service.js";
import { type EventAggregatorService } from "@/event-aggregator/service.js";
import { PostgresEventStore } from "@/event-store/postgres/store.js";
import { SqliteEventStore } from "@/event-store/sqlite/store.js";
import { type EventStore } from "@/event-store/store.js";
import { HistoricalSyncService } from "@/historical-sync/service.js";
import { IndexingServerService } from "@/indexing-server/service.js";
import { LoggerService } from "@/logs/service.js";
import { MetricsService } from "@/metrics/service.js";
import { PaymentService } from "@/payment/service.js";
import { RealtimeSyncService } from "@/realtime-sync/service.js";
import { ServerService } from "@/server/service.js";
import { TelemetryService } from "@/telemetry/service.js";
import { UiService } from "@/ui/service.js";
import { EventHandlerService } from "@/user-handlers/service.js";
import { PostgresUserStore } from "@/user-store/postgres/store.js";
import { SqliteUserStore } from "@/user-store/sqlite/store.js";
import { type UserStore } from "@/user-store/store.js";
import { createGqlClient } from "@/utils/graphql-client.js";

export type Common = {
  options: Options;
  logger: LoggerService;
  errors: UserErrorService;
  metrics: MetricsService;
  telemetry: TelemetryService;
};

export class Ponder {
  common: Common;
  logFilters: LogFilter[];

  eventStore: EventStore;
  userStore: UserStore;

  // List of indexing-related services. One per configured network.
  networkSyncServices: {
    network: Network;
    logFilters: LogFilter[];
    historicalSyncService: HistoricalSyncService;
    realtimeSyncService: RealtimeSyncService;
  }[] = [];

  eventAggregatorService: EventAggregatorService;
  eventHandlerService: EventHandlerService;

  serverService: ServerService;
  indexingServerService: IndexingServerService;
  buildService: BuildService;
  codegenService: CodegenService;
  uiService: UiService;

  paymentService?: PaymentService;

  constructor({
    options,
    config,
    eventStore,
    userStore,
  }: {
    options: Options;
    config: ResolvedConfig;
    // These options are only used for testing.
    eventStore?: EventStore;
    userStore?: UserStore;
    nitro?: utils.Nitro;
  }) {
    const logger = new LoggerService({
      level: options.logLevel,
      dir: options.logDir,
    });
    const errors = new UserErrorService();
    const metrics = new MetricsService();
    const telemetry = new TelemetryService({ options });

    const common = { options, logger, errors, metrics, telemetry };
    this.common = common;

    const logFilters = buildLogFilters({ options, config });
    this.logFilters = logFilters;

    if (config.nitro) {
      this.paymentService = new PaymentService({
        config,
        common,
      });
    }

    const contracts = buildContracts({
      options,
      config,
      common,
      paymentService: this.paymentService,
    });

    const networks = config.networks
      .map((network) =>
        buildNetwork({ network, paymentService: this.paymentService, common })
      )
      .filter((network) => {
        const hasLogFilters = logFilters.some(
          (logFilter) => logFilter.network === network.name
        );
        if (!hasLogFilters) {
          this.common.logger.warn({
            service: "app",
            msg: `No log filters found (network=${network.name})`,
          });
        }
        return hasLogFilters;
      });

    const database = buildDatabase({ options, config });
    this.eventStore =
      eventStore ??
      (database.kind === "sqlite"
        ? new SqliteEventStore({ db: database.eventStoreDb })
        : new PostgresEventStore({ pool: database.pool }));

    this.userStore =
      userStore ??
      (database.kind === "sqlite"
        ? new SqliteUserStore({ db: database.userStoreDb })
        : new PostgresUserStore({ pool: database.pool }));

    networks.forEach((network) => {
      const logFiltersForNetwork = logFilters.filter(
        (logFilter) => logFilter.network === network.name
      );
      this.networkSyncServices.push({
        network,
        logFilters: logFiltersForNetwork,
        historicalSyncService: new HistoricalSyncService({
          common,
          eventStore: this.eventStore,
          network,
          logFilters: logFiltersForNetwork,
        }),
        realtimeSyncService: new RealtimeSyncService({
          common,
          eventStore: this.eventStore,
          network,
          logFilters: logFiltersForNetwork,
        }),
      });
    });

    this.indexingServerService = new IndexingServerService({
      common,
      eventStore: this.eventStore,
      paymentService: this.paymentService,
      networkSyncServices: this.networkSyncServices,
    });

    const gqlClient = createGqlClient(
      config.indexer?.gqlEndpoint ??
        `http://localhost:${common.options.indexerPort}/graphql`
    );

    this.eventAggregatorService = this.checkAppMode(AppMode.Watcher)
      ? new GqlEventAggregatorService({
          common,
          gqlClient,
          networks,
          logFilters,
          paymentService: this.paymentService,
        })
      : new InternalEventAggregatorService({
          common,
          eventStore: this.eventStore,
          networks,
          logFilters,
        });

    this.eventHandlerService = new EventHandlerService({
      common,
      eventStore: this.eventStore,
      userStore: this.userStore,
      eventAggregatorService: this.eventAggregatorService,
      contracts,
      logFilters,
    });

    this.serverService = new ServerService({
      common,
      userStore: this.userStore,
    });
    this.buildService = new BuildService({ common, logFilters });
    this.codegenService = new CodegenService({
      common,
      contracts,
      logFilters,
    });
    this.uiService = new UiService({ common, logFilters });
  }

  async setup() {
    this.common.logger.debug({
      service: "app",
      msg: `Started using config file: ${path.relative(
        this.common.options.rootDir,
        this.common.options.configFile
      )}`,
    });

    this.registerServiceDependencies();

    // Setup indexer services if mode is standalone or indexer
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Indexer)
    ) {
      // If any of the provided networks do not have a valid RPC url,
      // kill the app here. This happens here rather than in the constructor because
      // `ponder codegen` should still be able to if an RPC url is missing. In fact,
      // that is part of the happy path for `create-ponder`.
      const networksMissingRpcUrl: Network[] = [];
      this.networkSyncServices.forEach(({ network }) => {
        if (!network.rpcUrl && !network.indexerUrl) {
          networksMissingRpcUrl.push(network);
        }
      });
      if (networksMissingRpcUrl.length > 0) {
        return new Error(
          `missing RPC or indexer URL for networks (${networksMissingRpcUrl.map(
            (n) => `"${n.name}"`
          )}). Did you forget to add an RPC or indexer URL in .env.local?`
        );
      }

      // Start indexing server if running in indexer mode
      if (this.checkAppMode(AppMode.Indexer)) {
        await this.indexingServerService.start();
      }

      // Note that this must occur before loadSchema and loadHandlers.
      await this.eventStore.migrateUp();
    }

    if (this.paymentService) {
      // Initialize payment service with Nitro node
      await this.paymentService.init();

      // Setup payment channel with Nitro nodes
      await this.paymentService!.setupPaymentChannels();
    }

    // Setup watcher services if mode is standalone or watcher
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Watcher)
    ) {
      // Subscribe to Sync service events from indexing server if running in watcher mode
      if (this.checkAppMode(AppMode.Watcher)) {
        assert(this.eventAggregatorService.subscribeToSyncEvents);
        await this.eventAggregatorService.subscribeToSyncEvents();
      }

      // Start the HTTP server.
      await this.serverService.start();

      // These files depend only on ponder.config.ts, so can generate once on setup.
      // Note that loadHandlers depends on the index.ts file being present.
      this.codegenService.generateAppFile();

      // Manually trigger loading schema and handlers. Subsequent loads
      // are triggered by changes to project files (handled in BuildService).
      this.buildService.buildSchema();
      await this.buildService.buildHandlers();
    }

    return undefined;
  }

  async dev() {
    const setupError = await this.setup();

    this.common.telemetry.record({
      event: "App Started",
      properties: {
        command: "ponder dev",
        hasSetupError: !!setupError,
        logFilterCount: this.logFilters.length,
        databaseKind: this.eventStore.kind,
      },
    });

    if (setupError) {
      this.common.logger.error({
        service: "app",
        msg: setupError.message,
        error: setupError,
      });
      return await this.kill();
    }

    // Start sync services if running in standalone or indexer mode
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Indexer)
    ) {
      await Promise.all(
        this.networkSyncServices.map(
          async ({ historicalSyncService, realtimeSyncService }) => {
            const blockNumbers = await realtimeSyncService.setup();
            await historicalSyncService.setup(blockNumbers);
            historicalSyncService.start();

            if (!this.paymentService) {
              realtimeSyncService.start();
            }
          }
        )
      );
    }

    this.buildService.watch();
  }

  async start() {
    const setupError = await this.setup();

    this.common.telemetry.record({
      event: "App Started",
      properties: {
        command: "ponder start",
        hasSetupError: !!setupError,
        logFilterCount: this.logFilters.length,
        databaseKind: this.eventStore.kind,
      },
    });

    if (setupError) {
      this.common.logger.error({
        service: "app",
        msg: setupError.message,
        error: setupError,
      });
      return await this.kill();
    }

    // Start sync services if running in standalone or indexer mode
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Indexer)
    ) {
      await Promise.all(
        this.networkSyncServices.map(
          async ({ historicalSyncService, realtimeSyncService }) => {
            const blockNumbers = await realtimeSyncService.setup();
            await historicalSyncService.setup(blockNumbers);
            historicalSyncService.start();

            if (!this.paymentService) {
              realtimeSyncService.start();
            }
          }
        )
      );
    }
  }

  async codegen() {
    this.codegenService.generateAppFile();

    const result = this.buildService.buildSchema();
    if (result) {
      const { schema, graphqlSchema } = result;
      this.codegenService.generateAppFile({ schema });
      this.codegenService.generateSchemaFile({ graphqlSchema });
    }

    await this.kill();
  }

  async kill() {
    this.eventAggregatorService.kill();

    this.common.telemetry.record({
      event: "App Killed",
      properties: {
        processDuration: process.uptime(),
      },
    });

    await Promise.all(
      this.networkSyncServices.map(
        async ({ realtimeSyncService, historicalSyncService }) => {
          await realtimeSyncService.kill();
          await historicalSyncService.kill();
        }
      )
    );

    await this.buildService.kill?.();
    this.uiService.kill();
    this.eventHandlerService.kill();
    await this.serverService.kill();
    await this.userStore.teardown();
    await this.common.telemetry.kill();

    this.common.logger.debug({
      service: "app",
      msg: `Finished shutdown sequence`,
    });
  }

  private registerServiceDependencies() {
    this.buildService.on("newConfig", async () => {
      this.common.logger.fatal({
        service: "build",
        msg: "Detected change in ponder.config.ts",
      });
      await this.kill();
    });

    // Register build service listeners if running in standalone or watcher mode
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Watcher)
    ) {
      this.buildService.on("newSchema", async ({ schema, graphqlSchema }) => {
        this.codegenService.generateAppFile({ schema });
        this.codegenService.generateSchemaFile({ graphqlSchema });

        this.serverService.reload({ graphqlSchema });

        await this.eventHandlerService.reset({ schema });
        await this.eventHandlerService.processEvents();
      });

      this.buildService.on("newHandlers", async ({ handlers }) => {
        await this.eventHandlerService.reset({ handlers });
        await this.eventHandlerService.processEvents();
      });
    }

    // Register network service listeners if running in standalone or indexer mode
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Indexer)
    ) {
      this.networkSyncServices.forEach((networkSyncService) => {
        const { chainId } = networkSyncService.network;
        const { historicalSyncService, realtimeSyncService } =
          networkSyncService;

        historicalSyncService.on("historicalCheckpoint", ({ timestamp }) => {
          if (this.checkAppMode(AppMode.Indexer)) {
            this.indexingServerService.handleNewHistoricalCheckpoint({
              chainId,
              timestamp,
            });
          } else {
            this.eventAggregatorService.handleNewHistoricalCheckpoint({
              chainId,
              timestamp,
            });
          }
        });

        historicalSyncService.on("syncComplete", () => {
          if (this.checkAppMode(AppMode.Indexer)) {
            this.indexingServerService.handleHistoricalSyncComplete({
              chainId,
            });
          } else {
            this.eventAggregatorService.handleHistoricalSyncComplete({
              chainId,
            });
          }

          // Check that app is not running in watcher mode
          if (!this.checkAppMode(AppMode.Watcher)) {
            // If payment service is setup, start the realtime sync service after historical sync service.
            // This will avoid parallel requests to RPC endpoint
            if (this.paymentService) {
              realtimeSyncService.start();
            }
          }
        });

        realtimeSyncService.on("realtimeCheckpoint", ({ timestamp }) => {
          if (this.checkAppMode(AppMode.Indexer)) {
            this.indexingServerService.handleNewRealtimeCheckpoint({
              chainId,
              timestamp,
            });
          } else {
            this.eventAggregatorService.handleNewRealtimeCheckpoint({
              chainId,
              timestamp,
            });
          }
        });

        realtimeSyncService.on("finalityCheckpoint", ({ timestamp }) => {
          if (this.checkAppMode(AppMode.Indexer)) {
            this.indexingServerService.handleNewFinalityCheckpoint({
              chainId,
              timestamp,
            });
          } else {
            this.eventAggregatorService.handleNewFinalityCheckpoint({
              chainId,
              timestamp,
            });
          }
        });

        realtimeSyncService.on(
          "shallowReorg",
          ({ commonAncestorTimestamp }) => {
            if (this.checkAppMode(AppMode.Indexer)) {
              this.indexingServerService.handleReorg({
                commonAncestorTimestamp,
              });
            } else {
              this.eventAggregatorService.handleReorg({
                commonAncestorTimestamp,
              });
            }
          }
        );
      });
    }

    // Register event aggregator and handler service listeners if running in standalone or watcher mode
    if (
      this.checkAppMode(AppMode.Standalone) ||
      this.checkAppMode(AppMode.Watcher)
    ) {
      this.eventAggregatorService.on("newCheckpoint", async () => {
        await this.eventHandlerService.processEvents();
      });

      this.eventAggregatorService.on(
        "reorg",
        async ({ commonAncestorTimestamp }) => {
          await this.eventHandlerService.handleReorg({
            commonAncestorTimestamp,
          });
          await this.eventHandlerService.processEvents();
        }
      );

      this.eventHandlerService.on("eventsProcessed", ({ toTimestamp }) => {
        if (this.serverService.isHistoricalIndexingComplete) return;

        // If a batch of events are processed AND the historical sync is complete AND
        // the new toTimestamp is greater than the historical sync completion timestamp,
        // historical event processing is complete, and the server should begin responding as healthy.
        if (
          this.eventAggregatorService.historicalSyncCompletedAt &&
          toTimestamp >= this.eventAggregatorService.historicalSyncCompletedAt
        ) {
          this.serverService.setIsHistoricalIndexingComplete();
        }
      });
    }
  }

  private checkAppMode(mode: AppMode) {
    return this.common.options.mode === mode;
  }
}
