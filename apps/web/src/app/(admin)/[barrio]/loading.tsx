import estilos from "./cargando.module.css";

/**
 * El estado de **carga** de las pantallas del barrio.
 *
 * Esqueletos con la forma del contenido y no un spinner (doc 06 §e.4): reservan el alto, así que
 * cuando llegan los datos no hay salto de layout. La animación respeta `prefers-reduced-motion` desde
 * `globals.css`.
 *
 * `aria-busy` + `aria-live="polite"` para que un lector de pantalla anuncie que está cargando en vez
 * de leer una pantalla de cajas vacías.
 */
export default function Cargando() {
  return (
    <div className={estilos.marco} aria-busy="true" aria-live="polite">
      <span className={estilos.aviso}>Cargando…</span>
      <div className={`${estilos.bloque} ${estilos.titulo}`} />
      <div className={estilos.rejilla}>
        <div className={`${estilos.bloque} ${estilos.tarjeta}`} />
        <div className={`${estilos.bloque} ${estilos.tarjeta}`} />
        <div className={`${estilos.bloque} ${estilos.tarjeta}`} />
      </div>
      <div className={`${estilos.bloque} ${estilos.panel}`} />
    </div>
  );
}
