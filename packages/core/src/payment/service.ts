import type { utils as utilsInterface } from "@cerc-io/nitro-node";
import nitroNodePkg from "@cerc-io/nitro-node";
import { hex2Bytes } from "@cerc-io/nitro-util";
import { PaymentsManager } from "@cerc-io/util";
import type { DocumentNode } from "graphql";
import type { RequestHeaders } from "graphql-http";
import assert from "node:assert";

import type { ResolvedConfig } from "@/config/config";
import type { Common } from "@/Ponder";

const { ChannelStatus, Destination, utils } = nitroNodePkg;

interface NetworkPayments
  extends NonNullable<ResolvedConfig["networks"][0]["payments"]> {
  ledgerChannelId?: string;
  paymentChannelId?: string;
}

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

  async setupPaymentChannel(networkName: string) {
    const networkPayments = this.networkPaymentsMap[networkName];

    if (!networkPayments) {
      return;
    }

    const { address } = networkPayments.nitro;

    await this.fetchPaymentChannelWithPeer(networkPayments, address);

    if (!networkPayments.ledgerChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating ledger channel with nitro node ${address} ...`,
      });

      networkPayments.ledgerChannelId = await this.nitro!.directFund(
        address,
        Number(networkPayments.nitro.fundingAmounts.directFund)
      );
    }

    if (!networkPayments.paymentChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating payment channel with nitro node ${address} ...`,
      });

      networkPayments.paymentChannelId = await this.nitro!.virtualFund(
        address,
        Number(networkPayments.nitro.fundingAmounts.virtualFund)
      );
    }

    this.common.logger.info({
      service: "payment",
      msg: `Using payment channel ${networkPayments.paymentChannelId}`,
    });
  }

  async createVoucher(networkName: string) {
    const networkPayments = this.networkPaymentsMap[networkName];

    assert(networkPayments.paymentChannelId, "Payment channel not created");
    const paymentChannel = new Destination(networkPayments.paymentChannelId);

    return this.nitro!.node.createVoucher(
      paymentChannel,
      BigInt(networkPayments.amount)
    );
  }

  async validateGQLRequest(
    requestHeaders: RequestHeaders,
    gqlQuery: DocumentNode,
    gqlOperationName?: string | null
  ): Promise<null | Error> {
    // TODO: Use payments manager
    // validateGQLRequest(
    //   this.paymentsManager,
    //   {
    //     operationName: gqlOperationName,
    //     querySelections?: gqlQuery.definitions.map(def => def.loc.)
    //     paymentHeader?: string | null;
    //   }
    // )
    console.log("this.paymentsManager", this.paymentsManager);

    console.log({
      requestHeaders,
      gqlQuery,
      gqlOperationName,
    });

    console.log(
      "parsedQuery",
      gqlQuery.definitions.map((def) => console.log(def))
    );

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
    networkPayments: NetworkPayments,
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

      networkPayments.ledgerChannelId = ledgerChannel.iD.string();
      const paymentChannels = await this.nitro!.getPaymentChannelsByLedger(
        networkPayments.ledgerChannelId
      );

      for (const paymentChannel of paymentChannels) {
        if (paymentChannel.status === ChannelStatus.Open) {
          networkPayments.paymentChannelId = paymentChannel.iD.string();
          return;
        }
      }

      return;
    }
  }
}
