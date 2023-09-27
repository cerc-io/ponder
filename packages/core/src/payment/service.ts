import { Destination, utils } from "@cerc-io/nitro-node";
import { hex2Bytes } from "@cerc-io/nitro-util";
import assert from "node:assert";

import { ResolvedConfig } from "@/config/config";

const LEDGER_CHANNEL_AMOUNT = 100000;
const PAYMENT_CHANNEL_AMOUNT = 10000;
const PAY_AMOUNT = 100;

export class PaymentService {
  private config: NonNullable<ResolvedConfig["nitro"]>;

  private nitro?: utils.Nitro;
  private ledgerChannelId?: string;
  private paymentChannelId?: string;

  constructor({ config }: { config: NonNullable<ResolvedConfig["nitro"]> }) {
    this.config = config;
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
      peer
    );

    // Add nitro node accepting payments for RPC requests
    const { address, multiAddr } = this.config.rpcNitroNode;
    await this.nitro.addPeerByMultiaddr(address, multiAddr);
  }

  async setupPaymentChannel() {
    const { address } = this.config.rpcNitroNode;
    this.ledgerChannelId = await this.nitro!.directFund(
      address,
      LEDGER_CHANNEL_AMOUNT
    );
    this.paymentChannelId = await this.nitro!.virtualFund(
      address,
      PAYMENT_CHANNEL_AMOUNT
    );
  }

  async createVoucher() {
    assert(this.paymentChannelId, "Payment channel not created");
    const paymentChannel = Destination.addressToDestination(
      this.paymentChannelId
    );
    return this.nitro!.node.createVoucher(paymentChannel, BigInt(PAY_AMOUNT));
  }

  async closeChannels() {
    await this.nitro!.virtualDefund(this.paymentChannelId!);
    await this.nitro!.directDefund(this.ledgerChannelId!);
  }
}
