import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { authSettings } from "@/lib/server-config";
import { GarminImportError, MAX_IMPORT_BYTES, parseGarminImport } from "@/backend/garmin/import";
import { createGarminImportStore, GarminImportBusyError } from "@/backend/garmin/import-store";
import { createArtifactStore } from "@/backend/garmin/artifacts";
import { createEnvelopeEncryption } from "@/backend/garmin/encryption";
import { createDailyMetricStore } from "@/backend/garmin/daily-store";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const reply = (body: unknown, status: number) => Response.json(body, {
    status, headers: { "cache-control": "private, no-store" },
  });
  const settings = authSettings();
  if (!settings) return reply({ error: "Import jest chwilowo niedostepny." }, 503);
  const session = await auth();
  if (!session?.user.id) return reply({ error: "Zaloguj sie, aby importowac historie." }, 401);
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return reply({ error: "Niedozwolone pochodzenie zadania." }, 403);
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data"))
    return reply({ error: "Wymagany plik ZIP, FIT, CSV lub JSON." }, 415);
  let imported = 0;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new GarminImportError("Brak pliku.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_IMPORT_BYTES + 64 * 1024) {
          await reader.cancel();
          return reply({ error: "Maksymalny rozmiar pliku to 25 MB." }, 413);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let form: FormData;
    try {
      form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": request.headers.get("content-type")! },
      }).formData();
    } catch {
      throw new GarminImportError("Nieprawidlowy formularz pliku.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || form.getAll("file").length !== 1)
      throw new GarminImportError("Wybierz jeden plik ZIP, FIT, CSV lub JSON.");
    const parsed = parseGarminImport(new Uint8Array(await file.arrayBuffer()), file.name);
    const client = new DynamoDBClient({ region: settings.AWS_REGION, maxAttempts: 3 });
    const kms = new KMSClient({ region: settings.AWS_REGION, maxAttempts: 3 });
    const dependencies = {
      get: (command: import("@aws-sdk/client-dynamodb").GetItemCommand) => client.send(command),
      query: (command: import("@aws-sdk/client-dynamodb").QueryCommand) => client.send(command),
      transact: (command: import("@aws-sdk/client-dynamodb").TransactWriteItemsCommand) => client.send(command),
    };
    const artifacts = createArtifactStore(dependencies, settings.DYNAMODB_TABLE_NAME);
    const encryption = createEnvelopeEncryption({ generate: (command) => kms.send(command), decrypt: (command) => kms.send(command) }, settings.DYNAMODB_KMS_KEY_ARN);
    const daily = createDailyMetricStore({ ...dependencies, artifacts, encryption }, settings.DYNAMODB_TABLE_NAME);
    const result = await createGarminImportStore({ ...dependencies, artifacts, encryption, daily }, settings.DYNAMODB_TABLE_NAME)(session.user.id, parsed, (count) => { imported = count; });
    revalidatePath("/");
    return reply(result, 200);
  } catch (error) {
    if (imported) revalidatePath("/");
    if (error instanceof GarminImportBusyError) return reply({ error: error.message }, 409);
    if (error instanceof GarminImportError) return reply({ error: error.message }, 400);
    console.error("garmin_manual_import_failed", { type: error instanceof Error ? error.name : "UnknownError", imported });
    return reply({ error: `Import przerwany. Zapisano ${imported} treningow; czesc pozostalych danych mogla zostac zapisana. Ponow import tego samego pliku, aby dokonczyc.`, imported }, 503);
  }
}