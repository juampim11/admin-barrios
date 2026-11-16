/**
 * «Activar el barrio» (encargo 17, pantalla 1 de la maqueta): el bloque que va arriba del tablero
 * mientras el barrio está sin activar. Cuatro pasos —padrón, conceptos, deuda anterior y activar—,
 * cada uno con su estado y por dónde se sigue.
 *
 * Componente de servidor: no decide nada. Qué está hecho, cuánto hay cargado y quién puede lo resolvió
 * `estadoDeLaActivacion`; los textos son de `textos.ts`. Lo único interactivo es la confirmación de
 * «El barrio no trae deuda», que entra como isla.
 */

import type { EstadoDeLaActivacion } from "@admin-barrios/data/servicios/activacion";
import { Boton, Chip } from "@admin-barrios/ui";
import { IconoCorrecto, IconoFaltante } from "../../../../../componentes/iconos.tsx";
import { Panel } from "../../../../../componentes/ui.tsx";
import { conListo, rutaDeConceptosDelBarrio, rutaDelPadron, rutasDeActivacion } from "../../../../../rutas.ts";
import { BotonSinDeudaAnterior } from "./sin-deuda.tsx";
import { pasosDeLaActivacion, sePuedeVerificar, type PasoDeActivacion } from "./textos.ts";
import estilos from "./activacion.module.css";

export function ActivarElBarrio({ barrioId, estado }: { readonly barrioId: string; readonly estado: EstadoDeLaActivacion }) {
  const rutas = rutasDeActivacion(barrioId);
  const pasos = pasosDeLaActivacion(estado);
  const listoParaVerificar = sePuedeVerificar(estado);

  const acciones = (paso: PasoDeActivacion) => {
    switch (paso.clave) {
      case "padron":
        return (
          <Boton href={rutaDelPadron(barrioId)} tamano="sm">
            Ir al padrón
          </Boton>
        );
      case "conceptos":
        return (
          <Boton href={rutaDeConceptosDelBarrio(barrioId)} tamano="sm">
            Ir a Conceptos del barrio
          </Boton>
        );
      case "deuda":
        // Ausente, no apagado, para quien no administra el barrio (doc 06 §c.6.4).
        return estado.puedeActivar ? (
          <>
            <Boton href={rutas.deuda} variante={estado.deudaAnterior === null ? "primario" : "secundario"}>
              {estado.deudaAnterior === "cargada" ? "Subir otra planilla de deuda" : "Subir la planilla de deuda"}
            </Boton>
            <Boton href={rutas.plantilla} variante="sutil">
              Bajar la plantilla
            </Boton>
            {estado.deudaAnterior === "sin_deuda" ? null : (
              <BotonSinDeudaAnterior
                barrioId={barrioId}
                hayPlanillaCargada={estado.deudaAnterior === "cargada"}
                volverA={conListo(rutas.tablero, "sin_deuda_anterior")}
              />
            )}
          </>
        ) : null;
      case "activar":
        return listoParaVerificar ? (
          <Boton href={rutas.verificar} variante="primario">
            Verificar antes de activar
          </Boton>
        ) : null;
    }
  };

  return (
    <Panel
      titulo="Activar el barrio"
      origen="Un barrio sin activar no emite. Para activarlo se trae lo que venía de antes: el padrón, los conceptos y lo que cada unidad debe, mes por mes."
      acciones={<Chip tono="alerta">Sin activar</Chip>}
    >
      <ol className={estilos.pasos}>
        {pasos.map((paso, i) => {
          const botones = acciones(paso);
          // El último paso no está «pendiente» hasta que los otros estén: es lo que sigue, no una falta.
          const estadoDelPaso = paso.hecho ? "Hecho" : paso.clave === "activar" && !listoParaVerificar ? "Después" : "Pendiente";
          return (
            <li key={paso.clave} className={`${estilos.paso} ${paso.hecho ? estilos.pasoHecho : estilos.pasoPendiente}`}>
              <span className={estilos.pasoIcono} aria-hidden>
                {paso.hecho ? <IconoCorrecto /> : <IconoFaltante />}
              </span>
              <div className={estilos.pasoCuerpo}>
                <span className={estilos.pasoEstado}>{estadoDelPaso}</span>
                <h3 className={estilos.pasoTitulo}>
                  {i + 1}. {paso.titulo}
                </h3>
                {paso.detalle.map((linea) => (
                  <p key={linea} className={estilos.pasoDetalle}>
                    {linea}
                  </p>
                ))}
                {botones ? <div className={estilos.acciones}>{botones}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {estado.puedeActivar ? null : (
        <p className={estilos.discreta}>La deuda anterior la carga y el barrio lo activa la administración del barrio.</p>
      )}
    </Panel>
  );
}
