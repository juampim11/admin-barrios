import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPadron, type ObligadoDeUnidad, type UnidadDelPadron } from "@admin-barrios/data/servicios/padron";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { IconoBarrio } from "../../../../componentes/iconos.tsx";
import {
  Chip,
  Coeficiente,
  Desplegable,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Paginado,
  Panel,
  Tabla,
  TiraDeChips,
  Vacio,
  ui,
} from "../../../../componentes/ui.tsx";
import { etiquetaEstadoUnidad, etiquetaTipoObligado } from "../../../../componentes/etiquetas.tsx";
import { esIdValido } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import estilos from "./padron.module.css";

export const metadata: Metadata = { title: "Padrón" };

/**
 * Cuántas unidades por página.
 *
 * **No es el techo del esquema, y esa es la decisión.** `MAXIMO_POR_PAGINA` vale 500 y el `default`
 * del schema compartido *es* ese máximo: una pantalla que no pase nada se trae —y serializa al
 * RSC— la PII de 500 obligados de una sola vez. El techo sirve como techo; como tamaño de lectura
 * es lo contrario de lo que se busca. 50 filas es lo que entra en una pantalla y lo que sale en una
 * captura.
 */
const POR_PAGINA = 50;

/** La página llega por la URL, o sea del cliente. Se valida con Zod, como todo lo que cruza el borde. */
const consultaSchema = z.object({
  pagina: z.coerce.number().int().min(1).catch(1),
  bajas: z
    .string()
    .optional()
    .transform((v) => v === "1"),
});

/**
 * El padrón: qué unidades hay, quién responde por cada una y con qué coeficiente.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA DECISIÓN SOBRE LOS DATOS PERSONALES, Y POR QUÉ
 *
 * `listarPadron` devuelve, por cada obligado: nombre, tipo de documento, número, CUIT, email y
 * teléfono. **En la grilla van dos cosas: quién es y qué relación tiene con la unidad.** Documento,
 * CUIT, email y teléfono viven en un `<details>` cerrado, por unidad.
 *
 * El corte no es "PII sí / PII no" —el nombre también es un dato personal— sino **identificadores y
 * canales de contacto** contra **identidad y relación jurídica**:
 *
 * · `nombre`, `tipo` y `esNotificado` **quedan a la vista**. Sin el nombre la grilla no sirve para
 *   nada, y el tipo y el notificado no son datos *de la persona*: son datos de la *relación* —a quién
 *   le llega la boleta, quién responde por la unidad (art. 2050, el propietario no se libera porque
 *   haya un poseedor)—. Ocultarlos no protege a nadie y rompe la pantalla.
 *
 * · `numeroDocumento`, `cuitCuil`, `email` y `telefono` **no**. Una captura de 200 filas con nombre y
 *   DNI es un kit de identidad completo, y con los emails es la lista de correo del barrio entero —
 *   la munición exacta del phishing más creíble que existe contra este producto ("tu expensa
 *   venció"). Ninguno de los cuatro se usa para nada en una pantalla de solo lectura.
 *
 * · **Documento y CUIT van juntos, siempre.** Ocultar el DNI y mostrar el CUIT no oculta nada: el
 *   CUIT de una persona física *contiene* el DNI (`20-XXXXXXXX-Y`).
 *
 * · **Nada de enmascarar** (`•••4821`, `j***@gmail.com`). El enmascarado parcial da sensación de
 *   control y sigue filtrando: los últimos cuatro dígitos más el nombre alcanzan para que a alguien
 *   lo atiendan en un call center. O está o no está.
 *
 * **Qué protege y qué no —dicho de frente.** El valor está en el HTML aunque el `<details>` esté
 * cerrado: no hay round-trip. Eso mitiga la captura, el proyector y el hombro en la guardia, que son
 * amenazas visuales y son las de esta pantalla. **No** mitiga "ver código fuente" ni imprimir a PDF.
 * Contra eso el único control es no mandarlo, y hoy no corresponde: quien llega acá ya está
 * autorizado a verlo —la policy de `obligado` (migración 0018) exige rol de gestión, y una membresía
 * `propietario` no lee ni una fila—. La fricción, acá, es la protección: revelar el padrón entero son
 * cincuenta clics, no un scroll.
 *
 * **Lo que no se hizo, y por qué no.** Condicionar las columnas al rol sería teatro: los cinco roles
 * que llegan a esta consulta reciben de la RLS exactamente las mismas filas, y `roles` se calcula en
 * TypeScript —su propio tipo dice "es dato para la UI, nunca la autorización"—. Usarlo para decidir
 * qué manda el servidor sería mover la autorización a TypeScript, que es justo lo que este proyecto
 * prohíbe. El día que un `auditor` no deba ver contacto, eso es una policy en la base.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
export default async function Padron({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  // Ídem el layout: se renderizan en paralelo, así que el chequeo va en los dos (ver `rutas.ts`).
  if (!esIdValido(barrioId)) notFound();

  const crudos = await searchParams;
  const { pagina, bajas } = consultaSchema.parse({
    pagina: crudos["pagina"],
    bajas: typeof crudos["bajas"] === "string" ? crudos["bajas"] : undefined,
  });

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    padron: await listarPadron(tx, {
      barrioId,
      limite: POR_PAGINA,
      desplazamiento: (pagina - 1) * POR_PAGINA,
      incluirBajas: bajas,
    }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const padron = datos.padron;

  const paginas = Math.max(1, Math.ceil(padron.total / POR_PAGINA));

  // Una página fuera de rango —escrita a mano en la URL, o dejada en el historial después de dar de
  // baja unidades— devolvería cero filas y mostraría "no hay unidades activas" en un barrio que
  // tiene 500. Se manda a la última página real. El `redirect()` va acá, con la transacción ya
  // cerrada (ADR-0002 §3.1).
  if (pagina > paginas) redirect(`/${barrio.id}/padron?${bajas ? "bajas=1&" : ""}pagina=${paginas}`);

  const desde = padron.total === 0 ? 0 : padron.desplazamiento + 1;
  const hasta = padron.desplazamiento + padron.unidades.length;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Padrón"
        bajada={
          bajas
            ? `Las ${barrio.unidadesActivas + barrio.unidadesDeBaja} unidades del padrón: ${barrio.unidadesActivas} activas y ${barrio.unidadesDeBaja} dadas de baja.`
            : `Las ${barrio.unidadesActivas} unidades activas de ${barrio.nombre}, con su obligado vigente y su coeficiente.`
        }
      />

      <div className={estilos.filtros}>
        <Link
          href={`/${barrio.id}/padron`}
          className={`${estilos.interruptor} ${bajas ? "" : estilos.interruptorActivo}`}
          aria-current={bajas ? undefined : "true"}
        >
          Solo activas ({barrio.unidadesActivas})
        </Link>
        <Link
          href={`/${barrio.id}/padron?bajas=1`}
          className={`${estilos.interruptor} ${bajas ? estilos.interruptorActivo : ""}`}
          aria-current={bajas ? "true" : undefined}
        >
          Incluir dadas de baja ({barrio.unidadesDeBaja})
        </Link>
      </div>

      {barrio.unidadesDeBaja > 0 && bajas ? (
        <Nota tono="info" titulo="Las unidades dadas de baja siguen en el padrón.">
          La baja es lógica porque la deuda cuelga de la unidad y no del dueño (art. 2049): ocultarlas
          para siempre escondería plata.
        </Nota>
      ) : null}

      <Panel
        titulo="Unidades funcionales"
        origen={
          <>
            Coeficientes de la versión <strong>cerrada y vigente</strong>. Orden por manzana y lote,
            alfabético (1, 10, 2…) — es el mismo orden con el que salen las boletas, y por eso no se
            «arregla» acá.
          </>
        }
        acciones={
          <TiraDeChips>
            <Chip tono="neutro">{POR_PAGINA} por página</Chip>
          </TiraDeChips>
        }
        sinRelleno
        pie={
          <>
            Documento, CUIT, correo y teléfono no están en la grilla: se abren por unidad. Una tabla
            que se ve de un vistazo —y de la que se saca una captura— no es el lugar de los
            identificadores de una persona.
          </>
        }
      >
        {padron.unidades.length === 0 ? (
          <Vacio
            icono={<IconoBarrio />}
            titulo={bajas ? "El padrón está vacío" : "No hay unidades activas"}
          >
            {bajas
              ? "Todavía no se cargaron unidades funcionales en este barrio."
              : barrio.unidadesDeBaja > 0
                ? `Hay ${barrio.unidadesDeBaja} unidades dadas de baja. Usá «Incluir dadas de baja» para verlas.`
                : "Todavía no se cargaron unidades funcionales en este barrio."}
          </Vacio>
        ) : (
          <>
            <MarcoTabla etiqueta="Padrón de unidades funcionales">
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col" className={ui.columnaAncla}>
                      Unidad
                    </th>
                    <th scope="col">Obligado notificado</th>
                    <th scope="col">Otros obligados</th>
                    <th scope="col" className={ui.numerica}>
                      Coeficiente
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Superficie m²
                    </th>
                    <th scope="col">Datos de contacto</th>
                  </tr>
                </thead>
                <tbody>
                  {padron.unidades.map((unidad) => (
                    <FilaDelPadron key={unidad.id} unidad={unidad} />
                  ))}
                </tbody>
              </Tabla>
            </MarcoTabla>
            <Paginado
              ruta={`/${barrio.id}/padron`}
              parametros={bajas ? { bajas: "1" } : {}}
              pagina={pagina}
              paginas={paginas}
              rango={
                <>
                  Mostrando {desde}–{hasta} de {padron.total}{" "}
                  {bajas ? "unidades del padrón" : "unidades activas"}
                </>
              }
            />
          </>
        )}
      </Panel>
    </Pagina>
  );
}

function FilaDelPadron({ unidad }: { readonly unidad: UnidadDelPadron }) {
  // Hay UNO solo por unidad (`uq_unidad_notificado`) y es a quien le llega la liquidación.
  const notificado = unidad.obligados.find((o) => o.esNotificado);
  const otros = unidad.obligados.filter((o) => !o.esNotificado);

  return (
    <tr className={unidad.dadaDeBaja ? estilos.filaDeBaja : undefined}>
      <th scope="row" className={ui.columnaAncla}>
        <span className={estilos.unidad}>
          <span className={estilos.etiquetaUnidad}>{unidad.etiqueta}</span>
          <span className={ui.secundaria}>{etiquetaEstadoUnidad(unidad.estadoUnidad)}</span>
          {unidad.dadaDeBaja ? (
            <span>
              <Chip tono="alerta">De baja</Chip>
            </span>
          ) : null}
        </span>
      </th>

      <td>
        {notificado ? (
          <span className={estilos.obligado}>
            <span className={ui.principal}>{notificado.nombre}</span>
            <span className={ui.secundaria}>
              {etiquetaTipoObligado(notificado.tipo)}
              {notificado.esPersonaJuridica ? " · persona jurídica" : ""} · desde{" "}
              {formatearFecha(notificado.desde)}
            </span>
          </span>
        ) : (
          <Chip tono="alerta">Sin obligado notificado</Chip>
        )}
      </td>

      <td>
        {otros.length === 0 ? (
          <span className={ui.secundaria}>—</span>
        ) : (
          <span className={estilos.obligado}>
            {otros.map((o) => (
              <span key={o.id}>
                {o.nombre} <span className={ui.secundaria}>({etiquetaTipoObligado(o.tipo)})</span>
              </span>
            ))}
          </span>
        )}
      </td>

      <td className={ui.numerica}>
        <Coeficiente valor={unidad.coeficiente} nulo="sin coeficiente" />
      </td>

      <td className={ui.numerica}>
        {unidad.superficieM2 === null ? (
          <span className={ui.secundaria}>—</span>
        ) : (
          formatearDecimal(unidad.superficieM2, 2)
        )}
      </td>

      <td>
        {unidad.obligados.length === 0 ? (
          <span className={ui.secundaria}>—</span>
        ) : (
          <Desplegable resumen="Mostrar">
            {unidad.obligados.map((o) => (
              <ContactoDeObligado key={o.id} obligado={o} />
            ))}
          </Desplegable>
        )}
      </td>
    </tr>
  );
}

/** Los identificadores y los canales de contacto: fuera de la grilla, a un gesto de distancia. */
function ContactoDeObligado({ obligado }: { readonly obligado: ObligadoDeUnidad }) {
  return (
    <div>
      <p className={estilos.nombreEnDetalle}>
        {obligado.nombre} · {etiquetaTipoObligado(obligado.tipo)}
      </p>
      <dl className={estilos.contacto}>
        <div>
          <dt>Documento</dt>
          <dd>
            {obligado.numeroDocumento
              ? `${obligado.tipoDocumento ?? ""} ${obligado.numeroDocumento}`.trim()
              : "sin dato"}
          </dd>
        </div>
        <div>
          <dt>CUIT / CUIL</dt>
          <dd>{obligado.cuitCuil ?? "sin dato"}</dd>
        </div>
        <div>
          <dt>Correo</dt>
          <dd>{obligado.email ?? "sin dato"}</dd>
        </div>
        <div>
          <dt>Teléfono</dt>
          <dd>{obligado.telefono ?? "sin dato"}</dd>
        </div>
      </dl>
    </div>
  );
}
