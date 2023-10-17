import type { utils as utilsInterface } from "@cerc-io/nitro-node";
import nitroNodePkg from "@cerc-io/nitro-node";
import { hex2Bytes } from "@cerc-io/nitro-util";
import {
  PAYMENT_HEADER_KEY,
  PaymentsManager,
  validateGQLRequest,
} from "@cerc-io/util";
import type {
  DocumentNode,
  FieldNode,
  OperationDefinitionNode,
  SelectionNode,
} from "graphql";
import type { RequestHeaders } from "graphql-http";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import type { RemoteNitro, ResolvedConfig } from "@/config/config";
import type { Common } from "@/Ponder";

const { ChannelStatus, Destination, utils } = nitroNodePkg;

interface NitroChannelIds {
  ledgerChannelId?: string;
  paymentChannelId?: string;
}

interface NetworkPayments
  extends NonNullable<ResolvedConfig["networks"][0]["payments"]>,
    NitroChannelIds {}

interface IndexerPayments
  extends NonNullable<NonNullable<ResolvedConfig["indexer"]>["payments"]>,
    NitroChannelIds {}

export class PaymentService {
  private config: NonNullable<ResolvedConfig["nitro"]>;
  private common: Common;

  private nitro?: utilsInterface.Nitro;
  private paymentsManager?: PaymentsManager;
  private indexerPayments?: IndexerPayments;

  private networkPaymentsMap: {
    [key: string]: NetworkPayments;
  } = {};

  constructor({ config, common }: { config: ResolvedConfig; common: Common }) {
    assert(config.nitro, "nitro config does not exist");
    this.config = config.nitro!;
    this.common = common;

    // Build networks map with Nitro node and payment config
    this.networkPaymentsMap = config.networks
      .filter((network) => Boolean(network.payments))
      .reduce((acc: { [key: string]: NetworkPayments }, network) => {
        acc[network.name] = network.payments!;
        return acc;
      }, {});

    if (config.indexer?.payments) {
      this.indexerPayments = config.indexer?.payments;
    }
  }

  async init() {
    const peerIdObj = await utils.createPeerIdFromKey(
      hex2Bytes(this.config.privateKey)
    );

    // TODO: Debug utils.createPeerAndInit method not working
    // const peer = await utils.createPeerAndInit(this.config.relayMultiAddr, {}, peerIdObj);

    const { Peer } = await import("@cerc-io/peer");
    const peer = new Peer(this.config.relayMultiAddr, true);

    await peer.init({}, peerIdObj);

    this.nitro = await utils.Nitro.setupNode(
      this.config.privateKey,
      this.config.chainUrl,
      this.config.chainPrivateKey,
      this.config.contractAddresses,
      peer,
      this.config.store
    );

    this.common.logger.info({
      service: "payment",
      msg: `Nitro node setup with address ${this.nitro.node.address}`,
    });

    const ratesFileData = readFileSync(this.config.payments.ratesFile, {
      encoding: "utf-8",
    });

    this.paymentsManager = new PaymentsManager(
      this.nitro,
      this.config.payments,
      JSON.parse(ratesFileData)
    );

    const addNitroPeerPromises = Object.values(this.networkPaymentsMap).map(
      async (networkPayments) => {
        // Add nitro node accepting payments for RPC requests
        const { address, multiAddr } = networkPayments.nitro;
        await this.nitro!.addPeerByMultiaddr(address, multiAddr);

        this.common.logger.info({
          service: "payment",
          msg: `Added nitro node peer ${address}`,
        });
      }
    );

    this.paymentsManager.subscribeToVouchers();
    await Promise.all(addNitroPeerPromises);
  }

  async setupPaymentChannels() {
    const setupNetworkPaymentChannelPromises = Object.values(
      this.networkPaymentsMap
    ).map(async (networkPayments) => this.setupPaymentChannel(networkPayments));

    if (this.indexerPayments) {
      // Check if indexer Nitro node peer is dialable
      const [isPeerDialable] = await this.nitro!.isPeerDialable(
        this.indexerPayments.nitro.address
      );

      // Wait for peer info of indexer Nitro node to be received if it is not dialable
      if (!isPeerDialable) {
        while (true) {
          const { address } =
            await this.nitro!.msgService.peerInfoReceived().shift();

          if (address === this.indexerPayments.nitro.address) {
            break;
          }
        }
      }

      await this.setupPaymentChannel(this.indexerPayments);
    }

    await Promise.all(setupNetworkPaymentChannelPromises);
  }

  // TODO: Refactor code in watcher-ts util for same method
  async setupPaymentChannel(
    payments: { nitro: RemoteNitro } & NitroChannelIds
  ) {
    const { address } = payments.nitro;

    await this.fetchPaymentChannelWithPeer(payments, address);

    if (!payments.ledgerChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating ledger channel with nitro node ${address} ...`,
      });

      payments.ledgerChannelId = await this.nitro!.directFund(
        address,
        Number(payments.nitro.fundingAmounts.directFund)
      );
    }

    if (!payments.paymentChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating payment channel with nitro node ${address} ...`,
      });

      payments.paymentChannelId = await this.nitro!.virtualFund(
        address,
        Number(payments.nitro.fundingAmounts.virtualFund)
      );
    }

    this.common.logger.info({
      service: "payment",
      msg: `Using payment channel ${payments.paymentChannelId}`,
    });
  }

  async createVoucher(networkName: string) {
    const networkPayments = this.networkPaymentsMap[networkName];

    assert(
      networkPayments.paymentChannelId,
      `Payment channel not created with network ${networkName}`
    );
    const paymentChannel = new Destination(networkPayments.paymentChannelId);

    return this.nitro!.node.createVoucher(
      paymentChannel,
      BigInt(networkPayments.amount)
    );
  }

  async payIndexer() {
    assert(
      this.indexerPayments?.paymentChannelId,
      `Payment channel not created with indexer`
    );

    return this.paymentsManager!.sendPayment(
      this.indexerPayments.paymentChannelId,
      this.indexerPayments.amount
    );
  }

  getPaymentHeader(voucher: { vhash: string; vsig: string }) {
    return `vhash:${voucher.vhash},vsig:${voucher.vsig}`;
  }

  async validateGQLRequest(
    requestHeaders: RequestHeaders,
    gqlQuery: DocumentNode,
    gqlOperationName?: string | null
  ): Promise<null | Error> {
    assert(
      this.paymentsManager,
      "Payment service is not setup before validating GQL request"
    );

    const querySelections = gqlQuery.definitions
      .filter((def) => def.kind === "OperationDefinition")
      .map((def) => (def as OperationDefinitionNode).selectionSet.selections)
      .flat()
      .filter((selection) => selection.kind === "Field")
      .map((selection: SelectionNode) => (selection as FieldNode).name.value);

    try {
      // Validate GQL request using paymentsManager
      await validateGQLRequest(this.paymentsManager, {
        operationName: gqlOperationName,
        querySelections,
        // TODO: Fix type resolution for requestHeaders
        paymentHeader: (requestHeaders as any)[PAYMENT_HEADER_KEY],
      });

      this.common.logger.debug({
        service: "payment",
        msg: `Verified payment for GQL queries ${querySelections.join(", ")}`,
      });
    } catch (error) {
      if (error instanceof Error) {
        this.common.logger.warn({
          service: "payment",
          msg: `Payment verification failed for GQL queries ${querySelections.join(
            ", "
          )}`,
          error: error,
        });

        return error;
      }

      throw error;
    }

    return null;
  }

  async closeChannels() {
    const closeChannelPromises = Object.values(this.networkPaymentsMap).map(
      async (networkPayments) => {
        await this.nitro!.virtualDefund(networkPayments.paymentChannelId!);
        await this.nitro!.directDefund(networkPayments.ledgerChannelId!);
      }
    );

    await Promise.all(closeChannelPromises);
  }

  private async fetchPaymentChannelWithPeer(
    payments: NitroChannelIds,
    nitroPeer: string
  ): Promise<void> {
    const ledgerChannels = await this.nitro!.node.getAllLedgerChannels();

    for await (const ledgerChannel of ledgerChannels) {
      if (
        ledgerChannel.balance.them !== nitroPeer ||
        ledgerChannel.status !== ChannelStatus.Open
      ) {
        continue;
      }

      payments.ledgerChannelId = ledgerChannel.iD.string();
      const paymentChannels = await this.nitro!.getPaymentChannelsByLedger(
        payments.ledgerChannelId
      );

      for (const paymentChannel of paymentChannels) {
        if (paymentChannel.status === ChannelStatus.Open) {
          payments.paymentChannelId = paymentChannel.iD.string();
          return;
        }
      }

      return;
    }
  }

  async payNetwork(
    networkName: string
  ): Promise<{ vhash: string; vsig: string }> {
    const networkPayments = this.networkPaymentsMap[networkName];
    assert(networkPayments.paymentChannelId, "Payment channel not created");
    const paymentChannel = networkPayments.paymentChannelId;

    return this.paymentsManager!.sendPayment(
      paymentChannel,
      networkPayments.amount
    );
  }

  checkIndexerPayments(): boolean {
    if (this.indexerPayments) {
      return true;
    } else {
      return false;
    }
  }
}
