// `/params` — the protocol's static config (denomination, max fee per
// mix, script addresses, reference UTxO ref). `/protocol-params`
// returns the live ledger protocol parameters from ogmios. The two
// are intentionally distinct: the SDK's tx builder needs both —
// `/params` for "what does Lovejoin charge" and `/protocol-params`
// for "what does the ledger charge in fees this epoch".
//
// Spec: §"REST API".

import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import { redactUpstreamMessage } from "../redact.js";
import type { RouteOptions } from "../types.js";

const paramsRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get("/params", { schema: ROUTE_SCHEMAS.params }, async (_req, reply) => {
    const ref = deps.state.referenceUtxoRef();
    if (deps.state.alarm()) {
      reply.code(503);
      return {
        error: "reference_utxo_alarm",
        message: deps.state.alarm(),
      };
    }
    const a = deps.config.addresses;
    return {
      network: a.network,
      denomLovelace: BigInt(a.protocol.denom_lovelace),
      maxFeePerMix: BigInt(a.protocol.max_fee_per_mix_lovelace),
      defaultMixRounds: 30,
      minMixRounds: 5,
      mixScriptAddress: deps.config.derived.mixBoxAddress,
      feeScriptAddress: deps.config.derived.feeContractAddress,
      referenceUtxo: ref
        ? { txHash: ref.txId, outputIndex: ref.outputIndex }
        : { txHash: a.referenceUtxoRef.split("#")[0], outputIndex: 0 },
      referenceNft: {
        policyId: a.referenceNftPolicy,
        assetName: a.referenceNftAssetName,
      },
    };
  });

  // /protocol-params returns the live ledger protocol parameters from
  // ogmios's queryLedgerState. Distinct from /params (which is the
  // protocol's own static config — denominations, script addresses,
  // etc., from addresses.json). The SDK's tx builder needs *both*:
  // /params for "what does Lovejoin charge" and /protocol-params for
  // "what does the ledger charge in fees this epoch".
  //
  // Body is an ogmios v6 object — same shape the SDK already knows how
  // to translate via its mesh-bridge.
  app.get(
    "/protocol-params",
    { schema: ROUTE_SCHEMAS.protocolParams },
    async (req, reply: FastifyReply) => {
      if (!deps.ogmiosTx) {
        reply.code(503);
        return {
          error: "protocol_params_unavailable",
          message: "ogmios tx client not configured",
        };
      }
      try {
        const params = await deps.ogmiosTx.protocolParameters();
        return params;
      } catch (err) {
        const raw = (err as Error).message ?? "ogmios error";
        req.log.error({ err, raw }, "/protocol-params: ogmios error");
        reply.code(502);
        return {
          error: "ogmios_error",
          message: redactUpstreamMessage(raw),
        };
      }
    },
  );
};

export default paramsRoutes;
