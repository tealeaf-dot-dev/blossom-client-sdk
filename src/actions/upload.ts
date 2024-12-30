import { type Token } from "@cashu/cashu-ts";

import { ServerType, UploadType } from "../client.js";
import { BlobDescriptor, PaymentRequest, SignedEvent } from "../types.js";
import { getBlobSha256, getBlobSize, getBlobType, getPaymentRequestFromHeaders } from "../helpers.js";
import HTTPError from "../error.js";
import { encodeAuthorizationHeader } from "../auth.js";

export type UploadOptions<S extends ServerType, B extends UploadType> = {
  /** AbortSignal to cancel the action */
  signal?: AbortSignal;
  /** Override auth event to use */
  auth?: SignedEvent;
  /**
   * A method used to request payment when uploading or mirroring a blob
   * @param server the server requiring payment
   * @param sha256 the sha256 of the blob being uploaded or mirrored
   * @param blob the original blob
   * @param request the payment request
   */
  onPayment?: (server: S, sha256: string, blob: B, request: PaymentRequest) => Promise<Token>;
  /**
   * A method used to request a signed auth event for a server and sha256
   * @param server the server requesting the auth
   * @param sha256 the sha256 of the blob being upload or mirror to the server
   * @param blob the original blob passed to the method
   */
  onAuth?: (server: S, sha256: string, blob: B) => Promise<SignedEvent>;
};

/** Upload a blob to a server, handles payment and auth */
export async function uploadBlob<S extends ServerType, B extends UploadType>(
  server: S,
  blob: B,
  opts?: UploadOptions<S, B>,
): Promise<BlobDescriptor> {
  const url = new URL("/upload", server);
  const sha256 = await getBlobSha256(blob);

  const headers: Record<string, string> = {
    "X-SHA-256": sha256,
  };
  const auth = opts?.auth || (await opts?.onAuth?.(server, sha256, blob));
  if (auth) headers["Authorization"] = encodeAuthorizationHeader(auth);

  // build check headers
  const checkHeaders: Record<string, string> = {
    ...headers,
    "X-Content-Length": String(getBlobSize(blob)),
  };
  const type = getBlobType(blob);
  if (type) checkHeaders["X-Content-Type"] = type;

  // check upload with HEAD /upload
  let firstTry = await fetch(url, {
    method: "HEAD",
    signal: opts?.signal,
    headers: checkHeaders,
  });

  // handle auth and payment
  switch (firstTry.status) {
    case 401: {
      if (!auth) {
          throw new Error("Missing auth handler");
      } else {
          throw new Error("Unable to authenticate");
      }
      break;
    }
    case 402: {
      if (!opts?.onPayment) throw new Error("Missing payment handler");
      const { getEncodedToken } = await import("@cashu/cashu-ts");
      const request = getPaymentRequestFromHeaders(firstTry.headers);

      const token = await opts.onPayment(server, sha256, blob, request);
      const payment = getEncodedToken(token);
      headers['X-Cashu'] = payment;
      break;
    }
    case 403: {
        throw new Error("Unauthorized");
        break;
    }
  }

  // check passed, upload
  const upload = await fetch(url, {
    signal: opts?.signal,
    method: "PUT",
    body: blob,
    headers: { ...headers },
  });

  // handle errors
  await HTTPError.handleErrorResponse(upload);

  // return blob descriptor
  return upload.json();
}
