import { checkBindingChallenge } from "../../core/binding.js";
import { parseCaip10 } from "../../core/caip.js";
import { correctedNow, dateHeaderOffset } from "../../core/clock.js";
import { SignerRefusal } from "../../core/errors.js";
import { getAddress } from "../../core/hex.js";
import { isObject } from "../../core/meta.js";
import { PaymentError } from "../../errors.js";
import type { RestClient } from "../../rest.js";
import type { EvmSigner } from "../../signer.js";

/** The `data` of `POST /agents/me/delegate`; `status` is `ACTIVE` or `PENDING_APPROVAL`. */
export type BindAnswer = Record<string, unknown>;

/**
 * Binds an EVM key to the API key's credential (spec section 5): the challenge, its field-by-field
 * check, the signature over typed data rebuilt from the SDK's own constants, the bind request, and
 * a check that the answer names this key (as `delegate` when `ACTIVE`, as `pendingDelegate` when
 * `PENDING_APPROVAL`). A challenge refused only on its expiry is retried once.
 */
export async function bindEvmKey(o: {
  signer: EvmSigner;
  chainId: number;
  credentialId: string;
  api: RestClient;
  now: () => number;
}): Promise<BindAnswer> {
  const address = getAddress(o.signer.address);
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = await o.api.post("/agents/me/delegate/challenge", { delegate: address });
    const local = o.now() / 1000;
    const nowSeconds = correctedNow(local, dateHeaderOffset(challenge.date, local));
    let typedData;
    try {
      typedData = checkBindingChallenge(challenge.data, {
        localAddress: address,
        credentialId: o.credentialId,
        chainId: o.chainId,
        nowSeconds,
      });
    } catch (err) {
      if (!(err instanceof SignerRefusal)) throw err;
      if (err.field === "message.expiresAt") {
        if (attempt === 0) continue;
        throw new PaymentError("BINDING_CLOCK", "the binding challenge expired twice; check this machine's clock");
      }
      throw new PaymentError(
        "BINDING_CHALLENGE_REFUSED",
        `the binding challenge failed its check (${err.field}); nothing was signed`,
        { details: { field: err.field } },
      );
    }
    const challengeId = (challenge.data as Record<string, unknown>).challengeId as string;
    const signature = await o.signer.signTypedData(typedData as never);
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new PaymentError("SIGNER_FAILED", "the signer did not return a 65-byte signature");
    }
    const bound = await o.api.post("/agents/me/delegate", { challengeId, signature });
    const data = isObject(bound.data) ? bound.data : {};
    const names = (v: unknown) => {
      const p = typeof v === "string" ? parseCaip10(v) : null;
      return p !== null && p.chainId === o.chainId && p.address === address;
    };
    // ACTIVE: this key is the delegate now. PENDING_APPROVAL: another key stays bound and keeps
    // signing; this one waits as `pendingDelegate` until a person approves it.
    const accepted =
      (data.status === "ACTIVE" && names(data.delegate)) ||
      (data.status === "PENDING_APPROVAL" && names(data.pendingDelegate));
    if (!accepted) throw new PaymentError("BINDING_NOT_ACCEPTED", "Assay did not confirm the binding of this key");
    return data;
  }
  throw new PaymentError("BINDING_CLOCK", "the binding challenge expired twice; check this machine's clock");
}
