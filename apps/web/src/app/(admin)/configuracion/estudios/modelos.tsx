"use client";

/**
 * Las islas del modelo de cláusulas del convenio de un plan de pagos (encargo P2a-3), en Configuración
 * general › Estudios jurídicos: crearlo con el borrador y editarlo.
 *
 * Sin regla de negocio: la forma de cada cláusula, las variables que existen, que el estudio trabaje
 * con la administración y quién puede editar lo deciden el esquema de
 * `@admin-barrios/shared/planes-documentos`, el servicio y la base.
 *
 * **Las cláusulas viajan como campos sueltos `titulo.N` y `texto.N`**, no como un estado de React
 * serializado: así son campos no controlados como el resto de los formularios, y si la acción rechaza,
 * `previos` los devuelve con lo que se había escrito (el `form.reset()` de React 19 no los pierde). La
 * acción los junta en orden de `N` (`armarClausulasDelFormulario`).
 */

import { useRef, useState } from "react";
import { AvisoEnLinea, Boton } from "@admin-barrios/ui";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { LEYENDA_TEXTO_A_VALIDAR, MAXIMO_CLAUSULAS, MAXIMO_TEXTO_CLAUSULA, MAXIMO_TITULO_CLAUSULA, VARIABLES_DE_CLAUSULA, type Clausula } from "@admin-barrios/shared/planes-documentos";
import { crearModeloDeClausulasAction, guardarModeloDeClausulasAction } from "../../../../acciones/planes-documentos.ts";
import {
  Acciones,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoOpciones,
  CampoParrafo,
  Campos,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../../../../componentes/formulario.tsx";

/** «Crear el modelo»: con el borrador de tres cláusulas, sin validar. */
export function CrearModelo({
  administracionId,
  estudioId,
  nombre,
}: {
  readonly administracionId: string;
  /** `null`: el general de la administración. */
  readonly estudioId: string | null;
  readonly nombre: string;
}) {
  const { enviar, pendiente, resultado } = useFormulario(crearModeloDeClausulasAction);
  return (
    <Formulario accion={enviar} etiqueta={`Crear el modelo de ${nombre}`}>
      <input type="hidden" name="administracionId" value={administracionId} />
      <input type="hidden" name="estudioId" value={estudioId ?? ""} />
      <Acciones>
        <BotonEnviar tono="secundario" pendiente={pendiente} cargando="Creando…">
          Crear con el borrador
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

/** «Editar» un modelo: sus cláusulas (agregar, quitar, cambiar el texto) y si ya está validado. */
export function EditarModelo({
  modelo,
  nombre,
  general,
}: {
  readonly modelo: { readonly id: string; readonly clausulas: readonly Clausula[]; readonly textoValidado: boolean };
  readonly nombre: string;
  /** El general de la administración: no es de un estudio, y la pregunta de la validación cambia. */
  readonly general: boolean;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarModeloDeClausulasAction);
  // Las filas: una clave por cláusula, creciente. El texto vive en los campos, no acá.
  const siguiente = useRef(modelo.clausulas.length);
  const [filas, setFilas] = useState<readonly { clave: number; inicial: Clausula }[]>(() =>
    modelo.clausulas.map((c, i) => ({ clave: i, inicial: c })),
  );
  const agregar = () => setFilas((f) => [...f, { clave: siguiente.current++, inicial: { titulo: "", texto: "" } }]);
  const quitar = (clave: number) => setFilas((f) => f.filter((x) => x.clave !== clave));

  return (
    <DialogoDeConfirmacion
      disparador="Editar"
      etiquetaDisparador={`Editar el modelo de ${nombre}`}
      titulo={`Modelo de cláusulas · ${nombre}`}
      accion={enviar}
      textoConfirmar="Guardar"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
      ancho="ancho"
    >
      <input type="hidden" name="modeloId" value={modelo.id} />
      <p>
        Las cláusulas del convenio que se imprime con «El acuerdo con el modelo de cláusulas». Las cifras van con variables entre llaves:
        el PDF las completa con las del plan. Por ejemplo, «La deuda es de {"{deuda}"}» sale impresa «La deuda es de $ 1.234.567,89».
      </p>
      <ul>
        {Object.entries(VARIABLES_DE_CLAUSULA).map(([variable, que]) => (
          <li key={variable}>
            <code>{`{${variable}}`}</code>: {que}
          </li>
        ))}
      </ul>
      {campos["clausulas"] ? <AvisoEnLinea tono="alerta">{campos["clausulas"].join(" ")}</AvisoEnLinea> : null}
      {filas.map((f, i) => (
        <Campos key={f.clave}>
          <CampoTexto
            nombre={`titulo.${f.clave}`}
            etiqueta={`Cláusula ${i + 1} · título`}
            requerido
            maximo={MAXIMO_TITULO_CLAUSULA}
            valorInicial={previos[`titulo.${f.clave}`] ?? f.inicial.titulo}
            ancho
          />
          <CampoParrafo
            nombre={`texto.${f.clave}`}
            etiqueta={`Cláusula ${i + 1} · texto`}
            requerido
            maximo={MAXIMO_TEXTO_CLAUSULA}
            filas={4}
            valorInicial={previos[`texto.${f.clave}`] ?? f.inicial.texto}
            ancho
          />
          {filas.length > 1 ? (
            <Boton tipo="button" variante="sutil" tamano="sm" alTocar={() => quitar(f.clave)} etiqueta={`Quitar la cláusula ${i + 1}`}>
              Quitar esta cláusula
            </Boton>
          ) : null}
        </Campos>
      ))}
      {filas.length < MAXIMO_CLAUSULAS ? (
        <p>
          <Boton tipo="button" variante="secundario" tamano="sm" alTocar={agregar}>
            Agregar una cláusula
          </Boton>
        </p>
      ) : null}
      <Campos>
        <CampoOpciones
          nombre="textoValidado"
          etiqueta={general ? "¿Un abogado ya validó el texto?" : "¿El estudio ya validó el texto?"}
          ancho
          valorInicial={previos["textoValidado"] ?? (modelo.textoValidado ? "si" : "no")}
          errores={campos["textoValidado"]}
          opciones={[
            { valor: "no", titulo: "Todavía no", detalle: `El PDF y esta pantalla dicen «${LEYENDA_TEXTO_A_VALIDAR}».` },
            { valor: "si", titulo: "Sí, está validado", detalle: "El PDF sale sin la leyenda." },
          ]}
        />
      </Campos>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}
