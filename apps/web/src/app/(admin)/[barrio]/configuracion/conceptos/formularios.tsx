"use client";

/**
 * Los formularios de «Conceptos del barrio» (encargo 16b; pantalla 2 de la maqueta): el alta de un
 * concepto con su primer valor, la edición, el valor nuevo con su «rige desde», y los grupos de
 * unidades.
 *
 * Solo se dibujan para quien puede cambiarlos (lo decide la página con lo que dice el servicio); la
 * autorización real la hacen el servicio y la base.
 *
 * **Ninguna regla vive acá.** Qué combinaciones valen lo dice `revisarComoEntraElConcepto`
 * (`@admin-barrios/shared/conceptos`), que es la misma función que usan el esquema y el servicio: la
 * isla la **consulta** para no ofrecer lo que después se rechazaría («sola» solo si va a todas o a un
 * grupo y el importe es fijo o un porcentaje; «por planilla» solo en lo que se cobra por uso) y para
 * decir por qué no lo ofrece. Si igual llega algo que no va, el esquema lo marca en su campo.
 *
 * Los campos son no controlados, como todo el kit: los `useState` de acá son copias para mirar, que
 * deciden **qué campos se dibujan**. Por eso el cuerpo se remonta cuando se guardó bien: nace de nuevo
 * con lo que quedó.
 */

import { useEffect, useState } from "react";
import {
  DESTINATARIOS_CONCEPTO,
  METODOS_CONCEPTO_BOLETA,
  MODOS_DEL_MES,
  revisarComoEntraElConcepto,
  TEXTO_DESTINATARIO,
  TEXTO_METODO,
  TEXTO_MODO_DEL_MES,
  UNIDADES_DE_USO,
  type DestinatarioConcepto,
  type MetodoConceptoBoleta,
  type ModoDelMes,
} from "@admin-barrios/shared/conceptos";
import { Boton } from "@admin-barrios/ui";
import { BotonCancelar } from "@admin-barrios/ui/cliente/boton-de-accion";
import {
  borrarGrupoDeUnidadesAction,
  crearConceptoBoletaAction,
  crearGrupoDeUnidadesAction,
  editarConceptoBoletaAction,
  editarGrupoDeUnidadesAction,
  registrarValorConceptoAction,
} from "../../../../../acciones/conceptos.ts";
import type { ErroresPorCampo, ResultadoDeAccion, ValoresDeFormulario } from "../../../../../acciones/resultado.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoMonto,
  CampoOpciones,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Casilla,
  Formulario,
  useFormulario,
  useVolverAlGuardar,
} from "../../../../../componentes/formulario.tsx";
import { Nota, ui } from "../../../../../componentes/ui.tsx";
import { cuantasUnidades, porcentajeLegible } from "./textos.ts";
import estilos from "./conceptos.module.css";

type Clase = "cargo" | "descuento";

export type GrupoParaElegir = { readonly id: string; readonly nombre: string; readonly unidades: number };
export type UnidadParaElegir = { readonly id: string; readonly etiqueta: string };

/**
 * Un rechazo del servicio que dice a qué campo se refiere (`datos.campo`) se muestra también en ese
 * campo, además del aviso de abajo.
 */
function erroresPorCampo(campos: ErroresPorCampo, resultado: ResultadoDeAccion<unknown>) {
  return (campo: string): readonly string[] | undefined =>
    campos[campo] ?? (resultado.estado === "falla" && resultado.error.datos["campo"] === campo ? [resultado.error.mensaje] : undefined);
}

/** Cuenta los guardados que salieron bien: sirve de `key` para que el cuerpo nazca de nuevo. */
function useGuardados(resultado: ResultadoDeAccion<unknown>): number {
  const [guardados, setGuardados] = useState(0);
  useEffect(() => {
    if (resultado.estado === "ok") setGuardados((n) => n + 1);
  }, [resultado]);
  return guardados;
}

/** Los métodos que van con cada clase: por uso y a cargar cada vez son de un cargo; el porcentaje, de un descuento. */
const metodosDe = (clase: Clase): readonly MetodoConceptoBoleta[] =>
  METODOS_CONCEPTO_BOLETA.filter((m) => (clase === "cargo" ? m !== "porcentaje" : m === "monto_fijo" || m === "porcentaje"));

// ────────────────────────────────────────────────────────────────────────────────────────────────
// A quién va y cómo entra cada mes (lo comparten el alta y la edición)
// ────────────────────────────────────────────────────────────────────────────────────────────────

function ComoEntra({
  clase,
  metodo,
  grupos,
  inicial,
  previos,
  erroresDe,
}: {
  readonly clase: Clase;
  /** `""` mientras todavía no se eligió cómo se calcula (en el alta). */
  readonly metodo: MetodoConceptoBoleta | "";
  readonly grupos: readonly GrupoParaElegir[];
  readonly inicial: {
    readonly destinatario: DestinatarioConcepto;
    readonly grupoId: string | null;
    readonly modoMes: ModoDelMes;
    readonly unidadUso: string | null;
  };
  readonly previos: ValoresDeFormulario;
  readonly erroresDe: (campo: string) => readonly string[] | undefined;
}) {
  const [destinatario, setDestinatario] = useState<DestinatarioConcepto>(
    (previos["destinatario"] as DestinatarioConcepto | undefined) ?? inicial.destinatario,
  );
  const [modo, setModo] = useState<ModoDelMes>((previos["modoMes"] as ModoDelMes | undefined) ?? inicial.modoMes);

  /*
   * Qué formas de entrar al mes van con lo elegido. La pregunta se le hace a la misma función que usa
   * el esquema; acá solo se mira si objeta el campo «cada mes». El grupo concreto no cambia la
   * respuesta, así que se pregunta como si ya estuviera elegido.
   */
  const objeciones = (m: ModoDelMes): readonly string[] =>
    metodo === ""
      ? []
      : revisarComoEntraElConcepto({
          clase,
          metodo,
          destinatario,
          grupoId: destinatario === "grupo" ? "elegido" : null,
          modoMes: m,
          unidadUso: null,
        })
          .filter((p) => p.campo === "modoMes")
          .map((p) => p.mensaje);
  const disponibles = MODOS_DEL_MES.filter((m) => objeciones(m).length === 0);
  const noSeOfrecen = MODOS_DEL_MES.filter((m) => objeciones(m).length > 0);
  // «A mano» va siempre: es a lo que se vuelve si lo elegido dejó de corresponder.
  const modoVigente: ModoDelMes = disponibles.includes(modo) ? modo : "mano";

  return (
    <>
      <Campos>
        <CampoSeleccion
          nombre="destinatario"
          etiqueta="A quién va"
          requerido
          sinSeleccion="Elegí a quién va…"
          opciones={DESTINATARIOS_CONCEPTO.map((d) => ({ valor: d, texto: TEXTO_DESTINATARIO[d] }))}
          valorInicial={previos["destinatario"] ?? inicial.destinatario}
          errores={erroresDe("destinatario")}
          alCambiar={(v) => setDestinatario((v || "una_unidad") as DestinatarioConcepto)}
        />
        {destinatario === "grupo" ? (
          <CampoSeleccion
            nombre="grupoId"
            etiqueta="Grupo de unidades"
            requerido
            sinSeleccion={grupos.length === 0 ? "Todavía no hay grupos" : "Elegí el grupo…"}
            opciones={grupos.map((g) => ({ valor: g.id, texto: `${g.nombre} (${cuantasUnidades(g.unidades)})` }))}
            valorInicial={previos["grupoId"] ?? inicial.grupoId ?? undefined}
            errores={erroresDe("grupoId")}
            ayuda={
              grupos.length === 0
                ? "Primero armá el grupo, más abajo en esta pantalla, en «Grupos de unidades»."
                : "Las unidades del grupo se toman al calcular cada mes: si el grupo cambia, cambia a quién va."
            }
          />
        ) : null}
        {metodo === "precio_x_cantidad" ? (
          <CampoSeleccion
            nombre="unidadUso"
            etiqueta="Se cobra por"
            sinSeleccion="Uso (sin especificar)"
            opciones={UNIDADES_DE_USO.map((u) => ({ valor: u, texto: u === "turno" ? "Turno" : "Jornada" }))}
            valorInicial={previos["unidadUso"] ?? inicial.unidadUso ?? undefined}
            errores={erroresDe("unidadUso")}
            ayuda="Es la palabra que sale en la boleta: «2 turnos», «1 jornada»."
          />
        ) : null}
      </Campos>

      {/* `key`: cuando cambia lo que se ofrece, el grupo nace de nuevo con una opción que sí va. */}
      <CampoOpciones
        key={`${disponibles.join("|")}`}
        nombre="modoMes"
        etiqueta="Cada mes"
        requerido
        enFila
        opciones={disponibles.map((m) => ({ valor: m, titulo: TEXTO_MODO_DEL_MES[m].corto, detalle: TEXTO_MODO_DEL_MES[m].detalle }))}
        valorInicial={modoVigente}
        errores={erroresDe("modoMes")}
        alCambiar={(v) => setModo(v as ModoDelMes)}
      />
      {noSeOfrecen.length > 0 ? (
        <p className={ui.secundaria} aria-live="polite">
          {noSeOfrecen.map((m) => (
            <span key={m} className={estilos.renglon}>
              «{TEXTO_MODO_DEL_MES[m].corto}» no se ofrece con lo elegido. {objeciones(m).join(" ")}
            </span>
          ))}
        </p>
      ) : null}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El valor (lo comparten el alta y «Cambiar el valor»)
// ────────────────────────────────────────────────────────────────────────────────────────────────

function CamposDelValor({
  metodo,
  denominacion,
  inicial,
  previos,
  erroresDe,
}: {
  readonly metodo: MetodoConceptoBoleta | "";
  readonly denominacion: string;
  /** Lo que rige hoy, para partir de ahí al cambiar el valor. En el alta no hay. */
  readonly inicial?: { readonly montoFijo: string | null; readonly porcentaje: string | null; readonly precioUnitario: string | null; readonly tope: string | null } | undefined;
  readonly previos: ValoresDeFormulario;
  readonly erroresDe: (campo: string) => readonly string[] | undefined;
}) {
  if (metodo === "monto_fijo") {
    return (
      <CampoMonto
        nombre="montoFijo"
        etiqueta="Importe por unidad"
        requerido
        errores={erroresDe("montoFijo")}
        valorInicial={previos["montoFijo"] ?? inicial?.montoFijo ?? undefined}
        ayuda="Lo que suma o resta en el cupón de cada unidad a la que va."
      />
    );
  }
  if (metodo === "precio_x_cantidad") {
    return (
      <CampoMonto
        nombre="precioUnitario"
        etiqueta="Precio por uso"
        requerido
        errores={erroresDe("precioUnitario")}
        valorInicial={previos["precioUnitario"] ?? inicial?.precioUnitario ?? undefined}
        ayuda="Se multiplica por los usos de cada unidad en el mes. La cuenta la hace el sistema."
      />
    );
  }
  if (metodo === "porcentaje") {
    return (
      <>
        <CampoTexto
          nombre="porcentaje"
          etiqueta="Porcentaje (%)"
          requerido
          maximo={12}
          modoDeTeclado="decimal"
          errores={erroresDe("porcentaje")}
          valorInicial={previos["porcentaje"] ?? (inicial?.porcentaje ? porcentajeLegible(inicial.porcentaje) : undefined)}
          ayuda={`Sobre la ${denominacion} de cada unidad, por ejemplo 7,5.`}
        />
        <CampoMonto
          nombre="tope"
          etiqueta="Tope por unidad"
          requerido
          errores={erroresDe("tope")}
          valorInicial={previos["tope"] ?? inicial?.tope ?? undefined}
          ayuda="Lo máximo que se le descuenta a una unidad en un mes. Un porcentaje siempre lleva un máximo en pesos."
        />
      </>
    );
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Nuevo concepto
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CLASIFICACIONES_FISCALES = [
  { valor: "sin_clasificar", texto: "Sin clasificar" },
  { valor: "alcanzado", texto: "Alcanzado" },
  { valor: "no_alcanzado", texto: "No alcanzado" },
  { valor: "no_gravado", texto: "No gravado" },
  { valor: "ingreso_ajeno", texto: "Ingreso de un tercero" },
] as const;

const FINANCIAMIENTOS = [
  { valor: "partida_presupuestada", texto: "De una partida del presupuesto" },
  { valor: "absorbe_barrio", texto: "Lo absorbe el barrio" },
  { valor: "fondo_reserva", texto: "Del fondo de reserva" },
] as const;

type PropiedadesDelAlta = {
  readonly barrioId: string;
  readonly grupos: readonly GrupoParaElegir[];
  /** `AAAA-MM-DD`: el primer día del mes en curso, que es lo que se propone como «rige desde». */
  readonly rigeDesde: string;
  /** Cómo llama el barrio a lo que cobra cada mes («expensa», «cuota social»). */
  readonly denominacion: string;
};

export function FormularioDeConceptoNuevo(p: PropiedadesDelAlta) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(crearConceptoBoletaAction);
  const guardados = useGuardados(resultado);

  return (
    <Formulario accion={enviar} etiqueta="Nuevo concepto del barrio">
      <input type="hidden" name="barrioId" value={p.barrioId} />
      <CuerpoDelAlta key={guardados} {...p} previos={previos} erroresDe={erroresPorCampo(campos, resultado)} />
      <Avisos>
        {resultado.estado === "ok" ? (
          <AvisoDeExito titulo="Listo: el concepto quedó en el catálogo.">
            <p>Ya aparece en la tabla de arriba, con su valor.</p>
          </AvisoDeExito>
        ) : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
        {campos["baseCalculo"] ? <AvisoDeCamposSueltos mensajes={campos["baseCalculo"]} /> : null}
      </Avisos>
      <Acciones ayuda="Qué es el concepto (si suma o resta, y cómo se calcula) no se cambia después. El valor, sí: con un «rige desde».">
        <BotonCancelar deshabilitado={pendiente} />
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Crear el concepto
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

function CuerpoDelAlta({
  grupos,
  rigeDesde,
  denominacion,
  previos,
  erroresDe,
}: PropiedadesDelAlta & {
  readonly previos: ValoresDeFormulario;
  readonly erroresDe: (campo: string) => readonly string[] | undefined;
}) {
  const [clase, setClase] = useState<Clase | "">((previos["clase"] as Clase | undefined) ?? "");
  const [metodo, setMetodo] = useState<MetodoConceptoBoleta | "">((previos["metodo"] as MetodoConceptoBoleta | undefined) ?? "");

  const metodos = clase === "" ? [] : metodosDe(clase);
  // Si se cambió de «suma» a «resta», lo elegido puede no ir más: se vuelve a elegir.
  const metodoVigente: MetodoConceptoBoleta | "" = metodo !== "" && metodos.includes(metodo) ? metodo : "";

  return (
    <>
      <Campos>
        <CampoTexto
          nombre="nombre"
          etiqueta="Nombre"
          requerido
          maximo={120}
          errores={erroresDe("nombre")}
          valorInicial={previos["nombre"]}
          ayuda="Como va a salir en la boleta."
        />
        <CampoSeleccion
          nombre="clase"
          etiqueta="Suma o resta"
          requerido
          sinSeleccion="Elegí…"
          opciones={[
            { valor: "cargo", texto: "Suma al cupón (un cargo)" },
            { valor: "descuento", texto: "Resta del cupón (un descuento)" },
          ]}
          valorInicial={previos["clase"]}
          errores={erroresDe("clase")}
          alCambiar={(v) => setClase(v as Clase | "")}
        />
        {clase === "" ? null : (
          // `key`: al cambiar entre suma y resta cambian las opciones, y el campo nace sin elegir.
          <CampoSeleccion
            key={`metodo-${clase}`}
            nombre="metodo"
            etiqueta="Cómo se calcula"
            requerido
            sinSeleccion="Elegí cómo se calcula…"
            opciones={metodos.map((m) => ({ valor: m, texto: m === "porcentaje" ? `% de la ${denominacion}` : TEXTO_METODO[m] }))}
            valorInicial={metodoVigente || undefined}
            errores={erroresDe("metodo")}
            alCambiar={(v) => setMetodo(v as MetodoConceptoBoleta | "")}
          />
        )}
        {/* Un porcentaje se calcula sobre lo que le toca pagar a la unidad; lo demás no lleva base. */}
        <input type="hidden" name="baseCalculo" value={metodoVigente === "porcentaje" ? "expensa_ordinaria" : "sin_base"} />
        <CamposDelValor key={`valor-${metodoVigente}`} metodo={metodoVigente} denominacion={denominacion} previos={previos} erroresDe={erroresDe} />
      </Campos>

      {metodoVigente === "importe_libre" ? (
        <p className={ui.secundaria}>
          Este concepto no guarda ningún valor: el importe se escribe cada vez que se aplica a una unidad (una multa, por ejemplo).
        </p>
      ) : null}

      {clase === "" || metodoVigente === "" ? null : (
        <ComoEntra
          key={`entra-${clase}-${metodoVigente}`}
          clase={clase}
          metodo={metodoVigente}
          grupos={grupos}
          inicial={{ destinatario: "una_unidad", grupoId: null, modoMes: "mano", unidadUso: null }}
          previos={previos}
          erroresDe={erroresDe}
        />
      )}

      <Campos>
        <CampoTexto
          nombre="vigenteDesde"
          tipo="date"
          etiqueta="Rige desde"
          requerido
          errores={erroresDe("vigenteDesde")}
          valorInicial={previos["vigenteDesde"] ?? rigeDesde}
          ayuda="Desde qué día vale este valor. Se propone el primer día del mes en curso: un concepto que se aplica solo necesita un valor que rija el día 1 del mes."
        />
        <CampoSeleccion
          nombre="clasificacionFiscal"
          etiqueta="Clasificación fiscal"
          requerido
          sinSeleccion="Elegí…"
          opciones={CLASIFICACIONES_FISCALES}
          valorInicial={previos["clasificacionFiscal"] ?? "sin_clasificar"}
          errores={erroresDe("clasificacionFiscal")}
          ayuda="Si no lo sabés, dejalo sin clasificar: lo define quien lleva la contabilidad del barrio."
        />
        {clase === "descuento" ? (
          <CampoSeleccion
            nombre="financiamiento"
            etiqueta="De dónde sale la plata del descuento"
            requerido
            sinSeleccion="Elegí…"
            opciones={FINANCIAMIENTOS}
            valorInicial={previos["financiamiento"]}
            errores={erroresDe("financiamiento")}
            ayuda="Lo que una unidad deja de pagar lo cubre alguien: hay que decir quién."
          />
        ) : null}
      </Campos>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Editar un concepto
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type ConceptoParaEditar = {
  readonly id: string;
  readonly nombre: string;
  readonly activo: boolean;
  readonly clase: Clase;
  readonly metodo: MetodoConceptoBoleta;
  readonly destinatario: DestinatarioConcepto;
  readonly grupoId: string | null;
  readonly modoMes: ModoDelMes;
  readonly unidadUso: string | null;
};

export function FormularioDeEdicionDeConcepto({
  concepto,
  grupos,
  volverA,
}: {
  readonly concepto: ConceptoParaEditar;
  readonly grupos: readonly GrupoParaElegir[];
  /** La pantalla sin el concepto abierto: a donde lleva «Cerrar». */
  readonly volverA: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(editarConceptoBoletaAction);
  const guardados = useGuardados(resultado);
  const erroresDe = erroresPorCampo(campos, resultado);
  // Lo que llega del servidor después de guardar es lo nuevo: el cuerpo nace de nuevo con eso.
  const firma = `${guardados}|${JSON.stringify(concepto)}`;

  return (
    <Formulario accion={enviar} etiqueta={`Editar ${concepto.nombre}`}>
      <input type="hidden" name="conceptoBoletaId" value={concepto.id} />
      <CuerpoDeLaEdicion key={firma} concepto={concepto} grupos={grupos} previos={previos} erroresDe={erroresDe} />
      <Avisos>
        {resultado.estado === "ok" ? (
          <AvisoDeExito titulo="Listo: el concepto quedó guardado.">
            <p>Lo ya aplicado no cambia. Rige para lo que se aplique desde ahora y para los meses que se calculen.</p>
          </AvisoDeExito>
        ) : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones ayuda="Lo ya aplicado en un mes no se toca: cada aplicación guarda cómo era el concepto.">
        <Boton href={volverA} variante="sutil" deshabilitado={pendiente}>
          Cerrar
        </Boton>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

function CuerpoDeLaEdicion({
  concepto,
  grupos,
  previos,
  erroresDe,
}: {
  readonly concepto: ConceptoParaEditar;
  readonly grupos: readonly GrupoParaElegir[];
  readonly previos: ValoresDeFormulario;
  readonly erroresDe: (campo: string) => readonly string[] | undefined;
}) {
  return (
    <>
      <Campos>
        <CampoTexto
          nombre="nombre"
          etiqueta="Nombre"
          requerido
          maximo={120}
          errores={erroresDe("nombre")}
          valorInicial={previos["nombre"] ?? concepto.nombre}
          ayuda="Como sale en la boleta."
        />
        <CampoSeleccion
          nombre="activo"
          etiqueta="Estado"
          requerido
          sinSeleccion="Elegí…"
          opciones={[
            { valor: "true", texto: "Activo" },
            { valor: "false", texto: "Desactivado: no se aplica más" },
          ]}
          valorInicial={previos["activo"] ?? (concepto.activo ? "true" : "false")}
          errores={erroresDe("activo")}
        />
      </Campos>
      <ComoEntra
        clase={concepto.clase}
        metodo={concepto.metodo}
        grupos={grupos}
        inicial={{ destinatario: concepto.destinatario, grupoId: concepto.grupoId, modoMes: concepto.modoMes, unidadUso: concepto.unidadUso }}
        previos={previos}
        erroresDe={erroresDe}
      />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Cambiar el valor
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FormularioDeValor({
  conceptoBoletaId,
  nombre,
  metodo,
  denominacion,
  vigente,
}: {
  readonly conceptoBoletaId: string;
  readonly nombre: string;
  readonly metodo: MetodoConceptoBoleta;
  readonly denominacion: string;
  /** El valor que rige hoy, o `null` si no hay ninguno. */
  readonly vigente: { readonly montoFijo: string | null; readonly porcentaje: string | null; readonly precioUnitario: string | null; readonly tope: string | null } | null;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(registrarValorConceptoAction);
  const guardados = useGuardados(resultado);
  const erroresDe = erroresPorCampo(campos, resultado);

  return (
    <Formulario accion={enviar} etiqueta={`Cambiar el valor de ${nombre}`}>
      <input type="hidden" name="conceptoBoletaId" value={conceptoBoletaId} />
      <Campos key={`${guardados}|${JSON.stringify(vigente)}`}>
        <CamposDelValor metodo={metodo} denominacion={denominacion} inicial={vigente ?? undefined} previos={previos} erroresDe={erroresDe} />
        <CampoTexto
          nombre="vigenteDesde"
          tipo="date"
          etiqueta="Rige desde"
          requerido
          errores={erroresDe("vigenteDesde")}
          valorInicial={previos["vigenteDesde"]}
          ayuda="Desde qué día vale el valor nuevo. El anterior deja de regir ese día; lo ya aplicado conserva el suyo."
        />
      </Campos>
      <Avisos>
        {resultado.estado === "ok" ? (
          <AvisoDeExito titulo="Listo: el valor nuevo quedó cargado.">
            <p>Rige desde la fecha elegida. Lo aplicado con fecha anterior conserva el valor que tenía.</p>
          </AvisoDeExito>
        ) : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Cambiar el valor
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Grupos de unidades
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las unidades del padrón, con casillas y un buscador.
 *
 * **Por qué esto es de cliente** (regla 8 del sistema de UI: tabla de servidor por default): junta dos
 * de las cuatro condiciones —**búsqueda instantánea** y **selección múltiple**—. En un barrio de
 * cientos de unidades, elegir treinta lotes pidiendo la página de nuevo en cada búsqueda perdería lo
 * ya marcado.
 *
 * Buscar **esconde** las casillas que no coinciden, no las saca: una unidad marcada que no se ve sigue
 * viajando con el formulario. La lista de marcadas es una copia para mirar (el contador y el
 * `defaultChecked` con que cada casilla vuelve si el formulario se resetea).
 */
function SelectorDeUnidades({
  unidades,
  iniciales,
  errores,
}: {
  readonly unidades: readonly UnidadParaElegir[];
  readonly iniciales: readonly string[];
  readonly errores: readonly string[] | undefined;
}) {
  const [elegidas, setElegidas] = useState<ReadonlySet<string>>(new Set(iniciales));
  const [busqueda, setBusqueda] = useState("");
  const buscado = busqueda.trim().toLowerCase();
  const visibles = unidades.filter((u) => buscado === "" || u.etiqueta.toLowerCase().includes(buscado));

  const marcar = (id: string, marcada: boolean) =>
    setElegidas((antes) => {
      const despues = new Set(antes);
      if (marcada) despues.add(id);
      else despues.delete(id);
      return despues;
    });

  return (
    <div className={estilos.selector}>
      {/* «Enter» en el buscador no guarda el grupo: buscar no es enviar. */}
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      >
        <Campos>
        <CampoTexto
          nombre="buscarUnidad"
          etiqueta="Buscar una unidad"
          maximo={40}
          alCambiar={setBusqueda}
          ayuda="Por manzana o lote. Lo que ya marcaste sigue marcado aunque no se vea."
          />
        </Campos>
      </div>
      <p className={ui.secundaria} aria-live="polite">
        {elegidas.size === 0 ? "Ninguna unidad elegida" : `${cuantasUnidades(elegidas.size)} ${elegidas.size === 1 ? "elegida" : "elegidas"}`}
        {buscado === "" ? "" : ` · ${visibles.length === 1 ? "1 coincide" : `${visibles.length} coinciden`} con la búsqueda`}
      </p>
      <fieldset className={estilos.casillas}>
        <legend className={estilos.leyenda}>Unidades del grupo</legend>
        {unidades.map((u) => (
          <div key={u.id} hidden={buscado !== "" && !u.etiqueta.toLowerCase().includes(buscado)}>
            <Casilla nombre="unidades" valor={u.id} marcadaInicial={elegidas.has(u.id)} alCambiar={(marcada) => marcar(u.id, marcada)}>
              {u.etiqueta}
            </Casilla>
          </div>
        ))}
      </fieldset>
      {errores ? <AvisoDeCamposSueltos mensajes={errores} /> : null}
    </div>
  );
}

function CuerpoDelGrupo({
  nombre,
  unidades,
  iniciales,
  previos,
  erroresDe,
}: {
  readonly nombre: string | undefined;
  readonly unidades: readonly UnidadParaElegir[];
  readonly iniciales: readonly string[];
  readonly previos: ValoresDeFormulario;
  readonly erroresDe: (campo: string) => readonly string[] | undefined;
}) {
  return (
    <>
      <Campos>
        <CampoTexto
          nombre="nombre"
          etiqueta="Nombre del grupo"
          requerido
          maximo={80}
          errores={erroresDe("nombre")}
          valorInicial={previos["nombre"] ?? nombre}
          ayuda="Para reconocerlo al elegir a quién va un concepto."
        />
      </Campos>
      <SelectorDeUnidades unidades={unidades} iniciales={iniciales} errores={erroresDe("unidades")} />
    </>
  );
}

export function FormularioDeGrupoNuevo({ barrioId, unidades }: { readonly barrioId: string; readonly unidades: readonly UnidadParaElegir[] }) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(crearGrupoDeUnidadesAction);
  const guardados = useGuardados(resultado);

  return (
    <Formulario accion={enviar} etiqueta="Nuevo grupo de unidades">
      <input type="hidden" name="barrioId" value={barrioId} />
      <CuerpoDelGrupo key={guardados} nombre={undefined} unidades={unidades} iniciales={[]} previos={previos} erroresDe={erroresPorCampo(campos, resultado)} />
      <Avisos>
        {resultado.estado === "ok" ? <AvisoDeExito titulo="Listo: el grupo quedó creado." /> : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonCancelar deshabilitado={pendiente} />
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Crear el grupo
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

export function FormularioDeEdicionDeGrupo({
  grupo,
  unidades,
  volverA,
}: {
  readonly grupo: { readonly id: string; readonly nombre: string; readonly unidades: readonly string[] };
  readonly unidades: readonly UnidadParaElegir[];
  readonly volverA: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(editarGrupoDeUnidadesAction);
  const guardados = useGuardados(resultado);

  return (
    <Formulario accion={enviar} etiqueta={`Editar el grupo ${grupo.nombre}`}>
      <input type="hidden" name="grupoId" value={grupo.id} />
      <CuerpoDelGrupo
        key={`${guardados}|${grupo.nombre}|${grupo.unidades.join(",")}`}
        nombre={grupo.nombre}
        unidades={unidades}
        iniciales={grupo.unidades}
        previos={previos}
        erroresDe={erroresPorCampo(campos, resultado)}
      />
      <Avisos>
        {resultado.estado === "ok" ? (
          <AvisoDeExito titulo="Listo: el grupo quedó guardado.">
            <p>Rige para los meses que se calculen desde ahora. Lo ya emitido no cambia.</p>
          </AvisoDeExito>
        ) : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones ayuda="Las unidades que desmarques salen del grupo.">
        <Boton href={volverA} variante="sutil" deshabilitado={pendiente}>
          Cerrar
        </Boton>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar el grupo
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

/** «Borrar» un grupo que ningún concepto usa. Al borrarlo, la pantalla vuelve a la lista. */
export function BorrarGrupo({ grupoId, nombre, volverA }: { readonly grupoId: string; readonly nombre: string; readonly volverA: string }) {
  const { enviar, pendiente, resultado } = useFormulario(borrarGrupoDeUnidadesAction);
  useVolverAlGuardar(resultado, () => volverA);

  return (
    <Formulario accion={enviar} etiqueta={`Borrar el grupo ${nombre}`}>
      <input type="hidden" name="grupoId" value={grupoId} />
      <Nota tono="alerta" titulo={`Borrar «${nombre}» no se deshace.`}>
        Ningún concepto lo usa, así que no cambia lo que se cobra. Si después hace falta, se arma de nuevo.
      </Nota>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
      <Acciones>
        <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Borrando…">
          Borrar el grupo
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
