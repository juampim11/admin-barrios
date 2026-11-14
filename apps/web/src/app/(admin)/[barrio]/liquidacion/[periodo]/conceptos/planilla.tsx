"use client";

/**
 * «Subir planilla de usos» (encargo 16b; pantalla 4 de la maqueta): elegir el archivo, ver la vista
 * previa —lo que quedaría en cada boleta y todos los errores, fila por fila— y aplicarla.
 *
 * **Ninguna regla vive acá.** Qué fila está mal, qué precio rige, cuánto suma cada renglón y el total
 * los resuelve el servicio (`vistaPreviaDePlanillaDeUsos`); la isla muestra lo que vuelve.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * DOS PASOS, DOS CAMINOS
 *
 * **1. La vista previa va por `fetch`** al route handler `api/usos/planilla`, como la planilla del
 * padrón: el archivo puede pesar hasta 5 MB y el tope de una Server Action es 1 MB. La función que lo
 * llama tiene la forma de una acción, así que el formulario pasa por `useFormulario` igual que el
 * resto. Ese paso no escribe nada.
 *
 * **2. «Aplicar» es una Server Action** (`aplicarPlanillaDeUsosAction`), con las filas que el servidor
 * leyó del archivo en un campo oculto. Va por una acción para que el pedido de confirmación por
 * importes inusuales sea el de siempre (`PedidoDeConfirmacion`). Lo que viaja no se da por bueno: el
 * servicio valida de nuevo cada fila contra la base, y carga la planilla entera o no carga nada.
 *
 * Con un solo error no se ofrece «Aplicar».
 */

import { useState } from "react";
import { z } from "zod";
import { UNIDADES_DE_USO } from "@admin-barrios/shared/conceptos";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { CODIGOS_ERROR, type ErrorParaMostrar } from "@admin-barrios/shared/errores";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { aplicarPlanillaDeUsosAction } from "../../../../../../acciones/liquidacion.ts";
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
  PedidoDeConfirmacion,
  useFormulario,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { MarcoTabla, Nota, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import {
  cantidadDelRenglon,
  CORREGI_LA_PLANILLA,
  dondeEstaElError,
  planillaAplicada,
  tituloDeErrores,
  usoConFecha,
} from "./textos.ts";
import estilos from "./conceptos.module.css";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que devuelve el route handler, validado en el borde
// ────────────────────────────────────────────────────────────────────────────────────────────────

const renglonSchema = z.object({
  unidadFuncionalId: z.string(),
  unidad: z.string(),
  conceptoBoletaId: z.string(),
  concepto: z.string(),
  unidadUso: z.enum(UNIDADES_DE_USO).nullable(),
  usos: z.array(z.object({ fila: z.number().int(), fecha: z.string(), cantidad: z.string() })),
  cantidad: z.string(),
  cantidadAnterior: z.string(),
  cantidadTotal: z.string(),
  precioUnitario: z.string(),
  importe: z.string(),
});
const previaSchema = z.object({
  vista: z.object({
    archivo: z.string(),
    filasLeidas: z.number().int().min(0),
    renglones: z.array(renglonSchema),
    errores: z.array(z.object({ fila: z.number().int(), mensaje: z.string() })),
    total: z.string(),
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

export function PlanillaDeUsos({
  periodoId,
  rutaPlantilla,
  maximoDeFilas,
  salidas,
}: {
  readonly periodoId: string;
  readonly rutaPlantilla: string;
  /** «2.000», ya formateado por el servidor. */
  readonly maximoDeFilas: string;
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
      respuesta = await fetch(`/api/usos/planilla?${new URLSearchParams({ periodo: periodoId, nombre: archivo.name }).toString()}`, {
        method: "POST",
        body: archivo,
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch {
      return falla("desconocido", "No se pudo mandar la planilla.", "Revisá tu conexión y probá de nuevo.");
    }
    if (respuesta.status === 401) return falla("sin_permiso", "La sesión se cerró.", "Volvé a entrar y subí la planilla de nuevo.");
    if (respuesta.status === 403) {
      return falla("sin_permiso", "No se pueden cargar usos en este mes.", "Los carga la administración del barrio o un operador, antes de emitir.");
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
    <>
      <Formulario accion={enviar} etiqueta="Subir planilla de usos">
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
                Excel o CSV, hasta {maximoDeFilas} filas, con las columnas manzana, lote, concepto, fecha y cantidad.{" "}
                <a href={rutaPlantilla}>Bajar la planilla modelo</a>.
              </>
            }
          />
        </Campos>
        <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}</Avisos>
        <Acciones ayuda="No se carga nada hasta que apliques la planilla.">
          <BotonEnviar pendiente={pendiente} cargando="Leyendo la planilla…">
            Ver la vista previa
          </BotonEnviar>
        </Acciones>
      </Formulario>

      {previa ? (
        <VistaPrevia key={generacion} periodoId={periodoId} previa={previa} salidas={salidas} alDescartar={() => setPrevia(null)} />
      ) : null}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La vista previa y «Aplicar»
// ────────────────────────────────────────────────────────────────────────────────────────────────

function VistaPrevia({
  periodoId,
  previa,
  salidas,
  alDescartar,
}: {
  readonly periodoId: string;
  readonly previa: Previa;
  readonly salidas: Salidas;
  readonly alDescartar: () => void;
}) {
  const { vista, filas } = previa;
  const { enviar, pendiente, resultado, campos, confirmacion, volverACorregir } = useFormulario(aplicarPlanillaDeUsosAction);

  // Aplicada: lo que cargó el servicio. La tabla de arriba ya la muestra la página, releída.
  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo={planillaAplicada(resultado.valor)}>
        <p>Quedó en «Conceptos del mes», con cada uso y la planilla de la que vino («{vista.archivo}»).</p>
      </AvisoDeExito>
    );
  }

  const conErrores = vista.errores.length > 0;
  const sueltos = Object.values(campos).flatMap((m) => m ?? []);

  return (
    <div className={estilos.vistaPrevia}>
      <p className={ui.secundaria}>
        Vista previa de «{vista.archivo}»: {vista.filasLeidas === 1 ? "1 fila leída" : `${vista.filasLeidas} filas leídas`}. Todavía no
        se cargó nada.
      </p>

      {conErrores ? (
        <>
          <Nota tono="peligro" titulo={tituloDeErrores(vista.errores.length)}>
            {CORREGI_LA_PLANILLA}
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
        <MarcoTabla etiqueta="Lo que quedaría en cada boleta">
          <Tabla>
            <thead>
              <tr>
                <th scope="col">Unidad</th>
                <th scope="col">Concepto</th>
                <th scope="col">Usos</th>
                <th scope="col">Cantidad</th>
                <th scope="col" className={ui.numerica}>
                  Precio
                </th>
                <th scope="col" className={ui.numerica}>
                  Importe
                </th>
              </tr>
            </thead>
            <tbody>
              {vista.renglones.map((r) => (
                <tr key={`${r.unidadFuncionalId}|${r.conceptoBoletaId}`}>
                  <th scope="row">{r.unidad}</th>
                  <td>{r.concepto}</td>
                  <td>
                    <span className={estilos.apilado}>
                      {r.usos.map((u) => (
                        <span key={u.fila}>{usoConFecha(u, r.unidadUso)}</span>
                      ))}
                    </span>
                  </td>
                  <td>{cantidadDelRenglon(r, r.unidadUso)}</td>
                  <td className={ui.numerica}>
                    <span className="dinero">{pesos(r.precioUnitario)}</span>
                  </td>
                  <td className={ui.numerica}>
                    <span className="dinero">{pesos(r.importe)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5}>
                  Total de la planilla
                  {conErrores ? " (sin las filas con error)" : ""}
                </th>
                <td className={ui.numerica}>
                  <span className="dinero">{pesos(vista.total)}</span>
                </td>
              </tr>
            </tfoot>
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
        <Formulario accion={enviar} etiqueta="Aplicar la planilla de usos">
          {confirmacion && resultado.estado === "confirmar" ? (
            // Los valores del intento anterior (el mes, el archivo y las filas) los reemite el pedido.
            <PedidoDeConfirmacion
              onVolver={volverACorregir}
              error={resultado.error}
              confirmacion={confirmacion}
              valores={resultado.valores}
              pendiente={pendiente}
            />
          ) : (
            <>
              <input type="hidden" name="periodoId" value={periodoId} />
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
                <BotonEnviar pendiente={pendiente} cargando="Aplicando…">
                  Aplicar la planilla
                </BotonEnviar>
              </Acciones>
            </>
          )}
        </Formulario>
      )}
    </div>
  );
}
