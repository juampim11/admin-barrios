"use client";

/**
 * «Nueva versión de coeficientes» (T3, diálogo de la pantalla 6 de la maqueta aprobada), abierto en
 * un `AccionDesplegable` de la página. Es la isla; el patrón es el de `cobros/[unidad]/condonacion.tsx`.
 *
 * Ninguna regla vive acá: cómo se calcula cada forma (9 decimales, el resto a la última unidad), que
 * todas las unidades tengan superficie, que la planilla traiga todas las unidades activas, y que la
 * versión no se superponga con una ya usada, lo deciden el servicio y la base.
 *
 * El único estado de cliente es **qué forma está elegida**, para mostrar el campo del archivo solo
 * cuando es «Cargar por planilla». El segmentado sigue siendo no controlado (radios nativos): el
 * valor que viaja es el del `FormData`, no el del estado.
 */

import { useEffect, useId, useState } from "react";
import { FORMAS_COEFICIENTE, type FormaCoeficiente } from "@admin-barrios/shared/coeficientes";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { ETIQUETA_RESPALDO } from "@admin-barrios/shared/parametros-mora";
import { Boton, DatoEnLinea, Segmentado, TextoDeOrigen } from "@admin-barrios/ui";
import { nuevaVersionCoeficientesAction } from "../../../../../acciones/padron.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoArchivoDelFormulario,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
  useVolverAlGuardar,
} from "../../../../../componentes/formulario.tsx";
import { conListo } from "../../../../../rutas.ts";
import { useSubidaDeRespaldo } from "../../../../../componentes/useSubidaDeRespaldo.ts";
import estilos from "./coeficientes.module.css";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

/** Los instrumentos que acepta `nuevaVersionCoeficientesSchema` (sin «acta de comisión»). */
const RESPALDOS = ["reglamento", "acta_asamblea", "otro"] as const;

/** El verbo de cada forma, como en la maqueta. El nombre de la base ya creada es otro (`etiquetas.tsx`). */
const TEXTO_FORMA: Record<FormaCoeficiente, string> = {
  superficie: "Calcular por superficie",
  iguales: "Iguales por lote",
  planilla: "Cargar por planilla",
};

const esForma = (v: string | undefined): v is FormaCoeficiente => FORMAS_COEFICIENTE.some((f) => f === v);

/**
 * En su página, `padron/coeficientes/nueva` (encargo 9, PR 1 §2): «Cancelar» vuelve a la lista de
 * versiones y, al guardar, la lista dice «Listo:».
 */
export function FormularioDeNuevaVersion({
  barrioId,
  periodos,
  unidadesActivas,
  conSuperficie,
  superficieTotal,
  volverA,
}: {
  readonly barrioId: string;
  /** La lista de versiones: a donde llevan «Cancelar» y el guardado. */
  readonly volverA: string;
  /** El próximo período a liquidar y los dos siguientes, ya rotulados por el servidor. */
  readonly periodos: readonly { readonly valor: string; readonly texto: string }[];
  readonly unidadesActivas: number;
  readonly conSuperficie: number;
  /** «281.940,00», ya formateado; `null` si ninguna unidad tiene superficie. */
  readonly superficieTotal: string | null;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } = useFormulario(nuevaVersionCoeficientesAction);
  useVolverAlGuardar(resultado, (version) => conListo(volverA, "coeficientes", version.versionId));
  const subida = useSubidaDeRespaldo(barrioId);
  const idForma = useId();

  // Por superficie solo se propone de entrada si todas las unidades activas la tienen.
  const formaDeEntrada: FormaCoeficiente | undefined = unidadesActivas > 0 && conSuperficie === unidadesActivas ? "superficie" : undefined;
  const [forma, setForma] = useState<FormaCoeficiente | undefined>(formaDeEntrada);
  // Después de un envío fallido el formulario se repuebla con lo que devolvió la acción.
  useEffect(() => {
    const devuelta = previos["forma"];
    if (esForma(devuelta)) setForma(devuelta);
  }, [previos]);

  if (resultado.estado === "ok") {
    const { unidades, suma } = resultado.valor;
    return (
      <AvisoDeExito titulo="Listo: la versión de coeficientes quedó creada. Volviendo a la lista…">
        <p>
          Incluye {unidades} {unidades === 1 ? "unidad" : "unidades"} y suma {suma.replace(".", ",")}.
        </p>
      </AvisoDeExito>
    );
  }

  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";
  const sinSuperficie = unidadesActivas - conSuperficie;

  const ayudaDeForma =
    forma === "superficie"
      ? sinSuperficie > 0
        ? `El coeficiente de cada unidad es su superficie sobre la total. Hay ${sinSuperficie} ${sinSuperficie === 1 ? "unidad" : "unidades"} sin superficie: cargala en el padrón o elegí otra forma.`
        : "El coeficiente de cada unidad es su superficie sobre la superficie total."
      : forma === "iguales"
        ? "Todas las unidades activas reciben el mismo coeficiente."
        : forma === "planilla"
          ? "Los valores de la planilla se normalizan para que la suma dé 1."
          : "Elegí cómo se arma la versión.";

  return (
    <Formulario accion={enviar} etiqueta="Nueva versión de coeficientes">
      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          onVolver={volverACorregir}
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        />
      ) : (
        <>
          <input type="hidden" name="barrioId" value={barrioId} />
          <div
            onChange={(e) => {
              const objetivo = e.target as HTMLInputElement;
              if (objetivo.name === "forma" && esForma(objetivo.value)) setForma(objetivo.value);
            }}
          >
            <Segmentado
              id={idForma}
              nombre="forma"
              etiqueta="Cómo se calculan"
              requerido
              valorInicial={previos["forma"] ?? formaDeEntrada}
              opciones={FORMAS_COEFICIENTE.map((f) => ({ valor: f, texto: TEXTO_FORMA[f] }))}
              ayuda={ayudaDeForma}
              error={campos["forma"]?.[0]}
            />
          </div>
          <Campos>
            <CampoSeleccion
              nombre="rigeDesde"
              etiqueta="Rige desde el período"
              requerido
              opciones={periodos}
              sinSeleccion="Elegí el período…"
              errores={campos["rigeDesde"]}
              valorInicial={previos["rigeDesde"] ?? periodos[0]?.valor}
              ayuda="El primero es el próximo período a liquidar. Rige desde ahí en adelante."
            />
            {forma === "planilla" ? (
              <CampoArchivoDelFormulario
                nombre="archivo"
                etiqueta="Planilla de coeficientes"
                requerido
                aceptar=".xlsx,.csv"
                errores={campos["archivo"]}
                ayuda="Excel (.xlsx) o CSV con las columnas manzana, lote y coeficiente; una fila por unidad activa."
              />
            ) : null}
            <CampoSeleccion
              nombre="respaldoTipo"
              etiqueta="Respaldo"
              opciones={RESPALDOS.map((t) => ({ valor: t, texto: ETIQUETA_RESPALDO[t] }))}
              sinSeleccion="Sin respaldo"
              errores={campos["respaldoTipo"]}
              valorInicial={previos["respaldoTipo"]}
              ayuda="El acta o el reglamento que fija los coeficientes."
            />
            <CampoTexto
              nombre="respaldoReferencia"
              etiqueta="Referencia del respaldo"
              maximo={300}
              errores={campos["respaldoReferencia"]}
              valorInicial={previos["respaldoReferencia"]}
              ayuda="Dónde se encuentra: el acta con su fecha, o el artículo."
            />
            <CampoArchivo
              nombre="respaldoAdjunto"
              etiqueta="Adjunto del respaldo"
              ancho
              aceptar={TIPOS_ACEPTADOS}
              estado={subida.estado}
              onElegirArchivo={subida.elegirArchivo}
              onReintentar={subida.reintentar}
              errores={campos["respaldoAdjunto"]}
              ayuda="PDF o foto (JPG o PNG). Opcional."
            />
          </Campos>

          <p className={estilos.resumen}>
            <TextoDeOrigen>
              Unidades activas <DatoEnLinea>{unidadesActivas}</DatoEnLinea>
            </TextoDeOrigen>
            <TextoDeOrigen>
              Superficie total{" "}
              <DatoEnLinea>{superficieTotal === null ? "sin superficie cargada" : `${superficieTotal} m²`}</DatoEnLinea>
              {superficieTotal !== null && sinSuperficie > 0 ? ` (${conSuperficie} de ${unidadesActivas} unidades)` : ""}
            </TextoDeOrigen>
            <TextoDeOrigen>
              Suma <DatoEnLinea>1,000000000</DatoEnLinea>
            </TextoDeOrigen>
          </p>
          <p>
            <TextoDeOrigen>
              Se calcula con 9 decimales y el resto de redondeo va a la última unidad, así la suma da 1 exacto.
            </TextoDeOrigen>
          </p>

          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>
          <Acciones ayuda={subiendo ? "Esperando que termine de subir el adjunto." : "Una versión que ya se usó para liquidar no se modifica."}>
            <Boton href={volverA} variante="sutil" deshabilitado={pendiente}>
              Cancelar
            </Boton>
            <BotonEnviar pendiente={pendiente} deshabilitado={subiendo} cargando="Creando…">
              Crear versión
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
