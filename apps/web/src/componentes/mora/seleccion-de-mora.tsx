"use client";

/**
 * La isla de la lista de mora: **qué unidades están elegidas** para derivar, la barra de abajo y el
 * diálogo de derivar en lote (encargo E-a, maqueta de mora, pantallas 1 y 2).
 *
 * La lista en sí es de servidor —filtros por link, tabla, cifras— y cuesta cero JavaScript; esto es lo
 * único que viaja al navegador, porque lo elegido es estado de quien mira y no de la URL. La lógica es
 * pura y vive aparte, con sus tests: `seleccion.ts` (portado de Aclade: la elección pertenece al filtro)
 * y `derivar.ts` (el agrupado por barrio y qué falta para derivar).
 *
 * La estructura es la de Aclade (`aclade-cobranzas/src/components/derivar-estudio.tsx`: un contexto
 * con la selección, la casilla de cada fila, la barra y el diálogo), adaptada: acá no hay «modo
 * selección» que encender (las casillas están siempre, como en la maqueta), no hay vista previa
 * pedida al servidor al abrir (lo que el diálogo muestra ya vino con la lista, y la base vuelve a
 * verificar todo al derivar) y el diálogo agrupa por barrio con un estudio por grupo.
 *
 * No hay regla de negocio acá: qué unidad se puede elegir lo dice la página (sin derivar, con meses
 * vencidos, en un barrio donde quien mira puede derivar), qué estudio puede recibirla lo exige la base,
 * y el motivo y la nota los valida `derivarSchema` en la acción.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AvisoEnLinea,
  BarraDeSeleccion,
  BloquesDeExplicacion,
  CasillaDeFila,
  GrupoDelDialogo,
  TextoAdaptable,
} from "@admin-barrios/ui";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import type { ResultadoDerivacion } from "@admin-barrios/data/servicios/mora";
import { derivarAction } from "../../acciones/mora.ts";
import {
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  Avisos,
  CampoParrafo,
  CampoSeleccion,
  useFormulario,
  type Opcion,
} from "../formulario.tsx";
import {
  agruparPorBarrio,
  barrios as cuantosBarrios,
  estudioDe,
  estudios as cuantosEstudios,
  meses as cuantosMeses,
  motivoParaNoDerivar,
  porEstudio,
  sinIntimacion,
  textoDeLosCorreos,
  unidades as cuantasUnidades,
  type BarrioParaDerivar,
  type ElegibleMora,
} from "./derivar.ts";
import {
  agregarUnidades,
  alternarUnidad,
  aMandar,
  elegidasVigentes,
  quitarUnidades,
  sinElegir,
  type EstadoSeleccion,
} from "./seleccion.ts";

/** Un barrio para el diálogo, con a dónde ir a sumarle un estudio si no tiene. */
export type BarrioDeLaIsla = BarrioParaDerivar & { readonly hrefEstudios: string };

type FormularioDeDerivar = ReturnType<typeof useFormulario<ResultadoDerivacion>>;

type Seleccion = {
  readonly elegidas: ReadonlySet<string>;
  readonly elegibles: readonly ElegibleMora[];
  readonly barrios: readonly BarrioDeLaIsla[];
  readonly motivos: readonly Opcion[];
  readonly conBarrio: boolean;
  readonly alternar: (unidadId: string) => void;
  readonly elegirTodas: () => void;
  readonly quitar: () => void;
  readonly sacar: (unidadIds: readonly string[]) => void;
  readonly resultado: string | null;
  /**
   * El formulario de derivar vive **acá**, en el proveedor, que no se desmonta: si se derivan todas las
   * elegibles del filtro, la barra (y el diálogo adentro) desaparecen, y el «Listo:» se perdía con ellos.
   */
  readonly formulario: FormularioDeDerivar;
};

const Ctx = createContext<Seleccion | null>(null);

/** El «Listo:» con lo que devolvió la base, no con lo que la pantalla creía estar mandando. */
function textoDelListo(r: ResultadoDerivacion): string {
  const cuantas = `${cuantasUnidades(r.unidades)} ${r.unidades === 1 ? "derivada" : "derivadas"}`;
  const aQuien = r.porEstudio.map((e) => `${e.estudio}: ${cuantasUnidades(e.unidades)}`).join(" · ");
  return `Listo: ${cuantas}${aQuien ? ` (${aQuien})` : ""}. Quedó guardada la foto del estado de cuenta de cada una a hoy.`;
}

/**
 * La elección. Vive en la página y es **del filtro con el que se hizo**: al cambiar `clave` (barrio,
 * estudio o chip) se vacía. `elegibles` son las unidades del filtro actual que se pueden derivar —todas,
 * no solo las que se ven—, así «Elegir todas las del filtro» toma todas.
 */
export function SeleccionDeMora({
  clave,
  elegibles,
  barrios,
  motivos,
  conBarrio,
  children,
}: {
  readonly clave: string;
  readonly elegibles: readonly ElegibleMora[];
  readonly barrios: readonly BarrioDeLaIsla[];
  /** Los motivos de derivación (`TEXTO_MOTIVO_DERIVACION`), ya armados en el servidor. */
  readonly motivos: readonly Opcion[];
  /** En «todos los barrios»: la cuenta dice de cuántos barrios son las elegidas. */
  readonly conBarrio: boolean;
  readonly children: ReactNode;
}) {
  const [estado, setEstado] = useState<EstadoSeleccion>(() => sinElegir(clave));
  const [resultado, setResultado] = useState<string | null>(null);
  const formulario = useFormulario(derivarAction);
  const ids = useMemo(() => elegibles.map((e) => e.id), [elegibles]);
  const elegidas = useMemo(() => elegidasVigentes(estado, clave, ids), [estado, clave, ids]);

  // Cambiar de filtro vacía la elección también en el estado: volver al filtro anterior no la trae.
  useEffect(() => {
    setEstado((e) => (e.clave === clave ? e : sinElegir(clave)));
    setResultado(null);
  }, [clave]);

  // Salió bien: el «Listo:» va arriba de la lista y la elección se vacía. Una vez por resultado.
  const claveRef = useRef(clave);
  claveRef.current = clave;
  useEffect(() => {
    if (formulario.resultado.estado !== "ok") return;
    setResultado(textoDelListo(formulario.resultado.valor));
    setEstado(sinElegir(claveRef.current));
  }, [formulario.resultado]);

  const valor = useMemo<Seleccion>(
    () => ({
      elegidas,
      elegibles,
      barrios,
      motivos,
      conBarrio,
      alternar: (unidadId) => setEstado((e) => alternarUnidad(e, clave, unidadId)),
      elegirTodas: () => setEstado((e) => agregarUnidades(e, clave, ids)),
      quitar: () => setEstado(sinElegir(clave)),
      sacar: (unidadIds) => setEstado((e) => quitarUnidades(e, clave, unidadIds)),
      resultado,
      formulario,
    }),
    [elegidas, elegibles, barrios, motivos, conBarrio, clave, ids, resultado, formulario],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

function useSeleccion(): Seleccion {
  const c = useContext(Ctx);
  if (!c) throw new Error("La casilla y la barra de derivar van adentro de <SeleccionDeMora>.");
  return c;
}

/** La casilla de una fila que se puede derivar. */
export function CasillaDeMora({ unidadId, unidad }: { readonly unidadId: string; readonly unidad: string }) {
  const s = useSeleccion();
  return (
    <CasillaDeFila
      etiqueta={`Elegir ${unidad} para derivar`}
      marcada={s.elegidas.has(unidadId)}
      alCambiar={() => s.alternar(unidadId)}
    />
  );
}

/** El «Listo:» de la última derivación, arriba de la lista. Se va al cambiar de filtro. */
export function ResultadoDeLaDerivacion() {
  const s = useSeleccion();
  if (!s.resultado) return null;
  return (
    <div role="status">
      <AvisoEnLinea tono="exito">{s.resultado}</AvisoEnLinea>
    </div>
  );
}

/** La barra de abajo: cuántas hay elegidas, elegir todas, quitar y «Derivar N unidades». */
export function BarraDeDerivar() {
  const s = useSeleccion();
  if (s.elegibles.length === 0) return null;
  const n = s.elegidas.size;
  const deBarrios = new Set(s.elegibles.filter((e) => s.elegidas.has(e.id)).map((e) => e.barrioId)).size;
  const faltan = s.elegibles.length - n;

  const cuenta =
    n === 0
      ? "Elegí las unidades para derivar a un estudio"
      : `${cuantasUnidades(n)} ${n === 1 ? "elegida" : "elegidas"}${s.conBarrio ? ` · de ${cuantosBarrios(deBarrios)}` : ""}`;

  return (
    <BarraDeSeleccion etiqueta="Derivar a un estudio jurídico" cuenta={cuenta}>
      <BotonDeAccion variante="sutil" tamano="sm" onClick={s.elegirTodas} deshabilitado={faltan === 0}>
        <TextoAdaptable corto={`Todas (${s.elegibles.length})`} largo={`Elegir todas las del filtro (${s.elegibles.length})`} />
      </BotonDeAccion>
      {n > 0 ? (
        <BotonDeAccion variante="sutil" tamano="sm" onClick={s.quitar}>
          <TextoAdaptable corto="Quitar" largo="Quitar la selección" />
        </BotonDeAccion>
      ) : null}
      <DialogoDeDerivar />
    </BarraDeSeleccion>
  );
}

function DialogoDeDerivar() {
  const s = useSeleccion();
  const { enviar, pendiente, resultado, campos, previos } = s.formulario;
  /** El estudio que eligió la persona en cada barrio (copia para mirar; el valor viaja en el `<select>`). */
  const [elegidos, setElegidos] = useState<Readonly<Record<string, string>>>({});

  const mostradas = s.elegibles.filter((e) => s.elegidas.has(e.id));
  const grupos = agruparPorBarrio(mostradas, s.barrios);
  const aDerivar = aMandar(
    grupos.flatMap((g) => g.unidades.map((u) => u.id)),
    s.elegidas,
  );
  const n = aDerivar.length;
  const bloqueo = motivoParaNoDerivar(grupos, elegidos);
  const resumen = porEstudio(grupos, elegidos);
  const faltaIntimacion = sinIntimacion(grupos);
  const sueltos = [...(campos[""] ?? []), ...(campos["unidades"] ?? [])];

  return (
    <DialogoDeConfirmacion
      disparador={n === 0 ? "Derivar" : `Derivar ${cuantasUnidades(n)}`}
      varianteDisparador="primario"
      tamanoDisparador="base"
      disparadorDeshabilitado={n === 0}
      titulo={`Derivar ${cuantasUnidades(n)}`}
      accion={enviar}
      textoConfirmar={`Derivar ${cuantasUnidades(n)}`}
      textoPendiente="Derivando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
      ancho="ancho"
      confirmarDeshabilitado={bloqueo !== null}
      motivoDeshabilitado={bloqueo ? `Todavía no se puede derivar: ${bloqueo}` : null}
    >
      <p>
        Cada unidad va al estudio de su barrio. Podés cambiarlo, pero solo por otro estudio que trabaje en ese mismo
        barrio.
      </p>

      {aDerivar.map((id) => {
        const u = mostradas.find((x) => x.id === id);
        return u ? <input key={id} type="hidden" name="unidad" value={`${u.id}|${u.barrioId}`} /> : null;
      })}

      {grupos.map((g) => (
        <GrupoDelDialogo
          key={g.barrio.id}
          titulo={`${g.barrio.nombre} · ${cuantasUnidades(g.unidades.length)}`}
          detalle={
            g.barrio.estudios.length === 0
              ? "Ningún estudio trabaja acá"
              : g.barrio.estudios.length === 1
                ? "1 estudio"
                : `${cuantosEstudios(g.barrio.estudios.length)} trabajan acá`
          }
          items={g.unidades.map((u) => ({ clave: u.id, texto: `${u.unidad} · ${cuantosMeses(u.meses)}` }))}
        >
          {g.barrio.estudios.length === 0 ? (
            <>
              {/* El único aviso rojo del grupo; el bloqueo general va como texto junto al botón. */}
              <AvisoEnLinea tono="peligro">
                Ningún estudio trabaja en {g.barrio.nombre} todavía. Sumá uno en{" "}
                <a href={g.barrio.hrefEstudios} target="_blank" rel="noopener">
                  Configuración del barrio › Mora y estudios (se abre en otra pestaña)
                </a>
                , o sacá estas unidades de la elección.
              </AvisoEnLinea>
              <BotonDeAccion variante="secundario" tamano="sm" onClick={() => s.sacar(g.unidades.map((u) => u.id))}>
                Sacar estas unidades
              </BotonDeAccion>
            </>
          ) : (
            <CampoSeleccion
              nombre={`estudio-${g.barrio.id}`}
              etiqueta="Estudio"
              requerido
              sinSeleccion="Elegí el estudio"
              valorInicial={estudioDe(g.barrio, elegidos) ?? ""}
              opciones={g.barrio.estudios.map((e) => ({
                valor: e.id,
                texto: e.porDefecto ? `${e.nombre} (por defecto)` : e.nombre,
              }))}
              alCambiar={(v) => setElegidos((x) => ({ ...x, [g.barrio.id]: v }))}
            />
          )}
        </GrupoDelDialogo>
      ))}

      {/* `previos`: un rechazo (por ejemplo «Otro» sin nota) vuelve con lo tipeado, no lo borra. */}
      <CampoSeleccion
        nombre="motivo"
        etiqueta="Motivo"
        requerido
        sinSeleccion="Elegí el motivo"
        valorInicial={previos["motivo"] ?? "criterio_cumplido"}
        opciones={s.motivos}
        errores={campos["motivo"]}
      />
      <CampoParrafo
        nombre="nota"
        etiqueta="Nota para el estudio"
        ayuda="Con «Otro», contá acá el motivo. La nota vale para todas las unidades de esta tanda."
        maximo={500}
        valorInicial={previos["nota"]}
        errores={campos["nota"]}
      />

      <BloquesDeExplicacion
        bloques={[
          {
            titulo: "Qué ve el estudio",
            children: (
              <p>
                Solo estas unidades: titular y contacto, deuda mes por mes con interés al día y las gestiones. Nada más del
                barrio.
              </p>
            ),
          },
          {
            titulo: "Qué sigue igual",
            children: (
              <p>
                El mes se sigue liquidando y la boleta sale. Si el vecino paga, el pago se recibe <strong>a cuenta</strong> y
                se imputa según la normativa aplicable y el reglamento o estatuto del barrio.
              </p>
            ),
          },
        ]}
      />

      {faltaIntimacion > 0 ? (
        <AvisoEnLinea tono="alerta">
          Ojo: {faltaIntimacion === 1 ? "1 de las elegidas no tiene" : `${faltaIntimacion} de las elegidas no tienen`} una
          intimación registrada, y el criterio de su barrio pide una antes de derivar. Podés derivar igual.
        </AvisoEnLinea>
      ) : null}

      {resumen.length > 0 ? (
        <AvisoEnLinea tono="info">
          {textoDeLosCorreos(resumen)} Al derivar se guarda una foto del estado de cuenta de cada unidad a hoy.
        </AvisoEnLinea>
      ) : null}

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
      </Avisos>
    </DialogoDeConfirmacion>
  );
}
