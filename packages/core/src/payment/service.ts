import { ChannelStatus, Destination, utils } from "@cerc-io/nitro-node";
import { hex2Bytes } from "@cerc-io/nitro-util";
import assert from "node:assert";

import { ResolvedConfig } from "@/config/config";
import { Common } from "@/Ponder";

interface NetworkPayments
  extends NonNullable<ResolvedConfig["networks"][0]["payments"]> {
  ledgerChannelId?: string;
  paymentChannelId?: string;
}

export class PaymentService {
  private config: NonNullable<ResolvedConfig["nitro"]>;
  private common: Common;

  private nitro?: utils.Nitro;
  private ledgerChannelId?: string;
  private paymentChannelId?: string;

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
      this.config.chainURL,
      this.config.chainPrivateKey,
      this.config.contractAddresses,
      peer,
      this.config.store
    );

    this.common.logger.info({
      service: "payment",
      msg: `Nitro node setup with address ${this.nitro.node.address}`,
    });

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

    await this.fetchPaymentChannelWithPeer(address);

    if (!this.ledgerChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating ledger channel with nitro node ${address} ...`,
      });

      this.ledgerChannelId = await this.nitro!.directFund(
        address,
        Number(networkPayments.nitro.fundingAmounts.directFund)
      );
    }

    if (!this.paymentChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating payment channel with nitro node ${address} ...`,
      });

      this.paymentChannelId = await this.nitro!.virtualFund(
        address,
        Number(networkPayments.nitro.fundingAmounts.virtualFund)
      );
    }

    this.common.logger.info({
      service: "payment",
      msg: `Using payment channel ${this.paymentChannelId}`,
    });
  }

  async createVoucher(networkName: string) {
    const networkPayments = this.networkPaymentsMap[networkName];

    assert(this.paymentChannelId, "Payment channel not created");
    const paymentChannel = new Destination(this.paymentChannelId);

    return this.nitro!.node.createVoucher(
      paymentChannel,
      BigInt(networkPayments.amount)
    );
  }

  async closeChannels() {
    await this.nitro!.virtualDefund(this.paymentChannelId!);
    await this.nitro!.directDefund(this.ledgerChannelId!);
  }

  private async fetchPaymentChannelWithPeer(nitroPeer: string): Promise<void> {
    const ledgerChannels = await this.nitro!.node.getAllLedgerChannels();

    for await (const ledgerChannel of ledgerChannels) {
      if (
        ledgerChannel.balance.them !== nitroPeer ||
        ledgerChannel.status !== ChannelStatus.Open
      ) {
        continue;
      }

      this.ledgerChannelId = ledgerChannel.iD.string();
      const paymentChannels = await this.nitro!.getPaymentChannelsByLedger(
        this.ledgerChannelId
      );

      for (const paymentChannel of paymentChannels) {
        if (paymentChannel.status === ChannelStatus.Open) {
          this.paymentChannelId = paymentChannel.iD.string();
          return;
        }
      }

      return;
    }
  }
}
