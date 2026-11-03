/**
 * Volumen (BL-016): las 700 boletas de un período en PDF, **por el mismo camino que el worker**
 * (`emitirDocumentosDelPeriodo`): vistas armadas bajo la identidad de quien pidió la emisión, Chromium
 * de verdad en lotes de 50 —el chunk del worker, que es memoria medida (ADR-0001 §3.2)—, cada PDF
 * guardado y su fila registrada. Lo único que no es el de producción es el almacenamiento, en memoria:
 * se mide el lote, no la red hasta MinIO.
 *
 * Mira el tiempo y el pico de memoria residente del proceso, que es lo que crece si alguien arma las
 * 700 solicitudes o los 700 PDF de una vez en vez de por chunk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { conUsuario, type DbRequest } from "../../packages/data/src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../../packages/data/src/servicios/liquidacion.ts";
import { dbDe, poolAdmin, poolApp } from "../../packages/data/test/helpers.ts";
import { crearGeneradorChromium } from "../../packages/documentos/src/adapters/chromium.ts";
import { registroPorDefecto } from "../../packages/documentos/src/cobranza/index.ts";
import type { ObjectStorage } from "../../packages/almacenamiento/src/index.ts";
import { emitirDocumentosDelPeriodo } from "../../apps/worker/src/emision.ts";
import { anotar, armarEscenario, desarmarEscenario, medir, UNIDADES, type Escenario } from "./soporte.ts";
import { TOPES } from "./topes.ts";

const CHUNK = 50;

let admin: ReturnType<typeof poolAdmin>;
let appPool: ReturnType<typeof poolApp>;
let db: DbRequest;
let escenario: Escenario;

/** Guarda los PDF en memoria (solo cuenta bytes: guardar 700 buffers inflaría el pico que se mide). */
function almacenamientoEnMemoria(): ObjectStorage & { objetos: number; bytes: number } {
  const estado = { objetos: 0, bytes: 0 };
  const noUsado = () => Promise.reject(new Error("no se usa en la prueba de volumen"));
  return Object.assign(estado, {
    async put(_clave: string, cuerpo: Buffer) {
      estado.objetos += 1;
      estado.bytes += cuerpo.byteLength;
    },
    get: noUsado,
    getStream: noUsado,
    urlFirmada: noUsado,
    postFirmado: noUsado,
  }) as unknown as ObjectStorage & { objetos: number; bytes: number };
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  escenario = await armarEscenario(admin, "2045-05");
  await conUsuario(db, escenario.usuario, (tx) => generarLiquidaciones(tx, { periodoId: escenario.periodoId }));
  await conUsuario(db, escenario.usuario, (tx) => emitirPeriodo(tx, { periodoId: escenario.periodoId }));
});

afterAll(async () => {
  if (escenario) await desarmarEscenario(admin, escenario);
  await Promise.all([admin.end(), appPool.end()]);
});

describe(`emisión de ${UNIDADES} boletas en PDF`, () => {
  it("emite todas en lotes de 50, dentro del tope de tiempo y de memoria", async () => {
    const almacenamiento = almacenamientoEnMemoria();
    // El navegador lo abre y lo cierra el propio lote (efímero por job, como en el worker).
    const generador = crearGeneradorChromium();
    {
      const { resultado, ms, picoRssMb } = await medir(() =>
        emitirDocumentosDelPeriodo(
          {
            id: randomUUID(),
            tipo: "emitir_documentos_periodo",
            barrioId: escenario.barrioId,
            referenciaId: escenario.periodoId,
            solicitadoPor: escenario.usuario,
            intento: 1,
          },
          {
            db,
            almacenamiento,
            generador,
            registroDeMedios: registroPorDefecto(),
            chunk: CHUNK,
            timeoutMs: 120_000,
            alAvanzar: async () => undefined,
          },
        ),
      );
      anotar("boletas-700", { ms, picoRssMb, kbPorBoleta: Math.round(almacenamiento.bytes / almacenamiento.objetos / 1024) });
      expect(resultado.escritos).toBe(UNIDADES);
      expect(almacenamiento.objetos).toBe(UNIDADES);
      expect(ms).toBeLessThan(TOPES.boletasMs);
      expect(picoRssMb).toBeLessThan(TOPES.boletasPicoRssMb);
    }
  });
});
