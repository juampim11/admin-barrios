import { Nota, Pagina } from "../../../componentes/ui.tsx";

/** Mientras se calcula la vista previa de cada barrio que está preparando (unos segundos por barrio). */
export default function Cargando() {
  return (
    <Pagina>
      <Nota tono="info" titulo="Calculando cómo viene el mes en cada barrio…">
        Para saber si un barrio está listo para emitir se calcula su vista previa con lo cargado hasta ahora. Tarda unos
        segundos.
      </Nota>
    </Pagina>
  );
}
