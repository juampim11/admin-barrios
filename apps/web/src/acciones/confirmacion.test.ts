/**
 * El camino de la confirmación: **que la pantalla no pueda confirmar sola.**
 *
 * Es el único mecanismo del recorrido donde un bug se ve como un éxito. Si `conConfirmacion` agregara
 * los campos de más, el candado del monto inusual —que existe para que un cero de más no llegue a una
 * boleta— se convertiría en un cartel: el servicio rechazaría, la pantalla reintentaría sola, y nadie
 * se enteraría nunca de que la pregunta se hizo. Por eso las tres condiciones se prueban por separado
 * y también todas juntas.
 *
 *  1. sin la casilla marcada, la confirmación **no se aplica** — el reintento sale igual que el
 *     intento original y el servicio vuelve a rechazar;
 *  2. sin el código, tampoco;
 *  3. con un código que no está en la tabla, tampoco;
 *  4. con un código inventado que ni siquiera está en el catálogo, tampoco;
 *  5. con un valor distinto del esperado en la casilla, tampoco;
 *  6. con las tres condiciones, los campos se agregan **sin pisar lo que la persona cargó**;
 *  7. la tabla de producción tiene exactamente lo que se decidió que tenga — y en particular **no**
 *     tiene los tres códigos que significan "esto lo tiene que hacer otra persona", que serían una
 *     casilla ofrecida a quien no tiene derecho a marcarla.
 */

import { describe, expect, it } from "vitest";
import { aplicarConceptoAUnidadSchema } from "@admin-barrios/shared/escrituras";
import {
  CAMPOS_DE_CONFIRMACION,
  CAMPO_CODIGO_CONFIRMADO,
  CAMPO_CONFIRMO,
  CONFIRMACIONES,
  VALOR_CONFIRMO,
  conConfirmacion,
  confirmacionDe,
  type Confirmaciones,
} from "./confirmacion.ts";
import type { ValoresDeFormulario } from "./resultado.ts";

/**
 * Una tabla de prueba. Usa `tope_operador` **solo como etiqueta de un código que existe**: en
 * producción ese código NO es confirmable (ver el último test), y por eso la tabla sintética vive acá
 * y no en `CONFIRMACIONES`. Que `confirmacionDe` y `conConfirmacion` acepten la tabla por parámetro
 * es lo que permite probar el mecanismo sin tocar lo que se decidió que se puede confirmar.
 */
const TABLA: Confirmaciones = {
  tope_operador: {
    titulo: "Este cargo necesita tu confirmación.",
    queSeConfirma: "Autorizás que se cobre igual.",
    leyendaDeLaCasilla: "Reviso el importe y lo autorizo.",
    textoDelBoton: "Confirmar y aplicar",
    campos: { origenEvaluacion: "override_administrador" },
  },
};

/** Lo que la persona cargó en el formulario, sin ninguna confirmación. */
const CARGADO = {
  periodoId: "9d0a3b0e-0f2a-4a4f-9a09-6d9a1a2b3c4d",
  unidadFuncionalId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  detalle: "Quincho, sábado a la noche",
} as const;

describe("un rechazo se reconoce como pedido de confirmación solo si está en la tabla", () => {
  it("devuelve la confirmación registrada", () => {
    expect(confirmacionDe("tope_operador", TABLA)?.textoDelBoton).toBe("Confirmar y aplicar");
  });

  it("un código que no está en la tabla no es confirmable", () => {
    expect(confirmacionDe("periodo_no_cuadra", TABLA)).toBeNull();
  });

  it("la tabla de producción tiene exactamente lo decidido, ni un código de más", () => {
    // Si esto falla es porque alguien registró una entrada nueva. Bien: leé el comentario de
    // `confirmacion.ts` y actualizá este test a mano. Lo que no puede pasar es que la tabla crezca
    // sin que nadie lo note — cada entrada es permiso para que una persona levante un freno.
    expect(Object.keys(CONFIRMACIONES).sort()).toEqual(["cargo_requiere_confirmacion"]);
  });

  it("se reintenta con el campo real del esquema, no con uno inventado", () => {
    // `confirmarMontoInusual` es un campo de `aplicarConceptoAUnidadSchema`. Si alguien lo renombra
    // en `packages/shared`, el `parse` del reintento lo descartaría en silencio y la confirmación
    // dejaría de surtir efecto: el síntoma sería "aprieto confirmar y vuelve a pedir confirmación".
    expect(confirmacionDe("cargo_requiere_confirmacion")?.campos).toEqual({
      confirmarMontoInusual: "1",
    });
    expect(aplicarConceptoAUnidadSchema.shape).toHaveProperty("confirmarMontoInusual");
  });

  it("los códigos que significan «esto lo tiene que hacer otro» NO son confirmables", () => {
    // Los tres son callejones para quien está mirando: no puede levantar su propio tope ni cambiar su
    // rol. Ofrecerle una casilla sería ofrecerle un botón que no le corresponde, y la persona lo
    // apretaría creyendo que resuelve algo.
    for (const codigo of ["tope_operador", "concepto_requiere_admin", "sin_limite_de_aplicacion"] as const) {
      expect(confirmacionDe(codigo), codigo).toBeNull();
    }
  });
});

describe("la confirmación se aplica solo con las tres condiciones, y nunca sola", () => {
  it("sin la casilla marcada no agrega nada, aunque venga el código", () => {
    const valores = { ...CARGADO, [CAMPO_CODIGO_CONFIRMADO]: "tope_operador" };
    expect(conConfirmacion(valores, TABLA)).toEqual(valores);
  });

  it("sin el código no agrega nada, aunque la casilla esté marcada", () => {
    const valores = { ...CARGADO, [CAMPO_CONFIRMO]: VALOR_CONFIRMO };
    expect(conConfirmacion(valores, TABLA)).toEqual(valores);
  });

  it("con un código que no está en la tabla no agrega nada", () => {
    const valores = {
      ...CARGADO,
      [CAMPO_CONFIRMO]: VALOR_CONFIRMO,
      [CAMPO_CODIGO_CONFIRMADO]: "periodo_no_cuadra",
    };
    expect(conConfirmacion(valores, TABLA)).toEqual(valores);
  });

  it("con un código que ni siquiera está en el catálogo no agrega nada", () => {
    // El valor llega de un `<input type="hidden">`, o sea del cliente: puede ser cualquier string.
    const valores = {
      ...CARGADO,
      [CAMPO_CONFIRMO]: VALOR_CONFIRMO,
      [CAMPO_CODIGO_CONFIRMADO]: "codigo_que_no_existe",
    };
    expect(conConfirmacion(valores, TABLA)).toEqual(valores);
  });

  it("un valor distinto de `si` en la casilla no cuenta como marcada", () => {
    const valores = {
      ...CARGADO,
      [CAMPO_CONFIRMO]: "on", // el default de un checkbox HTML sin `value`
      [CAMPO_CODIGO_CONFIRMADO]: "tope_operador",
    };
    expect(conConfirmacion(valores, TABLA)).toEqual(valores);
  });

  it("con las tres condiciones agrega los campos y no toca lo que la persona cargó", () => {
    const resultado = conConfirmacion(
      { ...CARGADO, [CAMPO_CONFIRMO]: VALOR_CONFIRMO, [CAMPO_CODIGO_CONFIRMADO]: "tope_operador" },
      TABLA,
    );

    expect(resultado["origenEvaluacion"]).toBe("override_administrador");
    // Lo que se confirma es exactamente lo que se había pedido: ni un campo distinto.
    expect(resultado["periodoId"]).toBe(CARGADO.periodoId);
    expect(resultado["unidadFuncionalId"]).toBe(CARGADO.unidadFuncionalId);
    expect(resultado["detalle"]).toBe(CARGADO.detalle);
  });
});

/**
 * **El ciclo completo, que es donde estaba el agujero.**
 *
 * Los tests de arriba prueban `conConfirmacion` aislada, y ahí siempre estuvo bien. El bug vivía un
 * renglón más afuera: la acción devolvía al navegador los valores **ya mergeados**, el pedido de
 * confirmación los reemitía como campos ocultos, y desde el segundo pedido `confirmarMontoInusual`
 * viajaba solo. La casilla pasaba a ser decorativa y la base registraba "alguien revisó y confirmó"
 * sobre un envío en el que nadie marcó nada — justo el dato que después contesta un reclamo.
 *
 * Estos tests recorren las tres vueltas simulando lo que hace el navegador: lo que vuelve de la
 * acción se reemite, filtrado por `CAMPOS_DE_CONFIRMACION`, igual que en `PedidoDeConfirmacion`.
 */
describe("el ida y vuelta: confirmar una vez no confirma para siempre", () => {
  /**
   * Este bloque usa la tabla **de producción** y no la sintética, a propósito: `CAMPOS_DE_CONFIRMACION`
   * se arma desde `CONFIRMACIONES`, así que con una tabla inventada el filtro no cubriría su campo y
   * el test estaría probando otra cosa que la que corre. El código es `cargo_requiere_confirmacion` y
   * el campo, `confirmarMontoInusual`.
   */
  const CODIGO = "cargo_requiere_confirmacion";
  const CAMPO = "confirmarMontoInusual";

  /** Lo que la pantalla reemite como campos ocultos, igual que `PedidoDeConfirmacion`. */
  const loQueVuelveAlServidor = (
    devueltos: ValoresDeFormulario,
    marcaLaCasilla: boolean,
  ): ValoresDeFormulario => ({
    ...Object.fromEntries(
      Object.entries(devueltos).filter(([clave]) => !CAMPOS_DE_CONFIRMACION.has(clave)),
    ),
    [CAMPO_CODIGO_CONFIRMADO]: CODIGO,
    ...(marcaLaCasilla ? { [CAMPO_CONFIRMO]: VALOR_CONFIRMO } : {}),
  });

  /** Lo que hace la acción: mergea para el `parse` y **devuelve los crudos**. */
  const laAccion = (recibidos: ValoresDeFormulario) => ({
    loQueVeElServicio: conConfirmacion(recibidos),
    loQueVuelveAPantalla: recibidos,
  });

  it("vuelta 1 sin confirmar → vuelta 2 confirmando → vuelta 3 SIN marcar no confirma", () => {
    // Vuelta 1: se envía el formulario tal cual. Nadie confirmó nada.
    const v1 = laAccion({ ...CARGADO });
    expect(v1.loQueVeElServicio[CAMPO]).toBeUndefined();

    // Vuelta 2: la persona marca la casilla. El servicio sí ve la confirmación...
    const v2 = laAccion(loQueVuelveAlServidor(v1.loQueVuelveAPantalla, true));
    expect(v2.loQueVeElServicio[CAMPO]).toBe("1");
    // ...y lo que vuelve a la pantalla **no la lleva**. Éste es el renglón que estaba mal: la acción
    // devolvía el objeto ya mergeado y desde acá la confirmación se quedaba pegada.
    expect(v2.loQueVuelveAPantalla[CAMPO]).toBeUndefined();

    // Vuelta 3: el servicio volvió a rechazar —el umbral es acumulado, así que pasa— y la persona
    // aprieta el botón SIN marcar la casilla. No tiene que confirmar: si lo hiciera, el candado
    // sería un cartel y la base registraría que alguien revisó cuando nadie revisó nada.
    const v3 = laAccion(loQueVuelveAlServidor(v2.loQueVuelveAPantalla, false));
    expect(v3.loQueVeElServicio[CAMPO]).toBeUndefined();
  });

  it("el campo de una confirmación nunca se reemite como campo oculto", () => {
    // Cinturón y tirante: el tirante es que la acción devuelve los crudos; esto es el cinturón. Aunque
    // por cualquier motivo llegara mergeado a la pantalla, el filtro lo saca.
    const mergeado = conConfirmacion({
      ...CARGADO,
      [CAMPO_CONFIRMO]: VALOR_CONFIRMO,
      [CAMPO_CODIGO_CONFIRMADO]: CODIGO,
    });
    expect(mergeado[CAMPO]).toBe("1");
    expect(loQueVuelveAlServidor(mergeado, false)[CAMPO]).toBeUndefined();
  });

  it("`CAMPOS_DE_CONFIRMACION` cubre los campos de TODA confirmación registrada", () => {
    // Si alguien agrega una entrada a `CONFIRMACIONES` con un campo nuevo, el filtro tiene que
    // cubrirlo sin que haya que acordarse de nada. Sale de la misma tabla, y esto lo fija.
    for (const confirmacion of Object.values(CONFIRMACIONES)) {
      for (const campo of Object.keys(confirmacion.campos)) {
        expect(CAMPOS_DE_CONFIRMACION.has(campo), campo).toBe(true);
      }
    }
    expect(CAMPOS_DE_CONFIRMACION.has(CAMPO_CONFIRMO)).toBe(true);
    expect(CAMPOS_DE_CONFIRMACION.has(CAMPO_CODIGO_CONFIRMADO)).toBe(true);
  });
});
