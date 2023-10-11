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

const PAYMENTS_CONFIG = {
  cache: {
    maxAccounts: 1000,
    accountTTLInSecs: 1800,
    maxVouchersPerAccount: 1000,
    voucherTTLInSecs: 300,
    maxPaymentChannels: 10000,
    paymentChannelTTLInSecs: 1800,
  },
  ratesFile: "",
  requestTimeoutInSecs: 10,
};

const BASE_RATES_CONFIG = {
  freeQueriesLimit: 10,
  freeQueriesList: [],
  queries: {},
  mutations: {},
};

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

    this.paymentsManager = new PaymentsManager(
      this.nitro,
      PAYMENTS_CONFIG,
      BASE_RATES_CONFIG
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

    await Promise.all(addNitroPeerPromises);
  }

  async setupPaymentChannels() {
    const setupNetworkPaymentChannelPromises = Object.values(
      this.networkPaymentsMap
    ).map(async (networkPayments) => this.setupPaymentChannel(networkPayments));

    if (this.indexerPayments) {
      await this.setupPaymentChannel(this.indexerPayments);
    }

    await Promise.all(setupNetworkPaymentChannelPromises);
  }

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

    return this.nitro!.pay(
      this.indexerPayments.paymentChannelId,
      Number(this.indexerPayments.amount)
    );
  }

  getPaymentHeader(voucher: nitroNodePkg.Voucher) {
    const vhash = voucher.hash();
    const vsig = utils.getJoinedSignature(voucher.signature);

    return `vhash:${vhash},vsig:${vsig}`;
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
    } catch (error) {
      if (error instanceof Error) {
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
}
