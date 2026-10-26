import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { z } from "zod";

const envelopeSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});
export type EnvelopeContext = Record<string, string>;
type Dependencies = {
  generate: (
    command: GenerateDataKeyCommand,
  ) => Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
  decrypt: (command: DecryptCommand) => Promise<{ Plaintext?: Uint8Array }>;
};
const aad = (context: EnvelopeContext) =>
  Buffer.from(
    JSON.stringify(
      Object.entries(context).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
export function createEnvelopeEncryption(
  dependencies: Dependencies,
  keyArn: string,
) {
  return {
    async encrypt(value: unknown, context: EnvelopeContext) {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 2 * 1024 * 1024)
        throw new Error("Garmin payload exceeds supported request size");
      const generated = await dependencies.generate(
        new GenerateDataKeyCommand({
          KeyId: keyArn,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
      );
      if (
        generated.Plaintext?.length !== 32 ||
        !generated.CiphertextBlob?.length
      )
        throw new Error("Garmin encryption unavailable");
      const plaintextKey = Buffer.from(generated.Plaintext);
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", plaintextKey, iv);
        cipher.setAAD(aad(context));
        const data = Buffer.concat([
          cipher.update(gzipSync(bytes)),
          cipher.final(),
        ]);
        return JSON.stringify({
          version: 1,
          key: Buffer.from(generated.CiphertextBlob).toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        });
      } finally {
        plaintextKey.fill(0);
        generated.Plaintext.fill(0);
      }
    },
    async decrypt(value: string, context: EnvelopeContext): Promise<unknown> {
      const envelope = envelopeSchema.parse(JSON.parse(value));
      const decrypted = await dependencies.decrypt(
        new DecryptCommand({
          KeyId: keyArn,
          CiphertextBlob: Buffer.from(envelope.key, "base64"),
          EncryptionContext: context,
        }),
      );
      if (decrypted.Plaintext?.length !== 32)
        throw new Error("Garmin decryption unavailable");
      const plaintextKey = Buffer.from(decrypted.Plaintext);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          plaintextKey,
          Buffer.from(envelope.iv, "base64"),
        );
        decipher.setAAD(aad(context));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        const compressed = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64")),
          decipher.final(),
        ]);
        return JSON.parse(
          gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 }).toString(
            "utf8",
          ),
        ) as unknown;
      } finally {
        plaintextKey.fill(0);
        decrypted.Plaintext.fill(0);
      }
    },
  };
}
