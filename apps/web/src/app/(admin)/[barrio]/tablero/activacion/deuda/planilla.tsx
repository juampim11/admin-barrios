"use client";

/**
 * «Subir la planilla de deuda» (encargo 17; pantalla 2 de la maqueta): elegir el archivo, ver la
 * vista previa —cada deuda y cada saldo a favor que entraría, y todos los errores, fila por fila— y
 * recién ahí confirmar. Calco de la planilla de usos (`liquidacion/[periodo]/conceptos/planilla.tsx`).
 *
 * **Ninguna regla vive acá.** Qué fila está mal, qué unidad y qué concepto son, cuánto suma y si
 * confirmar reemplaza una carga anterior lo resuelve el servicio (`vistaPreviaDeDeudaAnterior`); la
 * isla muestra lo que vuelve, con los mensajes de error tal cual llegan.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * DOS PASOS, DOS CAMINOS
 *
 * **1. La vista previa va por `fetch`** al route handler `api/activacion/deuda`: el archivo puede
 * pesar hasta 5 MB y el tope de una Server Action es 1 MB. La función que lo llama tiene la forma de
 * una acción, así que el formulario pasa por `useFormulario` igual que el resto. Ese paso no escribe.
 *
 * **2. «Confirmar» es una Server Action** (`cargarDeudaAnteriorAction`), con las filas que el servidor
 * leyó del archivo en un campo oculto. Lo que viaja no se da por bueno: el servicio valida de nuevo
 * cada fila contra la base, y carga la planilla entera o no carga nada.
 *
 * Con un solo error no se ofrece «Confirmar».
 */

import { useState } from "react";
import { z } from "zod";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { CODIGOS_ERROR, type ErrorParaMostrar } from "@admin-barrios/shared/errores";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { Chip, CifraDeLaFila, FilaDeCifras } from "@admin-barrios/ui";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { cargarDeudaAnteriorAction } from "../../../../../../acciones/activacion.ts";
import type { ResultadoDeAccion } from "../../../../../../acciones/resultado.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivoDelFormulario,
  Campos,
  Formulario,
  useFormulario,
  useVolverAlGuardar,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { MarcoTabla, Nota, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import { chipDeRenglon, dondeEstaElError, NADA_SE_GUARDA, tituloDeErrores } from "../textos.ts";
import estilos from "../activacion.module.css";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que devuelve el route handler, validado en el borde
// ────────────────────────────────────────────────────────────────────────────────────────────────

const renglonSchema = z.object({
  fila: z.number().int(),
  tipo: z.enum(["deuda", "a_favor"]),
  unidad: z.string(),
  periodo: z.string().nullable(),
  concepto: z.string().nullable(),
  vencimiento: z.string().nullable(),
  importe: z.string(),
});
const previaSchema = z.object({
  vista: z.object({
    archivo: z.string(),
    filasLeidas: z.number().int().min(0),
    renglones: z.array(renglonSchema),
    errores: z.array(z.object({ fila: z.number().int(), mensaje: z.string() })),
    deudas: z.number().int().min(0),
    totalDeuda: z.string(),
    saldosAFavor: z.number().int().min(0),
    totalAFavor: z.string(),
    unidadesConDeuda: z.number().int().min(0),
    reemplaza: z.boolean(),
  }),
  filas: z.array(z.array(z.string())),
});
const errorSchema = z.object({
  codigo: z.enum(CODIGOS_ERROR).catch("desconocido"),
  mensaje: z.string(),
  sugerencia: z.string(),
  correlacion: z.string().catch(""),
});
const respuestaSchema = z.discriminatedUnion("estado", [
  z.object({ estado: z.literal("ok"), valor: z.unknown() }),
  z.object({ estado: z.literal("campos"), campos: z.record(z.string(), z.array(z.string())) }),
  z.object({ estado: z.literal("falla"), error: errorSchema }),
]);

type Previa = z.infer<typeof previaSchema>;

const falla = (codigo: ErrorParaMostrar["codigo"], mensaje: string, sugerencia: string): ResultadoDeAccion<Previa> => ({
  estado: "falla",
  error: { ok: false, codigo, mensaje, sugerencia, correlacion: "", datos: {} },
  valores: {},
});
const enElArchivo = (mensaje: string): ResultadoDeAccion<Previa> => ({ estado: "campos", campos: { archivo: [mensaje] }, valores: {} });

const pesos = (m: string) => `$ ${formatearMonto(m)}`;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La isla
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function PlanillaDeDeuda({
  barrioId,
  rutaPlantilla,
  maximoDeFilas,
  volverA,
  salidas,
}: {
  readonly barrioId: string;
  readonly rutaPlantilla: string;
  /** «5.000», ya formateado por el servidor. */
  readonly maximoDeFilas: string;
  /** A dónde se vuelve al confirmar: el tablero con `?listo=deuda_anterior`. */
  readonly volverA: string;
  readonly salidas: Salidas;
}) {
  const [previa, setPrevia] = useState<Previa | null>(null);
  // Cambia con cada archivo: la vista previa nace de nuevo, sin el resultado de la planilla anterior.
  const [generacion, setGeneracion] = useState(0);

  async function pedir(_previo: ResultadoDeAccion<Previa>, form: FormData): Promise<ResultadoDeAccion<Previa>> {
    const elegido = form.get("archivo");
    const archivo = elegido instanceof File && elegido.size > 0 ? elegido : null;
    if (!archivo) return enElArchivo("Elegí el archivo de la planilla (Excel o CSV).");

    let respuesta: Response;
    try {
      respuesta = await fetch(`/api/activacion/deuda?${new URLSearchParams({ barrio: barrioId, nombre: archivo.name }).toString()}`, {
        method: "POST",
        body: archivo,
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch {
      return falla("desconocido", "No se pudo mandar la planilla.", "Revisá tu conexión y probá de nuevo.");
    }
    if (respuesta.status === 401) return falla("sin_permiso", "La sesión se cerró.", "Volvé a entrar y subí la planilla de nuevo.");
    if (respuesta.status === 403) {
      return falla("sin_permiso", "Cargar la deuda anterior es de la administración del barrio.", "Pedíselo a quien administra el barrio.");
    }

    let cuerpo: z.infer<typeof respuestaSchema>;
    try {
      cuerpo = respuestaSchema.parse(await respuesta.json());
    } catch {
      return falla("desconocido", "La respuesta del servidor no se pudo leer.", "Probá de nuevo en un momento.");
    }
    if (cuerpo.estado === "campos") return { estado: "campos", campos: cuerpo.campos, valores: {} };
    if (cuerpo.estado === "falla") return { estado: "falla", error: { ok: false, datos: {}, ...cuerpo.error }, valores: {} };

    const leida = previaSchema.safeParse(cuerpo.valor);
    if (!leida.success) return falla("desconocido", "La vista previa no se pudo leer.", "Probá de nuevo en un momento.");
    setPrevia(leida.data);
    setGeneracion((g) => g + 1);
    return { estado: "ok", valor: leida.data };
  }

  const { enviar, pendiente, resultado, campos } = useFormulario<Previa>(pedir);

  return (
    <div className={estilos.apilado}>
      <Formulario accion={enviar} etiqueta="Subir la planilla de deuda">
        <Campos>
          <CampoArchivoDelFormulario
            nombre="archivo"
            etiqueta="Archivo"
            requerido
            ancho
            aceptar=".xlsx,.csv"
            errores={campos["archivo"]}
            ayuda={
              <>
                Excel o CSV, hasta {maximoDeFilas} filas, con las columnas manzana, lote, mes, concepto, vencimiento e importe. Una
                fila por cada mes que una unidad todavía debe, con lo que falta pagar. Un saldo a favor va con el importe en negativo
                y sin mes. <a href={rutaPlantilla}>Bajar la plantilla</a>.
              </>
            }
          />
        </Campos>
        <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}</Avisos>
        <Acciones ayuda={NADA_SE_GUARDA}>
          <BotonEnviar pendiente={pendiente} cargando="Leyendo la planilla…">
            Ver la vista previa
          </BotonEnviar>
        </Acciones>
      </Formulario>

      {previa ? (
        <VistaPrevia
          key={generacion}
          barrioId={barrioId}
          previa={previa}
          volverA={volverA}
          salidas={salidas}
          alDescartar={() => setPrevia(null)}
        />
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La vista previa y «Confirmar»
// ────────────────────────────────────────────────────────────────────────────────────────────────

function VistaPrevia({
  barrioId,
  previa,
  volverA,
  salidas,
  alDescartar,
}: {
  readonly barrioId: string;
  readonly previa: Previa;
  readonly volverA: string;
  readonly salidas: Salidas;
  readonly alDescartar: () => void;
}) {
  const { vista, filas } = previa;
  const { enviar, pendiente, resultado, campos } = useFormulario(cargarDeudaAnteriorAction);
  // Cargada: vuelve al tablero, que dice el «Listo:» con lo que quedó en la base.
  useVolverAlGuardar(resultado, () => volverA);

  if (resultado.estado === "ok") {
    return <AvisoDeExito titulo="Listo: la deuda anterior quedó cargada.">Volviendo al tablero…</AvisoDeExito>;
  }

  const conErrores = vista.errores.length > 0;
  const sueltos = Object.values(campos).flatMap((m) => m ?? []);

  return (
    <div className={estilos.apilado}>
      <p className={ui.secundaria}>
        Vista previa de «{vista.archivo}»: {vista.filasLeidas === 1 ? "1 fila leída" : `${vista.filasLeidas} filas leídas`}. {NADA_SE_GUARDA}
      </p>

      <FilaDeCifras>
        <CifraDeLaFila etiqueta={vista.deudas === 1 ? "deuda" : "deudas"} origen={`por ${pesos(vista.totalDeuda)}`}>
          {vista.deudas}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="saldo a favor" origen={vista.saldosAFavor === 1 ? "de 1 unidad" : `de ${vista.saldosAFavor} unidades`}>
          {pesos(vista.totalAFavor)}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="unidades con deuda" origen="de las que trae la planilla, sin las filas con error">
          {vista.unidadesConDeuda}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="con error" origen={conErrores ? "no entra ningún renglón" : "la planilla está lista para confirmar"}>
          {vista.errores.length}
        </CifraDeLaFila>
      </FilaDeCifras>

      {vista.reemplaza && !conErrores ? (
        <Nota tono="alerta" titulo="Ya hay una deuda anterior cargada.">
          Confirmar esta planilla descarta la carga anterior y la reemplaza entera por esta.
        </Nota>
      ) : null}

      {conErrores ? (
        <>
          <Nota tono="peligro" titulo={tituloDeErrores(vista.errores.length)}>
            Corregí la planilla y volvé a subirla: se carga entera o no se carga.
          </Nota>
          <MarcoTabla etiqueta="Errores de la planilla">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col">Dónde</th>
                  <th scope="col">Qué pasa</th>
                </tr>
              </thead>
              <tbody>
                {vista.errores.map((e, i) => (
                  // La lista no cambia mientras se mira: el índice es estable.
                  <tr key={i}>
                    <th scope="row">{dondeEstaElError(e.fila)}</th>
                    <td>{e.mensaje}</td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        </>
      ) : null}

      {vista.renglones.length > 0 ? (
        <MarcoTabla etiqueta={conErrores ? "Los renglones sin error de la planilla" : "Lo que entraría con la planilla"}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col">Unidad</th>
                <th scope="col">Mes</th>
                <th scope="col">Concepto</th>
                <th scope="col">Venció</th>
                <th scope="col" className={ui.numerica}>
                  Falta pagar
                </th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {vista.renglones.map((r) => {
                const chip = chipDeRenglon(r.tipo);
                return (
                  <tr key={r.fila}>
                    <th scope="row">{r.unidad}</th>
                    <td>{r.periodo ? formatearPeriodo(r.periodo) : <span className={ui.secundaria}>—</span>}</td>
                    <td>{r.concepto ?? <span className={ui.secundaria}>Saldo a favor</span>}</td>
                    <td>{r.vencimiento ? formatearFecha(r.vencimiento) : <span className={ui.secundaria}>—</span>}</td>
                    <td className={ui.numerica}>
                      <span className="dinero">{pesos(r.importe)}</span>
                    </td>
                    <td>
                      {/* Con un error en la planilla no entra ninguno: el chip no promete lo que no va a pasar. */}
                      {conErrores ? <Chip tono="neutro">Sin error</Chip> : <Chip tono={chip.tono}>{chip.texto}</Chip>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Tabla>
        </MarcoTabla>
      ) : null}

      {conErrores || vista.renglones.length === 0 ? (
        <Acciones>
          <BotonDeAccion variante="sutil" onClick={alDescartar}>
            Cerrar la vista previa
          </BotonDeAccion>
        </Acciones>
      ) : (
        <Formulario accion={enviar} etiqueta="Confirmar la carga de la deuda anterior">
          <input type="hidden" name="barrioId" value={barrioId} />
          <input type="hidden" name="archivo" value={vista.archivo} />
          <input type="hidden" name="filas" value={JSON.stringify(filas)} />
          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
            {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
          </Avisos>
          <Acciones ayuda="Se carga entera o no se carga. Si entre la vista previa y ahora cambió algo, el sistema lo vuelve a revisar.">
            <BotonDeAccion variante="sutil" deshabilitado={pendiente} onClick={alDescartar}>
              Descartar
            </BotonDeAccion>
            <BotonEnviar pendiente={pendiente} cargando="Cargando la deuda…">
              {vista.reemplaza ? "Confirmar y reemplazar la carga anterior" : "Confirmar la carga"}
            </BotonEnviar>
          </Acciones>
        </Formulario>
      )}
    </div>
  );
}
