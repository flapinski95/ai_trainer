declare module "@garmin/fitsdk" {
  export class Stream {
    static fromBuffer(buffer: Uint8Array): Stream;
  }
  export class Decoder {
    constructor(stream: Stream);
    isFIT(): boolean;
    checkIntegrity(): boolean;
    read(options?: {
      mesgListener?: (messageNumber: number, message: Record<string, unknown>) => void;
      mergeHeartRates?: boolean;
    }): {
      messages: Record<string, Record<string, unknown>[]>;
      errors: unknown[];
    };
  }
}