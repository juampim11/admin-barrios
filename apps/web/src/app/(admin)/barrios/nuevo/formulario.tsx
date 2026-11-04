"use client";

/**
 * **Nuevo barrio** — la isla del formulario (maqueta T3 aprobada, pantalla 2).
 *
 * Las cinco secciones de la maqueta, en el mismo orden y con sus textos. Lo que esta isla decide es
 * **qué campo se dibuja** según lo elegido (la cuenta única o por unidad, el «Otro día…» del
 * vencimiento, el prefijo del código): ni una regla de negocio. Qué es obligatorio, qué CBU es
 * válido, que el recaudador vaya solo con cuentas por unidad y quién puede crear lo deciden
 * `crearBarrioSchema` (`@admin-barrios/shared/escrituras`) y la base.
 *
 * Todo lo que la pantalla necesita saber del servidor —las administraciones, los períodos posibles,
 * el resumen de la mora heredada, los ejemplos del código de pago— llega armado por props.
 *
 * **El acta se sube con la administración como nodo**: el barrio todavía no existe. Si hay más de una
 * administración y se cambia la elegida, la subida se descarta (la base solo acepta un acta pedida
 * para ESA administración, `crearBarrio`).
 */

import { useState, type ReactNode } from "react";
import { Boton, Chip, PanelDesplegable } from "@admin-barrios/ui";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { crearBarrioAction } from "../../../../acciones/padron.ts";
import type { ResultadoDeAccion } from "../../../../acciones/resultado.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoOpciones,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
} from "../../../../componentes/formulario.tsx";
import { Nota, Panel } from "../../../../componentes/ui.tsx";
import { useSubidaDeRespaldo } from "../../../../componentes/useSubidaDeRespaldo.ts";
import { rutaDelPadron } from "../../../../rutas.ts";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

/** Lo que la isla sabe de la mora heredada de cada administración (para la nota de la sección 4). */
export type MoraDeLaAdministracion = {
  /** «Cobra interés por mora: Sí», «Tasa compensatoria: 3 % mensual»… `null` si no se pudo leer. */
  readonly resumen: readonly string[] | null;
  /** La configuración general, si hay un barrio por donde entrar. */
  readonly href: string | null;
};

const DIAS_FIJOS = ["10", "15"] as const;
const OTRO_DIA = "otro";
const SIN_PREFIJO = "sin_prefijo";
const CON_PREFIJO = "con_prefijo";

const CLAVES_LEGALES = ["adecuadoArt2075", "encuadreUrbanistico", "serviciosInternos", "reglamentoInscripto"] as const;

/**
 * Una copia **para mirar** de lo elegido en un campo no controlado (ver `CampoOpciones` y
 * `CampoSeleccion` en el kit): se repone sola cada vez que la acción devuelve un resultado nuevo,
 * porque el kit remonta el campo con lo que volvió y la copia tiene que coincidir con lo que se ve.
 */
function useCopiaDeCampo<T>(resultado: ResultadoDeAccion<T>, inicial: string): readonly [string, (v: string) => void] {
  const [copia, setCopia] = useState({ de: resultado, valor: inicial });
  if (copia.de !== resultado) {
    setCopia({ de: resultado, valor: inicial });
    return [inicial, (valor: string) => setCopia({ de: resultado, valor })] as const;
  }
  return [copia.valor, (valor: string) => setCopia({ de: resultado, valor })] as const;
}

export function FormularioNuevoBarrio({
  administraciones,
  mora,
  periodos,
  mandatoSugerido,
  ejemploCodigo,
  ejemploCodigoConPrefijo,
}: {
  readonly administraciones: readonly { readonly id: string; readonly nombre: string }[];
  readonly mora: Readonly<Record<string, MoraDeLaAdministracion>>;
  /** El mes actual y el siguiente, en la hora de la base. `null` = no se pudo leer la fecha: se tipea. */
  readonly periodos: { readonly actual: { valor: string; texto: string }; readonly siguiente: { valor: string; texto: string } } | null;
  /** `AAAA-MM-01` del mes actual, o `undefined` si no se pudo leer la fecha. */
  readonly mandatoSugerido: string | undefined;
  readonly ejemploCodigo: string;
  readonly ejemploCodigoConPrefijo: string;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } = useFormulario<{
    readonly barrioId: string;
  }>(crearBarrioAction);

  const unaSola = administraciones.length === 1 ? administraciones[0] : undefined;
  const [administracion, setAdministracion] = useCopiaDeCampo(resultado, previos["administradorId"] ?? unaSola?.id ?? "");
  const [identificacion, setIdentificacion] = useCopiaDeCampo(resultado, previos["identificacionPago"] ?? "");
  const [dia, setDia] = useCopiaDeCampo(resultado, previos["diaVencimientoOpcion"] ?? "");
  const [formato, setFormato] = useCopiaDeCampo(resultado, previos["formatoCodigo"] ?? SIN_PREFIJO);

  const subida = useSubidaDeRespaldo(administracion);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="Listo: el barrio quedó creado.">
        <p>
          Ya aparece en Barrios. Lo que sigue es cargar sus unidades: a mano o con la planilla del padrón.
        </p>
        <p>
          <Boton variante="primario" href={rutaDelPadron(resultado.valor.barrioId)}>
            Cargar el padrón
          </Boton>
        </p>
      </AvisoDeExito>
    );
  }

  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";
  const moraElegida = administracion ? mora[administracion] : undefined;
  const hayErrorLegal = CLAVES_LEGALES.some((c) => (campos[c]?.length ?? 0) > 0);
  const porUnidad = identificacion === "cuenta_por_unidad";
  const cuentaUnica = identificacion === "cuenta_unica";

  return (
    <Formulario accion={enviar} etiqueta="Nuevo barrio">
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
          {unaSola ? <input type="hidden" name="administradorId" value={unaSola.id} /> : null}

          {/* ── 1 · El barrio ─────────────────────────────────────────────────────────────── */}
          <Panel
            titulo="1 · El barrio"
            origen="Cómo se llama y quién es ante la ley. Aparece en la boleta y en el informe mensual."
          >
            <Campos>
              {unaSola ? null : (
                <CampoSeleccion
                  nombre="administradorId"
                  etiqueta="Administración"
                  requerido
                  ancho
                  opciones={administraciones.map((a) => ({ valor: a.id, texto: a.nombre }))}
                  sinSeleccion="Elegí la administración…"
                  errores={campos["administradorId"]}
                  valorInicial={previos["administradorId"]}
                  alCambiar={(v) => {
                    setAdministracion(v);
                    // El acta se pidió para la administración anterior: la base la rechazaría.
                    subida.reiniciar();
                  }}
                  ayuda="La que administra el barrio. Sus administradores lo ven sin que haya que darles acceso."
                />
              )}
              <CampoTexto
                nombre="nombre"
                etiqueta="Nombre"
                requerido
                maximo={80}
                errores={campos["nombre"]}
                valorInicial={previos["nombre"]}
                ayuda="El que va en la boleta. Se puede cambiar."
              />
              <CampoTexto
                nombre="razonSocial"
                etiqueta="Razón social o denominación"
                maximo={200}
                errores={campos["razonSocial"]}
                valorInicial={previos["razonSocial"]}
                ayuda="Si no se carga, se usa el nombre."
              />
              <CampoTexto
                nombre="cuit"
                etiqueta="CUIT"
                maximo={13}
                modoDeTeclado="numeric"
                errores={campos["cuit"]}
                valorInicial={previos["cuit"]}
                ayuda="Se valida el dígito verificador."
              />
              <CampoTexto
                nombre="municipio"
                etiqueta="Municipio"
                requerido
                maximo={80}
                errores={campos["municipio"]}
                valorInicial={previos["municipio"]}
              />
              <CampoOpciones
                nombre="figuraJuridica"
                etiqueta="Figura jurídica"
                requerido
                ancho
                enFila
                errores={campos["figuraJuridica"]}
                valorInicial={previos["figuraJuridica"]}
                opciones={[
                  {
                    valor: "sa",
                    titulo: "S.A.",
                    detalle: "Sociedad anónima. Un lote, una acción. Suele cobrar cuota fija.",
                  },
                  {
                    valor: "asociacion_civil",
                    titulo: "Asociación civil",
                    detalle: "Socios por lote. Cuota fija o por coeficiente.",
                  },
                  { valor: "ph_especial", titulo: "PH / conjunto inmobiliario", detalle: "Próximamente.", deshabilitada: true },
                ]}
              />
            </Campos>
          </Panel>

          {/* ── 2 · Cómo se liquida ───────────────────────────────────────────────────────── */}
          <Panel
            titulo="2 · Cómo se liquida"
            origen="Define cómo se reparte el gasto del mes entre las unidades. Se puede cambiar más adelante, a partir de un período nuevo."
          >
            <Campos>
              <CampoOpciones
                nombre="modelo"
                etiqueta="Modelo de liquidación"
                requerido
                ancho
                enFila
                errores={campos["modelo"]}
                valorInicial={previos["modelo"]}
                opciones={[
                  {
                    valor: "fija",
                    titulo: "Cuota fija",
                    detalle: "Todas las unidades pagan lo mismo. Se fija el importe en cada período.",
                  },
                  {
                    valor: "variable",
                    titulo: "Por coeficiente",
                    detalle:
                      "Cada unidad paga según su coeficiente (por superficie, por lote o cargado a mano). Los coeficientes suman 1.",
                  },
                ]}
              />
              <CampoSeleccion
                nombre="diaVencimientoOpcion"
                etiqueta="Vencimiento de la boleta"
                requerido
                opciones={[
                  ...DIAS_FIJOS.map((d) => ({ valor: d, texto: `Día ${d} de cada mes` })),
                  { valor: OTRO_DIA, texto: "Otro día…" },
                ]}
                sinSeleccion="Elegí el día…"
                // Con «Otro día…» el error va al campo del día, que es donde se corrige.
                errores={dia === OTRO_DIA ? undefined : campos["diaVencimiento"]}
                valorInicial={previos["diaVencimientoOpcion"]}
                alCambiar={setDia}
              />
              {dia === OTRO_DIA ? (
                <CampoTexto
                  nombre="diaVencimiento"
                  etiqueta="Día del mes"
                  requerido
                  maximo={2}
                  modoDeTeclado="numeric"
                  errores={campos["diaVencimiento"]}
                  valorInicial={previos["diaVencimiento"]}
                  ayuda="Del 1 al 28: así existe en todos los meses."
                />
              ) : (
                <input type="hidden" name="diaVencimiento" value={dia} />
              )}
              {periodos ? (
                <CampoSeleccion
                  nombre="primerPeriodo"
                  etiqueta="Primer período a liquidar"
                  requerido
                  opciones={[
                    { valor: periodos.siguiente.valor, texto: periodos.siguiente.texto },
                    { valor: periodos.actual.valor, texto: periodos.actual.texto },
                  ]}
                  sinSeleccion="Elegí el período…"
                  errores={campos["primerPeriodo"]}
                  valorInicial={previos["primerPeriodo"]}
                  ayuda="Si las unidades traen deuda de antes, se carga como saldo inicial desde el padrón."
                />
              ) : (
                <CampoTexto
                  nombre="primerPeriodo"
                  etiqueta="Primer período a liquidar"
                  tipo="month"
                  requerido
                  errores={campos["primerPeriodo"]}
                  valorInicial={previos["primerPeriodo"]}
                  ayuda="Si las unidades traen deuda de antes, se carga como saldo inicial desde el padrón."
                />
              )}
            </Campos>
          </Panel>

          {/* ── 3 · Cobro ─────────────────────────────────────────────────────────────────── */}
          <Panel
            titulo="3 · Cobro"
            origen="Qué se imprime en la boleta para pagar y cómo se reconoce de qué unidad es cada pago."
          >
            <Campos>
              <CampoOpciones
                nombre="identificacionPago"
                etiqueta="Cómo se identifica el pago"
                requerido
                ancho
                enFila
                errores={campos["identificacionPago"]}
                valorInicial={previos["identificacionPago"]}
                alCambiar={setIdentificacion}
                opciones={[
                  {
                    valor: "cuenta_unica",
                    titulo: "Una cuenta para todo el barrio",
                    detalle:
                      "Todos transfieren a la misma cuenta y ponen el código de pago en el concepto. Lo que llega sin código se concilia por CUIT o CBU conocido.",
                  },
                  {
                    valor: "cuenta_por_unidad",
                    titulo: "Una cuenta por unidad",
                    detalle:
                      "Cada unidad tiene su propio CBU o alias (cuentas hijas de un recaudador, como SIRO). El pago llega a la cuenta de la unidad y se asigna solo, sin código ni CUIT.",
                  },
                ]}
              />

              {cuentaUnica ? (
                <CampoTexto
                  key="cbu-unica"
                  nombre="cuentaCbu"
                  etiqueta="Cuenta de cobro (CBU)"
                  requerido
                  maximo={26}
                  modoDeTeclado="numeric"
                  errores={campos["cuentaCbu"]}
                  valorInicial={previos["cuentaCbu"]}
                  ayuda="22 dígitos. Se valida."
                />
              ) : null}
              {cuentaUnica ? (
                <CampoTexto
                  nombre="cuentaAlias"
                  etiqueta="Alias"
                  maximo={20}
                  errores={campos["cuentaAlias"]}
                  valorInicial={previos["cuentaAlias"]}
                />
              ) : null}

              {porUnidad ? (
                <CampoSeleccion
                  nombre="recaudador"
                  etiqueta="Recaudador"
                  requerido
                  opciones={[
                    { valor: "SIRO · Banco Roela", texto: "SIRO · Banco Roela" },
                    { valor: "Otro recaudador con cuentas hijas", texto: "Otro recaudador con cuentas hijas" },
                  ]}
                  sinSeleccion="Elegí el recaudador…"
                  errores={campos["recaudador"]}
                  valorInicial={previos["recaudador"]}
                />
              ) : null}
              {porUnidad ? (
                <CampoTexto
                  key="cbu-padre"
                  nombre="cuentaCbu"
                  etiqueta="Cuenta padre (CBU)"
                  requerido
                  maximo={26}
                  modoDeTeclado="numeric"
                  errores={campos["cuentaCbu"]}
                  valorInicial={previos["cuentaCbu"]}
                  ayuda="Donde el recaudador acredita lo cobrado. Es la que aparece en el extracto."
                />
              ) : null}
            </Campos>

            {porUnidad ? (
              <Nota tono="info">
                El CBU o alias de cada unidad se carga en su ficha o en la planilla del padrón (columnas{" "}
                <code>cbu_unidad</code> y <code>alias_unidad</code>). La boleta imprime el de la unidad. Si el
                barrio usa una cuenta para todo el barrio, estos campos no aparecen ni en la ficha, ni en el alta,
                ni en la planilla. Una unidad sin cuenta propia queda marcada y su boleta muestra la cuenta padre
                con el código de pago.
              </Nota>
            ) : null}

            <Campos>
              <CampoSeleccion
                nombre="medioCobranza"
                etiqueta="Medio impreso en la boleta"
                requerido
                opciones={[
                  { valor: "transferencia-qr", texto: "Transferencia y QR" },
                  { valor: "generico-demo", texto: "Código de barras (red de cobranza)" },
                  { valor: "siro", texto: "Cupón SIRO (próximamente)", deshabilitada: true },
                ]}
                sinSeleccion="Elegí el medio…"
                errores={campos["medioCobranza"]}
                valorInicial={previos["medioCobranza"]}
              />
              <CampoSeleccion
                nombre="formatoCodigo"
                etiqueta="Formato del código de pago"
                requerido
                opciones={[
                  { valor: SIN_PREFIJO, texto: `6 dígitos y verificador · ${ejemploCodigo}` },
                  { valor: CON_PREFIJO, texto: `Con prefijo numérico del barrio · ${ejemploCodigoConPrefijo}` },
                ]}
                sinSeleccion="Elegí el formato…"
                errores={formato === CON_PREFIJO ? undefined : campos["codigoPagoPrefijo"]}
                valorInicial={previos["formatoCodigo"] ?? SIN_PREFIJO}
                alCambiar={setFormato}
                ayuda="Cada unidad recibe el suyo al darla de alta y no cambia aunque cambie el titular. Con cuenta por unidad sirve de respaldo."
              />
              {formato === CON_PREFIJO ? (
                <CampoTexto
                  nombre="codigoPagoPrefijo"
                  etiqueta="Prefijo del barrio"
                  requerido
                  maximo={6}
                  modoDeTeclado="numeric"
                  errores={campos["codigoPagoPrefijo"]}
                  valorInicial={previos["codigoPagoPrefijo"]}
                  ayuda="Hasta 6 números. Va adelante de cada código de pago del barrio."
                />
              ) : (
                <input type="hidden" name="codigoPagoPrefijo" value="" />
              )}
            </Campos>
          </Panel>

          {/* ── 4 · Administración y mora ─────────────────────────────────────────────────── */}
          <Panel titulo="4 · Administración y mora">
            <Campos>
              <CampoTexto
                nombre="mandatoDesde"
                etiqueta="Administra desde"
                tipo="date"
                requerido
                errores={campos["mandatoDesde"]}
                valorInicial={previos["mandatoDesde"] ?? mandatoSugerido}
                ayuda="El mandato. Se puede adjuntar el acta de designación."
              />
              <CampoArchivo
                nombre="actaAdjunto"
                etiqueta="Acta de designación"
                aceptar={TIPOS_ACEPTADOS}
                estado={subida.estado}
                onElegirArchivo={subida.elegirArchivo}
                onReintentar={subida.reintentar}
                // Sin administración elegida no hay nodo para pedir la subida.
                deshabilitado={!administracion}
                errores={campos["actaAdjunto"]}
                ayuda={administracion ? "PDF o foto." : "PDF o foto. Primero elegí la administración."}
              />
            </Campos>
            <Nota tono="info">
              <NotaDeMora mora={moraElegida} />
            </Nota>
          </Panel>

          {/* ── 5 · Datos legales y urbanísticos ──────────────────────────────────────────── */}
          <PanelDesplegable
            titulo={
              <>
                5 · Datos legales y urbanísticos <Chip tono="neutro">Completar después</Chip>
              </>
            }
            abiertoPorDefecto={hayErrorLegal}
          >
            <Campos>
              <CampoSeleccion
                nombre="adecuadoArt2075"
                etiqueta="Adecuado al art. 2075"
                sinSeleccion="A confirmar"
                opciones={[
                  { valor: "si", texto: "Sí" },
                  { valor: "no", texto: "No" },
                  { valor: "en_tramite", texto: "En trámite" },
                ]}
                errores={campos["adecuadoArt2075"]}
                valorInicial={previos["adecuadoArt2075"]}
              />
              <CampoSeleccion
                nombre="encuadreUrbanistico"
                etiqueta="Encuadre urbanístico"
                sinSeleccion="A confirmar"
                opciones={[
                  { valor: "ure", texto: "Urbanización residencial especial" },
                  { valor: "loteo_abierto", texto: "Loteo abierto" },
                  { valor: "cierre_calles", texto: "Cierre de calles" },
                ]}
                errores={campos["encuadreUrbanistico"]}
                valorInicial={previos["encuadreUrbanistico"]}
              />
              <CampoSeleccion
                nombre="serviciosInternos"
                etiqueta="Servicios internos a cargo de"
                sinSeleccion="A confirmar"
                opciones={[
                  { valor: "urbanizacion", texto: "El barrio" },
                  { valor: "municipio", texto: "El municipio" },
                  { valor: "mixto", texto: "Mixto" },
                ]}
                errores={campos["serviciosInternos"]}
                valorInicial={previos["serviciosInternos"]}
              />
              <CampoSeleccion
                nombre="reglamentoInscripto"
                etiqueta="Reglamento inscripto"
                sinSeleccion="A confirmar"
                opciones={[
                  { valor: "si", texto: "Sí" },
                  { valor: "no", texto: "No" },
                ]}
                errores={campos["reglamentoInscripto"]}
                valorInicial={previos["reglamentoInscripto"]}
              />
            </Campos>
          </PanelDesplegable>

          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>
          <Acciones ayuda={subiendo ? "Esperando que termine de subir el acta." : undefined}>
            {/* «Cancelar» vuelve a Mis barrios, de donde se llega a esta pantalla (encargo 8, T1 §2). */}
            <Boton href="/" variante="sutil" deshabilitado={pendiente}>
              Cancelar
            </Boton>
            <BotonEnviar pendiente={pendiente} deshabilitado={subiendo} cargando="Creando el barrio…">
              Crear el barrio y cargar el padrón
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}

/** La nota de la sección 4: de dónde sale la mora del barrio nuevo, con los valores que rigen hoy. */
function NotaDeMora({ mora }: { readonly mora: MoraDeLaAdministracion | undefined }): ReactNode {
  const general = mora?.href ? <a href={mora.href}>configuración general</a> : "configuración general";
  return (
    <>
      La mora y el orden de imputación salen de la {general}
      {mora?.resumen && mora.resumen.length > 0 ? `: ${mora.resumen.map((r) => `«${r}»`).join(", ")}` : ""}. Si este
      barrio cobra distinto, se ajusta en Configuración del barrio.
    </>
  );
}
