import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { acentoBarrio } from "@admin-barrios/design-tokens/barrio-accent";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { Boton, Chip, CifraDeLaFila, CuerpoConBarraLateral, FilaDeCifras } from "@admin-barrios/ui";
import {
  listarBarriosAccesibles,
  type BarrioAccesible,
} from "@admin-barrios/data/servicios/barrios";
import { administracionesDondeCrear } from "@admin-barrios/data/servicios/padron-edicion";
import { listarAdministracionesVisibles } from "@admin-barrios/data/servicios/parametros";
import { mesEnMisBarrios, type MesDeUnBarrio } from "@admin-barrios/data/servicios/circuito-del-mes";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { IconoBarrio } from "../../componentes/iconos.tsx";
import { EncabezadoDePagina, Pagina, TiraDeChips, Vacio } from "../../componentes/ui.tsx";
import { etiquetaFigura, MODELO_EXPENSA_CORTO } from "../../componentes/etiquetas.tsx";
import { portadaDelBarrio, RUTA_CONFIGURACION_GENERAL, RUTA_NUEVO_BARRIO, rutaDeLiquidacion, rutaDelPadron } from "../../rutas.ts";
import { conSesion } from "../../servidor/db.ts";
import { BarraDeLaAdministracion } from "./barra-del-barrio.tsx";
import estilos from "./barrios.module.css";
import estilosAdmin from "./admin.module.css";

export const metadata: Metadata = { title: "Barrios" };

/** `1234` → `"1.234"`, con el formateador de `shared` (regla 6: nada de `Intl`). */
const entero = (n: number): string => formatearDecimal(String(n), 0);

const unidades = (n: number): string => `${entero(n)} ${n === 1 ? "unidad activa" : "unidades activas"}`;

/**
 * **Barrios** — la primera pantalla después de entrar (maqueta T3 aprobada, pantalla 1).
 *
 * **La lista no se filtra acá.** No hay un `where barrio_id in (…)`: sale de lo que la RLS deja ver.
 * Un usuario con membresía en un solo barrio ve una tarjeta y no sabe que existen las otras; el
 * administrador de estudio —el caso central del producto— ve todas las suyas (ADR-0002 §3.4).
 *
 * **«Nuevo barrio» aparece solo si hay dónde crearlo**: `administracionesDondeCrear` devuelve las
 * administraciones sobre las que el usuario tiene rol de administración. Es dato para la UI; quien
 * autoriza de verdad es la base al insertar (`tenant_node_ins`). A un rol que no puede, no se le
 * muestra el botón (doc 06 §c.6.4).
 *
 * **Tarjetas y no una tabla**, porque son pocas y lo que más importa es la identidad del barrio. La
 * franja de acento de arriba es lo que hace que dos barrios se distingan de reojo (doc 06 §b.5).
 */
export default async function Barrios() {
  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const { barrios, administraciones, visibles, meses } = await conSesion(async (tx) => ({
    barrios: await listarBarriosAccesibles(tx),
    administraciones: await administracionesDondeCrear(tx),
    visibles: await listarAdministracionesVisibles(tx),
    // T2: el estado del mes en cada barrio, para el chip de la tarjeta (lectura corta, sin vista previa).
    meses: await mesEnMisBarrios(tx),
  }));
  const mesDe = new Map(meses.map((m) => [m.barrioId, m]));
  const mesEnCurso = meses[0] ? nombreDelPeriodo(meses[0].periodo).split(" ")[0]!.toLowerCase() : null;

  const puedeCrear = administraciones.length > 0;
  const nombreAdministracion = nombreDeLaAdministracion(barrios, administraciones);
  // La configuración general es de la administración y vive en su propia ruta (encargo 8, T1 §4):
  // qué administración muestra lo elige esa pantalla. Se ofrece a quien puede verla: si tiene alguna
  // administración a la vista, con la misma lectura con la que `/configuracion` decide (encargo 9, §4).
  const hayConfiguracionGeneral = visibles.length > 0;
  const sinPadron = barrios.filter((b) => b.unidadesActivas === 0).length;
  const unidadesTotales = barrios.reduce((suma, b) => suma + b.unidadesActivas, 0);

  return (
    <CuerpoConBarraLateral
      barraLateral={
        <BarraDeLaAdministracion
          nombre={nombreAdministracion}
          activo="barrios"
          conConfiguracionGeneral={hayConfiguracionGeneral}
          mesEnCurso={mesEnCurso}
        />
      }
    >
    <main id="contenido" className={estilosAdmin.contenido}>
      <Pagina>
        <EncabezadoDePagina
          // Como la maqueta: «{administración} › Barrios». El mapa de barrios es la pantalla de la
          // administración, así que su tramo lleva acá mismo (encargo 9, §3: todo tramo menos el último).
          migas={nombreAdministracion ? [{ texto: nombreAdministracion, href: "/" }, { texto: "Barrios" }] : undefined}
          titulo="Barrios"
          bajada={
            <>
              {nombreAdministracion
                ? `Los barrios que administra ${nombreAdministracion}.`
                : "Los barrios que administrás."}{" "}
              Cada barrio tiene su padrón, su liquidación y su cobranza; la configuración general (mora,
              imputación) la heredan todos y cada uno la puede ajustar.
            </>
          }
          acciones={
            hayConfiguracionGeneral ? (
              <>
                <Boton variante="sutil" href={RUTA_CONFIGURACION_GENERAL}>
                  Configuración general
                </Boton>
                {puedeCrear ? (
                  <Boton variante="primario" href={RUTA_NUEVO_BARRIO}>
                    Nuevo barrio
                  </Boton>
                ) : null}
              </>
            ) : undefined
          }
        />

        {barrios.length === 0 && !puedeCrear ? (
          <Vacio icono={<IconoBarrio />} titulo="Tu usuario no tiene rol de gestión en ningún barrio">
            No es que no haya barrios: es que ninguno es accesible con esta identidad. El acceso se da
            barrio por barrio, según el rol que tu usuario tenga asignado en cada uno.
          </Vacio>
        ) : (
          <>
            {barrios.length > 0 ? (
              <FilaDeCifras>
                <CifraDeLaFila etiqueta="Barrios" origen="los que ves con tu usuario">
                  <span className="dinero">{entero(barrios.length)}</span>
                </CifraDeLaFila>
                <CifraDeLaFila etiqueta="Unidades activas" origen="sin contar las dadas de baja">
                  <span className="dinero">{entero(unidadesTotales)}</span>
                </CifraDeLaFila>
                <CifraDeLaFila
                  etiqueta={sinPadron === 1 ? "Barrio sin padrón" : "Barrios sin padrón"}
                  origen="sin ninguna unidad activa cargada"
                >
                  <span className="dinero">{entero(sinPadron)}</span>
                </CifraDeLaFila>
              </FilaDeCifras>
            ) : (
              <Vacio icono={<IconoBarrio />} titulo="Todavía no hay barrios">
                Creá el primero: con el nombre, la figura y cómo se liquida alcanza para empezar a cargar
                el padrón.
              </Vacio>
            )}

            <div className={estilos.rejilla}>
              {barrios.map((barrio) => (
                <TarjetaDeBarrio key={barrio.id} barrio={barrio} mes={mesDe.get(barrio.id) ?? null} />
              ))}
              {puedeCrear ? (
                <Link href={RUTA_NUEVO_BARRIO} className={estilos.tarjetaNueva}>
                  <span aria-hidden>＋&nbsp;</span>Nuevo barrio
                </Link>
              ) : null}
            </div>
          </>
        )}
      </Pagina>
    </main>
    </CuerpoConBarraLateral>
  );
}

/**
 * El nombre para la bajada: el de la única administración donde puede crear o, si no puede crear en
 * ninguna, el del único estudio que administra sus barrios. Con más de una, no se elige ninguna.
 */
function nombreDeLaAdministracion(
  barrios: readonly BarrioAccesible[],
  administraciones: readonly { readonly nombre: string }[],
): string | null {
  if (administraciones.length === 1) return administraciones[0]?.nombre ?? null;
  if (administraciones.length > 1) return null;
  const nombres = new Set(barrios.flatMap((b) => (b.administrador ? [b.administrador.nombre] : [])));
  return nombres.size === 1 ? ([...nombres][0] ?? null) : null;
}

/** El chip del mes en la tarjeta (T2): sin vista previa, «Listo para emitir» se ve en Liquidación actual. */
const CHIP_DEL_MES: Record<MesDeUnBarrio["estado"], { readonly tono: "neutro" | "alerta" | "exito"; readonly texto: string }> = {
  sin_abrir: { tono: "alerta", texto: "Preparando" },
  preparando: { tono: "alerta", texto: "Preparando" },
  emitido: { tono: "exito", texto: "Emitido" },
  enviado: { tono: "exito", texto: "Enviado" },
};

function TarjetaDeBarrio({ barrio, mes }: { readonly barrio: BarrioAccesible; readonly mes: MesDeUnBarrio | null }) {
  const acento = {
    "--acento-claro": acentoBarrio(barrio.id, "light"),
    "--acento-oscuro": acentoBarrio(barrio.id, "dark"),
  } as CSSProperties;
  const sinPadron = barrio.unidadesActivas === 0;
  // «Cargar el padrón» es para quien puede cargarlo. Los roles son dato para la UI: la base vuelve a
  // mirar al escribir (`padron_evento`, 0065).
  const puedeCargar = barrio.roles.includes("admin_barrio") || barrio.roles.includes("admin_plataforma");

  return (
    <article className={estilos.tarjeta} style={acento}>
      <h2 className={estilos.nombre}>
        <Link href={portadaDelBarrio(barrio.id)} className={estilos.enlaceTarjeta}>
          {barrio.nombre}
        </Link>
        {sinPadron ? <Chip tono="alerta">Sin padrón</Chip> : null}
      </h2>

      <TiraDeChips>
        <Chip tono="neutro">{etiquetaFigura(barrio.figuraJuridica)}</Chip>
        {/* Sin modelo (barrio sin alta de T3 y sin períodos) no hay chip: no se adivina. */}
        {barrio.modelo ? <Chip tono="neutro">{MODELO_EXPENSA_CORTO[barrio.modelo]}</Chip> : null}
      </TiraDeChips>

      <p className={estilos.datos}>
        {/*
          "unidades ACTIVAS": las de baja siguen en el padrón porque su deuda sigue existiendo
          (art. 2049); la palabra es el denominador implícito de la cifra.
        */}
        <span>{unidades(barrio.unidadesActivas)}</span>
        {sinPadron && puedeCargar ? (
          <Link href={rutaDelPadron(barrio.id)} className={estilos.accionTarjeta}>
            Cargar el padrón →
          </Link>
        ) : null}
      </p>
      {mes && !sinPadron ? (
        <p className={estilos.datos}>
          <span>
            {nombreDelPeriodo(mes.periodo).split(" ")[0]}: <Chip tono={CHIP_DEL_MES[mes.estado].tono}>{CHIP_DEL_MES[mes.estado].texto}</Chip>
          </span>
          <Link href={rutaDeLiquidacion(barrio.id)} className={estilos.accionTarjeta}>
            Ir al mes →
          </Link>
        </p>
      ) : null}
    </article>
  );
}
