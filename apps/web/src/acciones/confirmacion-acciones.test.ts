/**
 * **El ida y vuelta de una confirmación, contra las acciones de verdad** (BL-024, paso 1).
 *
 * `confirmacion.test.ts` prueba `conConfirmacion` sola. Este archivo prueba lo que la persona ve: la
 * acción real (`registrarPagoAction`, `condonarInteresAction`, `agregarUnidadAction`,
 * `cambiarTitularAction`) recibe el formulario, el servicio pide confirmación, la pantalla reemite los
 * valores **sin** los campos de confirmación (como `PedidoDeConfirmacion`) más la casilla, y la acción
 * tiene que llegar al servicio con la confirmación puesta.
 *
 * El bug que fija: `registrarPagoAction` y `condonarInteresAction` parseaban los valores crudos, sin
 * pasar por `conConfirmacion`. Como `confirmarPagoConInteres` y `confirmarCondonacion` están en
 * `CAMPOS_DE_CONFIRMACION` y no viajan ocultos, el servicio nunca los veía y volvía a pedir la
 * confirmación **sin fin**: un pago fuera de término no se podía registrar desde la pantalla.
 *
 * Lo único doblado es la frontera: la sesión (`conSesion` corre el callback con una transacción
 * vacía), la caché de Next y los servicios, que piden confirmación con el mismo `ErrorDeNegocio` que
 * lanza la base. El `parse`, `ejecutar`, la traducción del rechazo y la tabla de confirmaciones son
 * los de producción.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorDeNegocio, type CodigoError } from "@admin-barrios/shared/errores";
import {
  CAMPO_CODIGO_CONFIRMADO,
  CAMPO_CONFIRMO,
  CAMPOS_DE_CONFIRMACION,
  CONFIRMACIONES,
  VALOR_CONFIRMO,
} from "./confirmacion.ts";
import type { ResultadoDeAccion, ValoresDeFormulario } from "./resultado.ts";

vi.mock("../servidor/db.ts", () => ({ conSesion: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("../servidor/almacenamiento.ts", () => ({
  urlDeSubidaDeComprobante: vi.fn(),
  exigirSubidaConfigurada: vi.fn(),
}));

/** El servicio pide confirmación hasta que el campo llega en `true`, igual que el de verdad. */
const pideConfirmacion = (codigo: CodigoError, confirmado: (p: Record<string, unknown>) => boolean) =>
  vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
    if (!confirmado(p)) {
      throw new ErrorDeNegocio({ codigo, mensaje: "Pide confirmación.", sugerencia: "Confirmá.", correlacion: "test" });
    }
    return {};
  });

vi.mock("@admin-barrios/data/servicios/deuda", async (original) => ({
  ...(await original<object>()),
  registrarEImputarPago: pideConfirmacion("pago_con_interes_requiere_confirmacion", (p) => p["confirmarPagoConInteres"] === true),
  condonarInteres: pideConfirmacion("condonacion_requiere_confirmacion", (p) => p["confirmarCondonacion"] === true),
}));
vi.mock("@admin-barrios/data/servicios/padron-edicion", async (original) => ({
  ...(await original<object>()),
  agregarUnidad: pideConfirmacion("titular_ya_registrado", (p) => p["confirmarTitularRegistrado"] === true),
  cambiarTitular: pideConfirmacion("titular_ya_registrado", (p) => p["confirmarTitularRegistrado"] === true),
}));

const { registrarPagoAction, condonarInteresAction } = await import("./cobros.ts");
const { agregarUnidadAction, cambiarTitularAction } = await import("./padron.ts");

type Accion = (previo: ResultadoDeAccion<never>, form: FormData) => Promise<ResultadoDeAccion<unknown>>;

const formulario = (valores: ValoresDeFormulario): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(valores)) f.append(k, v);
  return f;
};

/** Lo que reemite `PedidoDeConfirmacion`: los valores devueltos SIN los campos de confirmación, y la casilla. */
const reenvio = (devueltos: ValoresDeFormulario, codigo: string, marcaLaCasilla: boolean): ValoresDeFormulario => ({
  ...Object.fromEntries(Object.entries(devueltos).filter(([clave]) => !CAMPOS_DE_CONFIRMACION.has(clave))),
  [CAMPO_CODIGO_CONFIRMADO]: codigo,
  ...(marcaLaCasilla ? { [CAMPO_CONFIRMO]: VALOR_CONFIRMO } : {}),
});

const unidad = randomUUID();
const CASOS: readonly { nombre: string; accion: Accion; codigo: CodigoError; valores: ValoresDeFormulario }[] = [
  {
    nombre: "registrar un pago fuera de término (cobros/nuevo)",
    accion: registrarPagoAction as unknown as Accion,
    codigo: "pago_con_interes_requiere_confirmacion",
    valores: { unidadFuncionalId: unidad, monto: "50000.00", fecha: "2026-10-20", origen: "manual", comprobanteAdjunto: "pagos/x.pdf" },
  },
  {
    nombre: "condonar interés desde el estado de cuenta (cobros/[unidad])",
    accion: condonarInteresAction as unknown as Accion,
    codigo: "condonacion_requiere_confirmacion",
    valores: { unidadFuncionalId: unidad, monto: "1200.00", motivo: "negociacion", detalle: "Acordado con el propietario en la reunión." },
  },
  {
    nombre: "agregar una unidad con un titular ya registrado (padrón)",
    accion: agregarUnidadAction as unknown as Accion,
    codigo: "titular_ya_registrado",
    valores: { barrioId: randomUUID(), manzana: "A", lote: "9", estado: "construido", "titular.0.nombre": "Raúl A. Molina", "titular.0.documento": "20111222" },
  },
  {
    nombre: "cambiar el titular por uno ya registrado (ficha de la unidad)",
    accion: cambiarTitularAction as unknown as Accion,
    codigo: "titular_ya_registrado",
    valores: { unidadFuncionalId: unidad, desde: "2026-10-01", motivo: "venta", "titular.nombre": "Raúl A. Molina", "titular.documento": "20111222" },
  },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe.each(CASOS)("$nombre", ({ accion, codigo, valores }) => {
  const campo = Object.keys(CONFIRMACIONES[codigo]!.campos)[0]!;

  it("pide confirmación, y con la casilla marcada se registra (no vuelve a pedirla)", async () => {
    const v1 = await accion({ estado: "inicial" }, formulario(valores));
    expect(v1.estado, JSON.stringify(v1)).toBe("confirmar");
    if (v1.estado !== "confirmar") return;

    const v2 = await accion(v1 as never, formulario(reenvio(v1.valores, codigo, true)));
    expect(v2.estado, `la confirmación no llegó al servicio: ${JSON.stringify(v2)}`).toBe("ok");
  });

  it("sin marcar la casilla no confirma, y el campo de la confirmación nunca vuelve a pantalla", async () => {
    const v1 = await accion({ estado: "inicial" }, formulario(valores));
    if (v1.estado !== "confirmar") throw new Error(JSON.stringify(v1));
    const sinCasilla = await accion(v1 as never, formulario(reenvio(v1.valores, codigo, false)));
    expect(sinCasilla.estado).toBe("confirmar");

    // Aunque el reintento confirme, lo que vuelve a pantalla son los crudos: nada queda pegado.
    const conCasilla = await accion(v1 as never, formulario(reenvio(v1.valores, codigo, true)));
    if ("valores" in conCasilla) expect(conCasilla.valores[campo]).toBeUndefined();
    if (sinCasilla.estado === "confirmar") expect(sinCasilla.valores[campo]).toBeUndefined();
  });
});
