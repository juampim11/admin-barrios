"use client";

/**
 * Las islas de «Configuración del barrio › Mora y estudios» (encargo E-a; maqueta de mora, pantalla 5):
 * qué estudios trabajan en el barrio (y cuál viene elegido al derivar), y el criterio, el pacto de
 * ejecutividad y el aviso de la boleta.
 *
 * Sin regla de negocio: que el primer estudio quede por defecto, que haya uno solo por defecto, que el
 * aviso no amenace con medidas no decididas — lo deciden `moraBarrioSchema`, el servicio y la base.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { Chip, TarjetaConAccion } from "@admin-barrios/ui";
import { cambiarEstudioDelBarrioAction, guardarMoraBarrioAction } from "../../../../../acciones/mora.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  AvisoDeFalloCompacto,
  Avisos,
  BotonEnviar,
  Campos,
  CampoMonto,
  CampoOpciones,
  CampoParrafo,
  CampoSeleccion,
  CampoTexto,
  Casilla,
  Formulario,
  useFormulario,
  type Opcion,
} from "../../../../../componentes/formulario.tsx";
import { Panel } from "../../../../../componentes/ui.tsx";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Un estudio en el barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un estudio de la administración, con la casilla de si trabaja en este barrio. Marcar o desmarcar
 * **guarda en el momento** (un formulario por estudio): no hay un «Guardar» que olvidar. El renglón
 * dice cuántas unidades tiene derivadas acá.
 */
export function EstudioEnElBarrio({
  barrioId,
  estudio,
}: {
  readonly barrioId: string;
  readonly estudio: { readonly id: string; readonly nombre: string; readonly enElBarrio: boolean; readonly porDefecto: boolean; readonly derivadas: number };
}) {
  const marca = useFormulario(cambiarEstudioDelBarrioAction);
  const defecto = useFormulario(cambiarEstudioDelBarrioAction);
  const idAccion = useId();
  const derivadas = `· ${estudio.derivadas === 1 ? "1 derivada" : `${estudio.derivadas} derivadas`} acá`;

  const sueltos = [...(marca.campos[""] ?? []), ...Object.values(marca.campos).flat(), ...Object.values(defecto.campos).flat()]
    .filter((m): m is string => typeof m === "string")
    .filter((m, i, todos) => todos.indexOf(m) === i);

  const hacerPorDefecto =
    estudio.enElBarrio && !estudio.porDefecto ? (
      <Formulario accion={defecto.enviar} etiqueta={`Hacer por defecto ${estudio.nombre}`}>
        <input type="hidden" name="barrioId" value={barrioId} />
        <input type="hidden" name="estudioId" value={estudio.id} />
        <input type="hidden" name="accion" value="por_defecto" />
        <BotonEnviar tono="sutil" pendiente={defecto.pendiente} cargando="Guardando…">
          Hacer por defecto
        </BotonEnviar>
      </Formulario>
    ) : null;

  return (
    <TarjetaConAccion accion={hacerPorDefecto}>
      <Formulario accion={marca.enviar} etiqueta={`${estudio.nombre} en este barrio`}>
        <input type="hidden" name="barrioId" value={barrioId} />
        <input type="hidden" name="estudioId" value={estudio.id} />
        <input id={idAccion} type="hidden" name="accion" value={estudio.enElBarrio ? "sacar" : "sumar"} />
        {/* `key`: cuando la base responde, la casilla vuelve a nacer con lo que dice la base. */}
        <Casilla
          key={String(estudio.enElBarrio)}
          nombre="trabajaAca"
          valor="si"
          marcadaInicial={estudio.enElBarrio}
          deshabilitada={marca.pendiente}
          alCambiar={() => (document.getElementById(idAccion) as HTMLInputElement | null)?.form?.requestSubmit()}
        >
          {estudio.nombre} {estudio.porDefecto ? <Chip tono="marca">Por defecto</Chip> : null} {derivadas}
          {marca.pendiente ? " · guardando…" : ""}
        </Casilla>
        {marca.resultado.estado === "falla" ? <AvisoDeFalloCompacto error={marca.resultado.error} /> : null}
      </Formulario>
      {defecto.resultado.estado === "falla" ? <AvisoDeFalloCompacto error={defecto.resultado.error} /> : null}
      {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
    </TarjetaConAccion>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Criterio, pacto y aviso
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FormularioDeMoraDelBarrio({
  barrioId,
  criterioAdministracion,
  criterioPropio,
  pacto,
  pactos,
  leyendaAdministracion,
  leyendaPropia,
  figura,
}: {
  readonly barrioId: string;
  /** «más de 3 meses y desde $ 300.000,00», ya escrito en el servidor. */
  readonly criterioAdministracion: string;
  readonly criterioPropio: { readonly meses: number; readonly montoMinimo: string } | null;
  readonly pacto: string;
  /** `TEXTO_PACTO`, armado en el servidor. */
  readonly pactos: readonly Opcion[];
  readonly leyendaAdministracion: string;
  readonly leyendaPropia: string | null;
  /** La figura del barrio, ya en palabras, con la aclaración de que no se cambia acá. */
  readonly figura: ReactNode;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarMoraBarrioAction);
  const criterioInicial = criterioPropio ? "propio" : "administracion";
  const avisoInicial = leyendaPropia !== null ? "propio" : "administracion";
  // Copias para mirar (qué campos mostrar); el valor que viaja es el de los radios.
  const [criterio, setCriterio] = useState(criterioInicial);
  const [aviso, setAviso] = useState(avisoInicial);
  // Al responder la acción, los radios se remontan con lo que volvió: las copias, también.
  useEffect(() => {
    if (resultado.estado === "inicial") return;
    setCriterio(previos["criterio"] ?? criterioInicial);
    setAviso(previos["aviso"] ?? avisoInicial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultado]);
  const sueltos = campos[""] ?? [];

  return (
    <Formulario accion={enviar} etiqueta="Mora del barrio">
      <input type="hidden" name="barrioId" value={barrioId} />

      <Panel titulo="Criterio para proponer">
        <Campos>
          <CampoOpciones
            nombre="criterio"
            etiqueta="Qué criterio usa el barrio"
            requerido
            enFila
            ancho
            valorInicial={previos["criterio"] ?? criterioInicial}
            alCambiar={setCriterio}
            errores={campos["criterio"]}
            opciones={[
              { valor: "administracion", titulo: "Usar el de la administración", detalle: criterioAdministracion },
              { valor: "propio", titulo: "Propio", detalle: "Meses y monto para este barrio, por ejemplo si el reglamento fija un plazo." },
            ]}
          />
          {criterio === "propio" ? (
            <>
              <CampoTexto
                nombre="meses"
                etiqueta="Meses de deuda (más de)"
                requerido
                modoDeTeclado="numeric"
                maximo={3}
                valorInicial={previos["meses"] ?? (criterioPropio ? String(criterioPropio.meses) : undefined)}
                errores={campos["meses"]}
              />
              <CampoMonto
                nombre="montoMinimo"
                etiqueta="Monto mínimo"
                requerido
                valorInicial={previos["montoMinimo"] ?? criterioPropio?.montoMinimo}
                errores={campos["montoMinimo"]}
              />
            </>
          ) : null}
        </Campos>
      </Panel>

      <Panel titulo="Figura del barrio">
        {figura}
        <Campos>
          <CampoSeleccion
            nombre="pactoEjecutividad"
            etiqueta="¿Hay pacto de ejecutividad (en el reglamento, estatuto o escritura)?"
            requerido
            sinSeleccion="Elegí"
            opciones={pactos}
            valorInicial={previos["pactoEjecutividad"] ?? pacto}
            errores={campos["pactoEjecutividad"]}
            ayuda="Es uno de los datos que se tienen en cuenta para ver si la deuda se puede reclamar por vía ejecutiva. No alcanza por sí solo: también pesan si el barrio se adecuó, si el reglamento está inscripto y si tiene espacios comunes propios. Lo define el abogado."
          />
        </Campos>
      </Panel>

      <Panel titulo="Aviso en la boleta">
        <Campos>
          <CampoOpciones
            nombre="aviso"
            etiqueta="Qué dice la boleta de una unidad derivada"
            requerido
            ancho
            valorInicial={previos["aviso"] ?? avisoInicial}
            alCambiar={setAviso}
            errores={campos["aviso"]}
            opciones={[
              { valor: "administracion", titulo: "Usar el texto base de la administración", detalle: leyendaAdministracion },
              { valor: "propio", titulo: "Texto propio" },
            ]}
          />
          {aviso === "propio" ? (
            <CampoParrafo
              nombre="leyendaBoleta"
              etiqueta="Texto propio del aviso"
              requerido
              maximo={600}
              filas={4}
              valorInicial={previos["leyendaBoleta"] ?? leyendaPropia ?? leyendaAdministracion}
              errores={campos["leyendaBoleta"]}
              ayuda="Escribí {estudio} y {telefono} tal cual (sin tilde): se reemplazan por los del estudio. No puede amenazar con medidas no decididas (embargo, corte de servicios, prohibir el ingreso)."
              ancho
            />
          ) : null}
        </Campos>
      </Panel>

      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
      <Avisos>
        {resultado.estado === "ok" ? <AvisoDeExito titulo="Listo: la mora del barrio quedó guardada." /> : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
      </Avisos>
    </Formulario>
  );
}
