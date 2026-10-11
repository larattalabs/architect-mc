/** A message the client caused that cannot be done (answered with ack ok:false). Re-exported by sidecar.ts. */
export class ClientError extends Error {}

/**
 * (0b) A typed refusal: the ack carries `code` (the API's Reason name: COPY_REFUSED, VERSION_REFUSED) and `detail` (the
 * sub-code the mod passes on as ArchitectRefused.detail()).
 */
export class RefusedError extends ClientError {
  constructor(
    readonly code: 'COPY_REFUSED' | 'VERSION_REFUSED',
    readonly detail: string,
    message: string,
  ) {
    super(`${detail}: ${message}`);
  }
}
