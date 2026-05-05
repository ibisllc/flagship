/**
 * The handler ABI that .com surface routes share.
 *
 * Each handler is a pure async function: it takes already-parsed JSON
 * input plus the deps it needs (storage, clock, CA keypair), and returns
 * `{ status, body }`. No Fastify, no Workers, no I/O outside what we
 * pass in. Both runtimes (apps/web Fastify in dev/tests + apps/com
 * Worker in production) call the same handlers; the runtime adapter is
 * thin.
 */

export interface HandlerResponse<T = unknown> {
  status: number;
  body: T;
}

export interface ResponseHeaders {
  [key: string]: string;
}

export interface HandlerResponseWithHeaders<T = unknown> extends HandlerResponse<T> {
  headers?: ResponseHeaders;
}

export type Handler<Input, Output = unknown> = (
  input: Input,
) => Promise<HandlerResponseWithHeaders<Output>>;

export const malformed = (reason: string): HandlerResponseWithHeaders =>
  ({ status: 400, body: { error: reason } });

export const forbidden = (reason: string): HandlerResponseWithHeaders =>
  ({ status: 403, body: { error: reason } });

export const notFound = (reason: string): HandlerResponseWithHeaders =>
  ({ status: 404, body: { error: reason } });

export const conflict = (reason: string): HandlerResponseWithHeaders =>
  ({ status: 409, body: { error: reason } });

export const gone = (reason: string): HandlerResponseWithHeaders =>
  ({ status: 410, body: { error: reason } });

export const ok = <T>(body: T, headers?: ResponseHeaders): HandlerResponseWithHeaders<T> =>
  ({ status: 200, body, headers });
