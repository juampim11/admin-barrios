"use client";

/**
 * «Agregar unidad» (pantalla 3 de la maqueta aprobada `alta-barrio-padron.html`, diálogo
 * «Agregar unidad»). Es la isla de la pantalla del padrón; el patrón es el de la condonación
 * (`cobros/[unidad]/condonacion.tsx`): se abre en un `AccionDesplegable` y la confirmación
 * («¿Es la misma persona?», `titular_ya_registrado`) reemplaza al formulario en el mismo lugar.
 *
 * Ninguna regla vive acá: qué es un CUIT válido, que haya una sola persona que recibe la boleta, que
 * el documento no se repita y qué código de pago le toca lo deciden el esquema de `shared`, el
 * servicio y la base. Lo único que maneja esta isla es **cuántos bloques de titular se dibujan**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LOS TITULARES SE NUMERAN POR POSICIÓN, NO POR IDENTIDAD
 *
 * La acción arma la lista con `titular.<n>.*` ordenado por `n`, y `recibeBoleta` es el **índice en
 * esa lista**. Si los nombres de los campos llevaran un id estable, quitar el titular del medio
 * dejaría un hueco (0 y 2) y el radio del último diría «2» en una lista de dos. Por eso el `key` de
 * React es estable (los campos no controlados conservan lo tipeado) y el `name` es la posición
 * actual: al quitar uno, los de abajo se renumeran solos y el radio sigue apuntando a la persona.
 */

import { useState } from "react";
import { ESTADOS_UNIDAD, TIPOS_OBLIGADO } from "@admin-barrios/shared/barrio";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { agregarUnidadAction } from "../../../../acciones/padron.ts";
import { ESTADO_UNIDAD, TIPO_OBLIGADO } from "../../../../componentes/etiquetas.tsx";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoMonto,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
} from "../../../../componentes/formulario.tsx";
import { Nota } from "../../../../componentes/ui.tsx";
import estilos from "./padron.module.css";

const MAXIMO_TITULARES = 6;

/** Cómo entra la unidad nueva a la liquidación, dicho según el modelo del barrio (CLAUDE.md §1.6). */
function comoEntra(modelo: "fija" | "variable" | null, periodo: string): string {
  const desde = formatearPeriodo(periodo);
  if (modelo === "fija") return `En este barrio (cuota fija) paga la cuota desde el período ${desde}.`;
  if (modelo === "variable") return `En este barrio (prorrateo por coeficiente) entra en la liquidación desde el período ${desde}.`;
  return `Entra en la liquidación desde el período ${desde}.`;
}

export function FormularioAgregarUnidad({
  barrioId,
  cuentaPorUnidad,
  modelo,
  proximoPeriodo,
}: {
  readonly barrioId: string;
  /** Si el barrio cobra con una cuenta por unidad: solo entonces van el CBU y el alias de la unidad. */
  readonly cuentaPorUnidad: boolean;
  readonly modelo: "fija" | "variable" | null;
  readonly proximoPeriodo: string;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario(agregarUnidadAction);

  // Un id estable por bloque (el `key`); la posición en la lista es el `name`. Arranca con uno, como
  // la maqueta. El contador solo crece: un id no se reutiliza aunque se quite el bloque.
  const [bloques, setBloques] = useState<readonly number[]>([0]);
  const [siguiente, setSiguiente] = useState(1);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo={`Listo: la unidad quedó agregada con el código de pago ${resultado.valor.codigoPago}.`}>
        <p>{comoEntra(modelo, resultado.valor.proximoPeriodo)}</p>
        <p>
          <Boton href={`/${barrioId}/padron/${resultado.valor.unidadFuncionalId}`} variante="secundario" tamano="sm">
            Ver la ficha de la unidad
          </Boton>
        </p>
      </AvisoDeExito>
    );
  }

  const agregarBloque = () => {
    setBloques((b) => [...b, siguiente]);
    setSiguiente((n) => n + 1);
  };
  const quitarBloque = (id: number) => setBloques((b) => b.filter((x) => x !== id));

  // Los errores de los titulares vuelven con la ruta del esquema (`titulares.0.nombre`); se aceptan
  // también con la del formulario (`titular.0.nombre`) por si la acción algún día los traduce.
  const errorDe = (i: number, campo: string) => campos[`titulares.${i}.${campo}`] ?? campos[`titular.${i}.${campo}`];
  const sueltos = [...(campos[""] ?? []), ...(campos["titulares"] ?? []), ...(campos["recibeBoleta"] ?? [])];
  const recibeElegido = previos["recibeBoleta"] ?? "0";

  return (
    <Formulario accion={enviar} etiqueta="Agregar unidad">
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
          <Campos>
            <CampoTexto nombre="manzana" etiqueta="Manzana" requerido maximo={20} errores={campos["manzana"]} valorInicial={previos["manzana"]} />
            <CampoTexto nombre="lote" etiqueta="Lote" requerido maximo={20} errores={campos["lote"]} valorInicial={previos["lote"]} />
            <CampoTexto
              nombre="superficie"
              etiqueta="Superficie (m²)"
              modoDeTeclado="decimal"
              maximo={12}
              errores={campos["superficie"]}
              valorInicial={previos["superficie"]}
            />
            <CampoSeleccion
              nombre="estado"
              etiqueta="Estado"
              requerido
              opciones={ESTADOS_UNIDAD.map((e) => ({ valor: e, texto: ESTADO_UNIDAD[e] }))}
              sinSeleccion="Elegí el estado…"
              errores={campos["estado"]}
              valorInicial={previos["estado"]}
            />
            {cuentaPorUnidad ? (
              <>
                <CampoTexto
                  nombre="cbu"
                  etiqueta="CBU de la unidad"
                  modoDeTeclado="numeric"
                  maximo={30}
                  errores={campos["cbu"]}
                  valorInicial={previos["cbu"]}
                  ayuda="La cuenta hija del recaudador. Se valida."
                />
                <CampoTexto nombre="alias" etiqueta="Alias de la unidad" maximo={20} errores={campos["alias"]} valorInicial={previos["alias"]} />
              </>
            ) : null}
            <CampoMonto
              nombre="saldoInicial"
              etiqueta="Saldo inicial"
              errores={campos["saldoInicial"]}
              valorInicial={previos["saldoInicial"]}
              ayuda="La deuda que trae de antes del sistema, si tiene."
            />
          </Campos>

          <h3 className={estilos.subtitulo}>
            Titulares <span className={estilos.subtituloAyuda}>· opcional, rigen desde hoy</span>
          </h3>
          {bloques.map((id, i) => (
            <fieldset key={id} className={estilos.titular}>
              <legend className={estilos.titularLeyenda}>
                Titular {i + 1}{" "}
                <BotonDeAccion variante="sutil" tamano="sm" etiqueta={`Quitar el titular ${i + 1}`} onClick={() => quitarBloque(id)}>
                  Quitar
                </BotonDeAccion>
              </legend>
              <Campos>
                <CampoTexto
                  nombre={`titular.${i}.nombre`}
                  etiqueta="Nombre o razón social"
                  requerido
                  maximo={200}
                  errores={errorDe(i, "nombre")}
                  valorInicial={previos[`titular.${i}.nombre`]}
                />
                <CampoSeleccion
                  nombre={`titular.${i}.caracter`}
                  etiqueta="Carácter"
                  requerido
                  opciones={TIPOS_OBLIGADO.map((t) => ({ valor: t, texto: TIPO_OBLIGADO[t] }))}
                  sinSeleccion="Elegí el carácter…"
                  errores={errorDe(i, "caracter")}
                  valorInicial={previos[`titular.${i}.caracter`] ?? "propietario"}
                />
                <CampoTexto
                  nombre={`titular.${i}.documento`}
                  etiqueta="CUIT, CUIL o DNI"
                  maximo={20}
                  errores={errorDe(i, "documento")}
                  valorInicial={previos[`titular.${i}.documento`]}
                />
                <CampoTexto
                  nombre={`titular.${i}.mail`}
                  etiqueta="Mail"
                  maximo={120}
                  errores={errorDe(i, "mail")}
                  valorInicial={previos[`titular.${i}.mail`]}
                />
              </Campos>
              <label className={estilos.recibe}>
                <input type="radio" name="recibeBoleta" value={`${i}`} defaultChecked={recibeElegido === `${i}`} />
                Recibe la boleta
              </label>
            </fieldset>
          ))}
          {bloques.length < MAXIMO_TITULARES ? (
            <BotonDeAccion variante="sutil" tamano="sm" onClick={agregarBloque}>
              {bloques.length === 0 ? "＋ Agregar un titular" : "＋ Agregar otro titular"}
            </BotonDeAccion>
          ) : null}
          <p className={estilos.ayuda}>
            Todos los titulares responden por la deuda de la unidad. Una sola persona recibe la boleta (la boleta sale a su
            nombre); los mails de los demás pueden recibir copia.
          </p>

          <Nota tono="info">
            Al agregarla se le asigna su código de pago, el siguiente del barrio. {comoEntra(modelo, proximoPeriodo)}
          </Nota>

          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
            {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
          </Avisos>
          <Acciones>
            <BotonEnviar pendiente={pendiente} cargando="Agregando…">
              Agregar
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
