"use server";

/**
 * «Conceptos del barrio» (encargo 16b): el catálogo de conceptos de boleta —alta, edición y valor
 * nuevo— y los grupos de unidades —alta, edición y borrado—.
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared`, `conSesion`, **una** llamada a un servicio y `revalidatePath` + resultado
 * serializable. Quién puede (la administración del barrio), que el nombre de un grupo no se repita,
 * que un concepto que se aplica solo vaya a todas o a un grupo: todo eso lo deciden el esquema, el
 * servicio y la base. Acá no hay ninguna de esas reglas.
 *
 * **Lo único que se adapta antes del `parse` es la forma en que llega un formulario**, no su
 * contenido: el porcentaje se tipea con coma («7,5») y el esquema lo espera con punto, y las unidades
 * de un grupo son varias casillas con el mismo nombre, que `valoresDe` no junta. Los valores que
 * vuelven a la pantalla son siempre los crudos.
 *
 * Se revalidan la pantalla del catálogo y los meses: lo que un concepto dice hoy cambia lo que se
 * ofrece para aplicar y lo que un mes sin emitir va a aplicar solo.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { idSchema } from "@admin-barrios/shared/consultas";
import {
  crearGrupoDeUnidadesSchema,
  editarConceptoBoletaSchema,
  editarGrupoDeUnidadesSchema,
} from "@admin-barrios/shared/conceptos";
import { crearConceptoBoletaSchema, registrarValorConceptoSchema } from "@admin-barrios/shared/escrituras";
import { crearConceptoBoleta, editarConceptoBoleta, registrarValorConcepto } from "@admin-barrios/data/servicios/conceptos-boleta";
import { borrarGrupoDeUnidades, crearGrupoDeUnidades, editarGrupoDeUnidades } from "@admin-barrios/data/servicios/grupos";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion, type ValoresDeFormulario } from "./resultado.ts";

function revalidarLosConceptos(): void {
  revalidatePath("/[barrio]/configuracion/conceptos", "page");
  // Todas las pestañas del mes: «Conceptos del mes» y el formulario de «Aplicar un concepto».
  revalidatePath("/[barrio]/liquidacion/[periodo]", "layout");
}

/** «7,5» → «7.5»: el porcentaje se tipea con coma y el esquema lo valida con punto. No calcula nada. */
function conPorcentajeConPunto(valores: ValoresDeFormulario): ValoresDeFormulario {
  const tipeado = valores["porcentaje"];
  return tipeado === undefined ? valores : { ...valores, porcentaje: tipeado.trim().replace(",", ".") };
}

/** Las casillas marcadas de un grupo: varias con el mismo nombre, que `valoresDe` no junta. */
function unidadesDe(form: FormData): string[] {
  return form.getAll("unidades").filter((v): v is string => typeof v === "string");
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El catálogo de conceptos de boleta
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** «Nuevo concepto»: el concepto con su primer valor, en una sola operación. */
export async function crearConceptoBoletaAction(
  _previo: ResultadoDeAccion<{ readonly conceptoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly conceptoId: string }>> {
  const valores = valoresDe(form);
  const entrada = crearConceptoBoletaSchema.safeParse(conPorcentajeConPunto(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    const { conceptoId } = await crearConceptoBoleta(tx, entrada.data);
    return { conceptoId };
  });
  if (resultado.estado === "ok") revalidarLosConceptos();
  return resultado;
}

/** «Editar»: el nombre, si está activo, a quién va y cómo entra cada mes. El importe va aparte. */
export async function editarConceptoBoletaAction(
  _previo: ResultadoDeAccion<{ readonly conceptoBoletaId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly conceptoBoletaId: string }>> {
  const valores = valoresDe(form);
  const entrada = editarConceptoBoletaSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await editarConceptoBoleta(tx, entrada.data);
    return { conceptoBoletaId: entrada.data.conceptoBoletaId };
  });
  if (resultado.estado === "ok") revalidarLosConceptos();
  return resultado;
}

/** «Cambiar el valor»: un valor nuevo con su «rige desde». La vigencia anterior la cierra la base. */
export async function registrarValorConceptoAction(
  _previo: ResultadoDeAccion<{ readonly valorId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly valorId: string }>> {
  const valores = valoresDe(form);
  const entrada = registrarValorConceptoSchema.safeParse(conPorcentajeConPunto(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => registrarValorConcepto(tx, entrada.data));
  if (resultado.estado === "ok") revalidarLosConceptos();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los grupos de unidades
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** «Nuevo grupo»: el nombre y las unidades elegidas del padrón. */
export async function crearGrupoDeUnidadesAction(
  _previo: ResultadoDeAccion<{ readonly grupoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly grupoId: string }>> {
  const valores = valoresDe(form);
  const entrada = crearGrupoDeUnidadesSchema.safeParse({ ...valores, unidades: unidadesDe(form) });
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => crearGrupoDeUnidades(tx, entrada.data));
  if (resultado.estado === "ok") revalidarLosConceptos();
  return resultado;
}

/** «Editar unidades»: el nombre y la lista **completa** de unidades (las que no vienen, salen). */
export async function editarGrupoDeUnidadesAction(
  _previo: ResultadoDeAccion<{ readonly grupoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly grupoId: string }>> {
  const valores = valoresDe(form);
  const entrada = editarGrupoDeUnidadesSchema.safeParse({ ...valores, unidades: unidadesDe(form) });
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await editarGrupoDeUnidades(tx, entrada.data);
    return { grupoId: entrada.data.grupoId };
  });
  if (resultado.estado === "ok") revalidarLosConceptos();
  return resultado;
}

/**
 * Lo único que manda «Borrar»: qué grupo. El id se valida con el mismo `idSchema` de siempre; que
 * ningún concepto lo use y que quien borra administre el barrio lo decide el servicio.
 */
const borrarGrupoSchema = z.object({ grupoId: idSchema });

/** «Borrar»: solo un grupo que ningún concepto usa. */
export async function borrarGrupoDeUnidadesAction(
  _previo: ResultadoDeAccion<{ readonly grupoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly grupoId: string }>> {
  const valores = valoresDe(form);
  const entrada = borrarGrupoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await borrarGrupoDeUnidades(tx, entrada.data);
    return { grupoId: entrada.data.grupoId };
  });
  if (resultado.estado === "ok") revalidarLosConceptos();
  return resultado;
}
