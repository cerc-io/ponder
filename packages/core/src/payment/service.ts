import { ChannelStatus, Destination, utils } from "@cerc-io/nitro-node";
import { hex2Bytes } from "@cerc-io/nitro-util";
import assert from "node:assert";

import { ResolvedConfig } from "@/config/config";
import { Common } from "@/Ponder";

const LEDGER_CHANNEL_AMOUNT = 1_000_000_000_000;
const PAYMENT_CHANNEL_AMOUNT = 1_000_000_000;

export class PaymentService {
  private config: NonNullable<ResolvedConfig["nitro"]>;
  private common: Common;

  private nitro?: utils.Nitro;
  private ledgerChannelId?: string;
  private paymentChannelId?: string;

  constructor({
    config,
    common,
  }: {
    config: NonNullable<ResolvedConfig["nitro"]>;
    common: Common;
  }) {
    this.config = config;
    this.common = common;
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

    // Add nitro node accepting payments for RPC requests
    const { address, multiAddr } = this.config.rpcNitroNode;
    await this.nitro.addPeerByMultiaddr(address, multiAddr);

    this.common.logger.info({
      service: "payment",
      msg: `Added nitro node peer ${address}`,
    });
  }

  async setupPaymentChannel() {
    const { address } = this.config.rpcNitroNode;

    await this.fetchPaymentChannelWithPeer(address);

    if (!this.ledgerChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating ledger channel with nitro node ${address} ...`,
      });

      this.ledgerChannelId = await this.nitro!.directFund(
        address,
        LEDGER_CHANNEL_AMOUNT
      );
    }

    if (!this.paymentChannelId) {
      this.common.logger.info({
        service: "payment",
        msg: `Creating payment channel with nitro node ${address} ...`,
      });

      this.paymentChannelId = await this.nitro!.virtualFund(
        address,
        PAYMENT_CHANNEL_AMOUNT
      );
    }

    this.common.logger.info({
      service: "payment",
      msg: `Using payment channel ${this.paymentChannelId}`,
    });
  }

  async createVoucher() {
    assert(this.paymentChannelId, "Payment channel not created");
    const paymentChannel = new Destination(this.paymentChannelId);

    return this.nitro!.node.createVoucher(
      paymentChannel,
      BigInt(this.config.payAmount)
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
