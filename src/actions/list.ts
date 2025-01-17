import { type Token } from "@cashu/cashu-ts";

import { ServerType } from "../client.js";
import { BlobDescriptor, PaymentRequest, SignedEvent } from "../types.js";
import HTTPError from "../error.js";
import { encodeAuthorizationHeader } from "../auth.js";
import { getPaymentRequestFromHeaders } from "../helpers.js";

export type ListOptions<S extends ServerType> = {
  signal?: AbortSignal;
  auth?: SignedEvent;
  since?: number;
  until?: number;
  onPayment?: (server: S, request: PaymentRequest) => Promise<Token>;
  onAuth?: (server: S) => Promise<SignedEvent>;
};

/** Mirrors a blob to a server */
export async function listBlobs<S extends ServerType>(
  server: S,
  pubkey: string,
  opts?: ListOptions<S>,
): Promise<BlobDescriptor[]> {
  const url = new URL(`/list/` + pubkey, server);
  if (opts?.since) url.searchParams.append("since", String(opts.since));
  if (opts?.until) url.searchParams.append("until", String(opts.until));

  let list = await fetch(url, { signal: opts?.signal });

  // handle auth and payments
  switch (list.status) {
    case 401: {
      const auth = opts?.auth || (await opts?.onAuth?.(server));
      if (!auth) throw new Error("Missing auth handler");

      // Try list with auth
      list = await fetch(url, {
        signal: opts?.signal,
        headers: { Authorization: encodeAuthorizationHeader(auth) },
      });
      break;
    }
    case 402: {
      if (!opts?.onPayment) throw new Error("Missing payment handler");
      const { getEncodedToken } = await import("@cashu/cashu-ts");
      const request = getPaymentRequestFromHeaders(list.headers);

      const token = await opts.onPayment(server, request);
      const payment = getEncodedToken(token);

      // Try list with payment
      list = await fetch(url, {
        signal: opts?.signal,
        headers: { "X-Cashu": payment },
      });
      break;
    }
  }

  // handle errors
  await HTTPError.handleErrorResponse(list);

  // return blob descriptor
  return list.json();
}
