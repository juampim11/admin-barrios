"use client";

/**
 * Importar la planilla del padrón (T3, pantalla 4 de la maqueta aprobada `alta-barrio-padron.html`):
 * elegir el archivo, ver la vista previa fila por fila, decidir las filas «a revisar» y confirmar.
 *
 * Es la isla de `importar/page.tsx`. **Ninguna regla vive acá**: qué es un alta, qué se corrige, qué
 * es un error y qué queda «a revisar» lo decide el servicio (`planDePadron` + la base). La pantalla
 * muestra el plan que devuelve el servidor y le manda las decisiones de la persona.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN `fetch` Y NO UNA SERVER ACTION
 *
 * El archivo puede pesar hasta 5 MB y el tope de una acción es 1 MB: sube por el route handler
 * `app/api/padron/planilla/route.ts`, que controla la sesión y el rol antes de leer el cuerpo. La
 * función que lo llama tiene la misma forma que una acción —`(previo, form) → ResultadoDeAccion`—,
 * así que el formulario sigue pasando por `useFormulario` (foco en el error, estados, avisos) igual
 * que el resto del sistema.
 *
 * **Entre la vista previa y la confirmación no se guarda nada en el servidor.** La isla conserva el
 * `File` elegido y lo vuelve a mandar al confirmar, con las decisiones acumuladas. Cada decisión
 * («Es la misma persona» / «No es») vuelve a pedir la vista previa: el plan que se ve es siempre el
 * que el servidor calculó con esas decisiones, nunca uno corregido a mano en el navegador.
 */

import { startTransition, useId, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { CODIGOS_ERROR, type ErrorParaMostrar } from "@admin-barrios/shared/errores";
import type { DecisionPersona } from "@admin-barrios/shared/padron";
import { AccionDesplegable, Boton, Chip, CifraDeLaFila, FilaDeCifras, Segmentado, type Tono } from "@admin-barrios/ui";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import type { ResultadoDeAccion } from "../../../../../acciones/resultado.ts";
import {
  Acciones,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivoDelFormulario,
  Campos,
  Formulario,
  useFormulario,
} from "../../../../../componentes/formulario.tsx";
import { IconoAlerta, IconoCorrecto, IconoInfo } from "../../../../../componentes/iconos.tsx";
import {
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../../componentes/ui.tsx";
import estilos from "./importar.module.css";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que devuelve el route handler, validado en el borde
// ────────────────────────────────────────────────────────────────────────────────────────────────

/*
 * Solo lo que la pantalla usa. El `parse` de Zod **descarta el resto** —los titulares leídos de cada
 * unidad, con sus documentos y mails—: no se retiene en la memoria del navegador lo que no se muestra.
 */
const entero = z.number().int().min(0);
const aRevisarSchema = z.object({
  fila: entero,
  documento: z.string(),
  registrado: z.string(),
  unidadesDelRegistrado: z.array(z.string()),
  enPlanilla: z.string(),
  decision: z.enum(["misma", "otra"]).nullable(),
});
const unidadSchema = z.object({
  fila: entero,
  filas: z.array(entero),
  etiqueta: z.string().nullable(),
  accion: z.enum(["alta", "corrige", "sin_cambios"]).nullable(),
  error: z.string().nullable(),
  detalle: z.array(z.string()),
  aRevisar: z.array(aRevisarSchema),
});
const vistaSchema = z.object({
  archivo: z.string(),
  unidades: z.array(unidadSchema),
  ok: z.boolean(),
  altas: entero,
  correcciones: entero,
  sinCambios: entero,
  aRevisar: entero,
  conError: entero,
  filas: entero,
  codigosPrevistos: z.record(z.string(), z.string()),
});
const hechoSchema = z.object({ altas: entero, correcciones: entero, sinCambios: entero });
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

type Vista = z.infer<typeof vistaSchema>;
type UnidadDeLaVista = Vista["unidades"][number];
type Hecho = z.infer<typeof hechoSchema>;
type Respuesta = { readonly modo: "previa"; readonly vista: Vista } | { readonly modo: "confirmar"; readonly hecho: Hecho };

const falla = (codigo: ErrorParaMostrar["codigo"], mensaje: string, sugerencia: string): ResultadoDeAccion<Respuesta> => ({
  estado: "falla",
  error: { ok: false, codigo, mensaje, sugerencia, correlacion: "", datos: {} },
  valores: {},
});
const enElArchivo = (mensaje: string): ResultadoDeAccion<Respuesta> => ({ estado: "campos", campos: { archivo: [mensaje] }, valores: {} });

const textoDeDecisiones = (d: ReadonlyMap<number, DecisionPersona>): string =>
  [...d.entries()].map(([fila, decision]) => `${fila}:${decision}`).join(",");

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La isla
// ────────────────────────────────────────────────────────────────────────────────────────────────

type Filtro = "todas" | "mirar" | "altas" | "corrige";
type EnVuelo = "elegir" | "decidir" | "confirmar";

export function ImportadorDePadron({
  barrioId,
  rutaPadron,
  rutaPlantilla,
  maximoDeFilas,
}: {
  readonly barrioId: string;
  readonly rutaPadron: string;
  readonly rutaPlantilla: string;
  /** «5.000», ya formateado por el servidor. */
  readonly maximoDeFilas: string;
}) {
  const [vista, setVista] = useState<Vista | null>(null);
  const [hecho, setHecho] = useState<{ readonly archivo: string; readonly valor: Hecho } | null>(null);
  const [decisiones, setDecisiones] = useState<ReadonlyMap<number, DecisionPersona>>(new Map());
  const [filtro, setFiltro] = useState<Filtro | null>(null);
  const [enVuelo, setEnVuelo] = useState<EnVuelo | null>(null);
  // Cambia con cada archivo nuevo: remonta los controles de decisión y de filtro (son no controlados).
  const [generacion, setGeneracion] = useState(0);
  // El archivo vigente y las decisiones, leídos desde la función de envío (que corre fuera del render).
  const archivoRef = useRef<File | null>(null);
  const decisionesRef = useRef<ReadonlyMap<number, DecisionPersona>>(new Map());

  async function pedir(_previo: ResultadoDeAccion<Respuesta>, form: FormData): Promise<ResultadoDeAccion<Respuesta>> {
    const modo = form.get("modo") === "confirmar" ? "confirmar" : "previa";
    const elegido = form.get("archivo");
    const nuevo = elegido instanceof File && elegido.size > 0 ? elegido : null;
    const eligiendo = form.get("origen") === "elegir";
    setEnVuelo(eligiendo ? "elegir" : modo === "confirmar" ? "confirmar" : "decidir");

    if (eligiendo && !nuevo) return enElArchivo("Elegí el archivo de la planilla (Excel o CSV).");
    const archivo = nuevo ?? archivoRef.current;
    if (!archivo) return enElArchivo("Elegí el archivo de la planilla (Excel o CSV).");
    // Un archivo nuevo arranca sin decisiones: las filas «a revisar» son de ese archivo.
    const lasDecisiones = nuevo ? new Map<number, DecisionPersona>() : decisionesRef.current;

    const consulta = new URLSearchParams({ barrio: barrioId, modo, nombre: archivo.name });
    if (lasDecisiones.size > 0) consulta.set("decisiones", textoDeDecisiones(lasDecisiones));

    let respuesta: Response;
    try {
      respuesta = await fetch(`/api/padron/planilla?${consulta.toString()}`, {
        method: "POST",
        body: archivo,
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch {
      return falla("desconocido", "No se pudo mandar la planilla.", "Revisá tu conexión y probá de nuevo.");
    }
    if (respuesta.status === 401) {
      return falla("sin_permiso", "La sesión se cerró.", "Volvé a entrar y subí la planilla de nuevo.");
    }
    if (respuesta.status === 403) {
      return falla("sin_permiso", "No tenés permiso para importar el padrón de este barrio.", "Pedíselo a quien administra el barrio.");
    }

    let cuerpo: z.infer<typeof respuestaSchema>;
    try {
      cuerpo = respuestaSchema.parse(await respuesta.json());
    } catch {
      return falla("desconocido", "La respuesta del servidor no se pudo leer.", "Probá de nuevo en un momento.");
    }
    if (cuerpo.estado === "campos") return { estado: "campos", campos: cuerpo.campos, valores: {} };
    if (cuerpo.estado === "falla") return { estado: "falla", error: { ok: false, datos: {}, ...cuerpo.error }, valores: {} };

    if (modo === "previa") {
      const leida = vistaSchema.safeParse(cuerpo.valor);
      if (!leida.success) return falla("desconocido", "La vista previa no se pudo leer.", "Probá de nuevo en un momento.");
      if (nuevo) {
        archivoRef.current = nuevo;
        decisionesRef.current = lasDecisiones;
        setDecisiones(lasDecisiones);
        setFiltro(null);
        setGeneracion((g) => g + 1);
      }
      setVista(leida.data);
      setHecho(null);
      return { estado: "ok", valor: { modo: "previa", vista: leida.data } };
    }
    const leido = hechoSchema.safeParse(cuerpo.valor);
    if (!leido.success) return falla("desconocido", "La confirmación no se pudo leer.", "Mirá el padrón antes de volver a importar.");
    setHecho({ archivo: archivo.name, valor: leido.data });
    setVista(null);
    archivoRef.current = null;
    decisionesRef.current = new Map();
    setDecisiones(new Map());
    return { estado: "ok", valor: { modo: "confirmar", hecho: leido.data } };
  }

  const { enviar, pendiente, resultado, campos } = useFormulario<Respuesta>(pedir);
  const fallo = resultado.estado === "falla" ? resultado.error : null;

  /** Una decisión sobre una fila «a revisar»: se acumula y se vuelve a pedir la vista previa. */
  function decidir(fila: number, decision: DecisionPersona) {
    const nuevas = new Map(decisionesRef.current);
    nuevas.set(fila, decision);
    decisionesRef.current = nuevas;
    setDecisiones(nuevas);
    const form = new FormData();
    form.set("modo", "previa");
    startTransition(() => enviar(form));
  }

  function empezarDeNuevo() {
    setHecho(null);
    setVista(null);
  }

  // ── Importada ────────────────────────────────────────────────────────────────────────────────
  if (hecho) {
    const { altas, correcciones, sinCambios } = hecho.valor;
    return (
      <>
        <EncabezadoDePagina titulo="Planilla importada" bajada={`«${hecho.archivo}» quedó en el padrón.`} />
        <AvisoDeExito titulo="Listo: el padrón se actualizó con la planilla.">
          <p>
            {altas} {altas === 1 ? "unidad nueva" : "unidades nuevas"}, {correcciones}{" "}
            {correcciones === 1 ? "corregida" : "corregidas"} y {sinCambios} sin cambios. Cada cambio quedó en el historial de su
            unidad, con el nombre del archivo.
          </p>
        </AvisoDeExito>
        <div className={estilos.barra}>
          <BotonDeAccion variante="secundario" onClick={empezarDeNuevo}>
            Importar otra planilla
          </BotonDeAccion>
          <Boton variante="primario" href={rutaPadron}>
            Ir al padrón
          </Boton>
        </div>
      </>
    );
  }

  const elegir = (
    <ElegirArchivo
      enviar={enviar}
      pendiente={pendiente && enVuelo === "elegir"}
      errores={campos["archivo"]}
      fallo={enVuelo === "elegir" ? fallo : null}
      rutaPlantilla={rutaPlantilla}
      maximoDeFilas={maximoDeFilas}
    />
  );

  // ── Sin vista previa todavía ─────────────────────────────────────────────────────────────────
  if (!vista) {
    return (
      <>
        <EncabezadoDePagina
          titulo="Importar planilla del padrón"
          bajada="Una unidad nueva se agrega; una que ya existe se corrige. Antes de guardar vas a ver una vista previa fila por fila."
        />
        <Panel titulo="Elegí la planilla">{elegir}</Panel>
      </>
    );
  }

  // ── La vista previa ──────────────────────────────────────────────────────────────────────────
  return (
    <VistaPrevia
      key={generacion}
      vista={vista}
      decisiones={decisiones}
      filtro={filtro}
      alFiltrar={setFiltro}
      alDecidir={decidir}
      enviar={enviar}
      actualizando={pendiente && enVuelo === "decidir"}
      confirmando={pendiente && enVuelo === "confirmar"}
      fallo={enVuelo === "elegir" ? null : fallo}
      subirOtra={elegir}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Elegir el archivo (el «diálogo» de la maqueta, sin modal)
// ────────────────────────────────────────────────────────────────────────────────────────────────

function ElegirArchivo({
  enviar,
  pendiente,
  errores,
  fallo,
  rutaPlantilla,
  maximoDeFilas,
}: {
  readonly enviar: (form: FormData) => void;
  readonly pendiente: boolean;
  readonly errores: readonly string[] | undefined;
  readonly fallo: ErrorParaMostrar | null;
  readonly rutaPlantilla: string;
  readonly maximoDeFilas: string;
}) {
  return (
    <Formulario accion={enviar} etiqueta="Importar planilla del padrón">
      <input type="hidden" name="modo" value="previa" />
      <input type="hidden" name="origen" value="elegir" />
      <Campos>
        <CampoArchivoDelFormulario
          nombre="archivo"
          etiqueta="Archivo"
          requerido
          ancho
          aceptar=".xlsx,.csv"
          errores={errores}
          ayuda={
            <>
              Excel o CSV, hasta {maximoDeFilas} filas. <a href={rutaPlantilla}>Bajar la plantilla</a> con las columnas y una fila de
              ejemplo.
            </>
          }
        />
      </Campos>
      <Avisos>{fallo ? <AvisoDeFallo error={fallo} /> : null}</Avisos>
      <Acciones ayuda="No se guarda nada hasta que confirmes la importación.">
        <BotonEnviar pendiente={pendiente} cargando="Leyendo la planilla…">
          Ver la vista previa
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La vista previa
// ────────────────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Una fila «para mirar»: con error, o con alguna persona a revisar (decidida o no, para poder cambiarla). */
const esParaMirar = (u: UnidadDeLaVista, decisiones: ReadonlyMap<number, DecisionPersona>) =>
  u.error !== null || u.aRevisar.length > 0 || u.filas.some((f) => decisiones.get(f) === "otra");

function pasaElFiltro(u: UnidadDeLaVista, filtro: Filtro, decisiones: ReadonlyMap<number, DecisionPersona>): boolean {
  switch (filtro) {
    case "todas":
      return true;
    case "mirar":
      return esParaMirar(u, decisiones);
    case "altas":
      return u.error === null && u.accion === "alta";
    case "corrige":
      return u.error === null && u.accion === "corrige";
  }
}

function VistaPrevia({
  vista,
  decisiones,
  filtro,
  alFiltrar,
  alDecidir,
  enviar,
  actualizando,
  confirmando,
  fallo,
  subirOtra,
}: {
  readonly vista: Vista;
  readonly decisiones: ReadonlyMap<number, DecisionPersona>;
  readonly filtro: Filtro | null;
  readonly alFiltrar: (f: Filtro) => void;
  readonly alDecidir: (fila: number, decision: DecisionPersona) => void;
  readonly enviar: (form: FormData) => void;
  readonly actualizando: boolean;
  readonly confirmando: boolean;
  readonly fallo: ErrorParaMostrar | null;
  readonly subirOtra: ReactNode;
}) {
  const idFiltro = useId();
  const paraMirar = vista.unidades.filter((u) => esParaMirar(u, decisiones)).length;
  const altas = vista.unidades.filter((u) => pasaElFiltro(u, "altas", decisiones)).length;
  const corrige = vista.unidades.filter((u) => pasaElFiltro(u, "corrige", decisiones)).length;
  const filtroVigente: Filtro = filtro ?? (paraMirar > 0 ? "mirar" : "todas");
  const visibles = vista.unidades.filter((u) => pasaElFiltro(u, filtroVigente, decisiones));

  const problemas = [
    ...(vista.conError > 0 ? [plural(vista.conError, "fila con error", "filas con error")] : []),
    ...(vista.aRevisar > 0 ? [`${vista.aRevisar} a revisar`] : []),
  ];
  const nadaQueHacer = vista.ok && vista.altas + vista.correcciones === 0;
  const motivo = !vista.ok
    ? `Hay ${problemas.join(" y ")}: hasta resolverlo no se puede confirmar.`
    : nadaQueHacer
      ? "La planilla no cambia nada del padrón."
      : "Se guarda todo junto: si algo falla, no se guarda nada.";

  return (
    <>
      <EncabezadoDePagina
        titulo="Vista previa de la planilla"
        bajada={`${vista.archivo} · ${plural(vista.filas, "fila", "filas")}. No se guardó nada todavía: con un error en cualquier fila no se importa nada.`}
      />

      <div className={estilos.barra}>
        <AccionDesplegable texto="Subir otra versión" variante="secundario">
          {subirOtra}
        </AccionDesplegable>
        <Formulario accion={enviar} etiqueta="Confirmar la importación">
          <input type="hidden" name="modo" value="confirmar" />
          <Acciones ayuda={motivo}>
            <BotonEnviar pendiente={confirmando} deshabilitado={!vista.ok || nadaQueHacer || actualizando} cargando="Importando…">
              Confirmar importación
            </BotonEnviar>
          </Acciones>
        </Formulario>
      </div>

      <Avisos>{fallo ? <AvisoDeFallo error={fallo} /> : null}</Avisos>

      <FilaDeCifras>
        <CifraDeLaFila etiqueta="Altas" origen="unidades que no están en el padrón">
          {vista.altas}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="Corrige una existente" origen={`y ${vista.sinCambios} sin cambios`}>
          {vista.correcciones}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="A revisar" origen="documento ya registrado con otro nombre">
          {vista.aRevisar}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="Con error" origen="no se importa nada hasta corregirlas">
          {vista.conError}
        </CifraDeLaFila>
      </FilaDeCifras>

      {!vista.ok ? (
        <Nota tono="alerta" titulo={`${problemas.join(" y ")}.`}>
          {vista.conError > 0 && vista.aRevisar > 0
            ? "Corregí la planilla y subila de nuevo, o decidí las filas «a revisar» acá. Hasta entonces no se puede confirmar."
            : vista.conError > 0
              ? "Corregí la planilla y subila de nuevo. Hasta entonces no se puede confirmar."
              : "Decidí acá si es la misma persona. Hasta entonces no se puede confirmar."}
        </Nota>
      ) : nadaQueHacer ? (
        <Nota tono="info" titulo="La planilla no cambia nada.">
          Todas las unidades ya están en el padrón con estos mismos datos.
        </Nota>
      ) : (
        <Nota tono="exito" titulo="Todo en orden.">
          {plural(vista.altas, "alta", "altas")} y {plural(vista.correcciones, "corrección", "correcciones")}. Al confirmar se guardan todas
          juntas.
        </Nota>
      )}

      <div
        className={estilos.filtros}
        onChange={(e) => {
          const objetivo = e.target as HTMLInputElement;
          if (objetivo.name === "filtro") alFiltrar(objetivo.value as Filtro);
        }}
      >
        <Segmentado
          id={idFiltro}
          nombre="filtro"
          etiqueta="Mostrar"
          valorInicial={filtroVigente}
          opciones={[
            { valor: "todas", texto: `Todas (${vista.unidades.length})` },
            { valor: "mirar", texto: `Para mirar (${paraMirar})` },
            { valor: "altas", texto: `Altas (${altas})` },
            { valor: "corrige", texto: `Corrige (${corrige})` },
          ]}
        />
        <p className={estilos.actualizando} aria-live="polite">
          {actualizando ? "Actualizando la vista previa con tu decisión…" : ""}
        </p>
      </div>

      {visibles.length === 0 ? (
        <Vacio titulo="No hay filas con este filtro.">Elegí «Todas» para ver la planilla completa.</Vacio>
      ) : (
        <MarcoTabla etiqueta="Vista previa de la planilla, fila por fila">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.numerica}>
                  Fila
                </th>
                <th scope="col">Unidad</th>
                <th scope="col">Acción</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((u) => (
                <FilaDeLaVista
                  key={u.fila}
                  unidad={u}
                  codigo={vista.codigosPrevistos[String(u.fila)] ?? null}
                  decisiones={decisiones}
                  alDecidir={alDecidir}
                />
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      )}
    </>
  );
}

const ACCION: Record<"error" | "revisar" | "alta" | "corrige" | "sin_cambios", { texto: string; tono: Tono; icono: ReactNode }> = {
  error: { texto: "Con error", tono: "peligro", icono: <IconoAlerta /> },
  revisar: { texto: "A revisar", tono: "alerta", icono: <IconoAlerta /> },
  alta: { texto: "Alta", tono: "exito", icono: <IconoCorrecto /> },
  corrige: { texto: "Corrige", tono: "neutro", icono: <IconoInfo /> },
  sin_cambios: { texto: "Sin cambios", tono: "neutro", icono: <IconoInfo /> },
};

function FilaDeLaVista({
  unidad: u,
  codigo,
  decisiones,
  alDecidir,
}: {
  readonly unidad: UnidadDeLaVista;
  readonly codigo: string | null;
  readonly decisiones: ReadonlyMap<number, DecisionPersona>;
  readonly alDecidir: (fila: number, decision: DecisionPersona) => void;
}) {
  const pendiente = u.aRevisar.some((r) => r.decision === null);
  const clave = u.error !== null ? "error" : pendiente ? "revisar" : (u.accion ?? "sin_cambios");
  const accion = ACCION[clave];
  // Las filas que se decidieron «No es»: el servicio las devuelve como error, y acá se puede deshacer.
  const decididasOtra = u.error !== null ? u.filas.filter((f) => decisiones.get(f) === "otra") : [];

  return (
    <tr>
      <td className={ui.numerica}>{u.filas.join(", ")}</td>
      <th scope="row">{u.etiqueta ?? <span className={ui.secundaria}>—</span>}</th>
      <td>
        <Chip tono={accion.tono} icono={accion.icono}>
          {accion.texto}
        </Chip>
      </td>
      <td>
        <div className={estilos.detalle}>
          {u.error !== null ? (
            <p>{u.error}</p>
          ) : (
            <p>
              {u.detalle.join(" ")}
              {u.accion === "alta" && codigo ? (
                <>
                  {" "}
                  Código de pago <span className={ui.mono}>{codigo}</span>.
                </>
              ) : null}
            </p>
          )}
          {u.aRevisar.map((r) => (
            <div key={r.fila} className={estilos.revisar}>
              <p>
                {r.documento.startsWith("DNI") ? `El ${r.documento}` : `El CUIT ${r.documento}`} ya es de <strong>{r.registrado}</strong>
                {r.unidadesDelRegistrado.length > 0 ? ` (${r.unidadesDelRegistrado.join(", ")})` : ""}; en la planilla (fila {r.fila}) dice{" "}
                <strong>{r.enPlanilla}</strong>.
              </p>
              <Decision fila={r.fila} valor={r.decision} alDecidir={alDecidir} />
            </div>
          ))}
          {decididasOtra.map((f) => (
            <div key={f} className={estilos.revisar}>
              <p className={ui.secundaria}>En la fila {f} se decidió que no es la misma persona. Si fue un error, cambialo acá.</p>
              <Decision fila={f} valor="otra" alDecidir={alDecidir} />
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

function Decision({
  fila,
  valor,
  alDecidir,
}: {
  readonly fila: number;
  readonly valor: DecisionPersona | null;
  readonly alDecidir: (fila: number, decision: DecisionPersona) => void;
}) {
  const id = useId();
  return (
    <div
      onChange={(e) => {
        const objetivo = e.target as HTMLInputElement;
        if (objetivo.value === "misma" || objetivo.value === "otra") alDecidir(fila, objetivo.value);
      }}
    >
      <Segmentado
        // El valor que devolvió el servidor manda: si cambia, el control se remonta con él.
        key={valor ?? "sin-decidir"}
        id={id}
        nombre={`decision-${fila}`}
        etiqueta={`Fila ${fila}: ¿es la misma persona?`}
        valorInicial={valor ?? undefined}
        opciones={[
          { valor: "misma", texto: "Es la misma persona" },
          { valor: "otra", texto: "No es" },
        ]}
      />
    </div>
  );
}
