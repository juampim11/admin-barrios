"use client";

/**
 * Los cuatro formularios del catálogo de proveedores: alta, corrección, desactivación y reactivación.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ "CORREGIR" ABRE UNA FILA ENTERA Y NO CELDAS SUELTAS
 *
 * El prototipo clickeable aprobado (`/design`, 2026-08-21) mostraba solo la razón social editable
 * dentro de la celda. Es una simplificación del mock: `corregirProveedorSchema` reemplaza los **seis**
 * campos de una — no hay un `PATCH` parcial — y dos de ellos (`condicionFiscal`, y `cbu`/`alias` por
 * separado) ni siquiera tienen columna propia en la tabla, que los junta para no ensanchar la grilla.
 * Editar de verdad exige los seis campos a la vista, así que "Corregir" abre una fila de ancho
 * completo con el mismo `Formulario`/`Campos`/`CampoTexto` que el alta — no una versión angosta que
 * prometa menos de lo que el esquema exige.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * "REACTIVAR" SÍ ESTÁ — CORRECCIÓN DE UNA REGRESIÓN REAL (usuario, 2026-08-26)
 *
 * El primer corte de esta pantalla salió con un `desactivarProveedorAction` sin su mitad simétrica,
 * y un docstring acá mismo que describía la ausencia como una decisión — no lo era: no hay cita en
 * `docs/diseno`, en `HANDOFF.md`, en el commit original (`c1e8977`) ni en ningún test que diga que
 * desactivar es de una sola vía. El prototipo aprobado ya mostraba "Reactivar", y "se desactiva,
 * nunca se borra" implica reversible, no una anulación. `reactivarProveedor()` es tan chico como
 * `desactivarProveedor()` (un `set activo = true`) y se agregó en la misma tanda.
 */

import { useState } from "react";
import type { Proveedor } from "@admin-barrios/data/servicios/proveedores";
import { BotonCancelar, BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { Boton, Chip } from "@admin-barrios/ui";
import {
  DatoDeConsecuencia,
  DialogoDeConfirmacion,
  ListaDeConsecuencias,
} from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import {
  corregirProveedorAction,
  desactivarProveedorAction,
  reactivarProveedorAction,
  registrarProveedorAction,
} from "../../../../acciones/proveedores.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  AvisoDeFalloCompacto,
  BotonEnviar,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  SoloLectores,
  useFormulario,
  useVolverAlGuardar,
  type Salidas,
} from "../../../../componentes/formulario.tsx";
import { opcionesDeCondicionFiscal } from "@admin-barrios/shared/escrituras";
import { conListo } from "../../../../rutas.ts";
import { IconoCorrecto, IconoFaltante } from "../../../../componentes/iconos.tsx";
import { Cifra, ui } from "../../../../componentes/ui.tsx";
import estilos from "./proveedores.module.css";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Alta
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El alta, en su página (`proveedores/nuevo`, encargo 9, PR 1 §2): «Cancelar» vuelve a la lista y, al
 * guardar, la lista dice «Listo:» con el proveedor nuevo.
 */
export function FormularioDeProveedor({
  barrioId,
  volverA,
  salidas,
}: {
  readonly barrioId: string;
  /** La lista del catálogo: a donde llevan «Cancelar» y el guardado. */
  readonly volverA: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(registrarProveedorAction);
  useVolverAlGuardar(resultado, (proveedor) => conListo(volverA, "proveedor", proveedor.id));

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo={`Listo: «${resultado.valor.razonSocial}» quedó registrado en el catálogo. Volviendo a la lista…`}>
        <a href={conListo(volverA, "proveedor", resultado.valor.id)}>Ir al catálogo</a>
      </AvisoDeExito>
    );
  }

  return (
    <Formulario accion={enviar} etiqueta="Registrar un proveedor nuevo">
      <input type="hidden" name="barrioId" value={barrioId} />

      <Campos>
        <CampoTexto
          nombre="razonSocial"
          etiqueta="Razón social"
          requerido
          maximo={300}
          ancho
          errores={campos["razonSocial"]}
          valorInicial={previos["razonSocial"]}
        />
        <CampoTexto
          nombre="cuit"
          etiqueta="CUIT"
          maximo={20}
          errores={campos["cuit"]}
          valorInicial={previos["cuit"]}
          ayuda="Ej: 30-71234567-8"
        />
        {/* De la lista de `shared` (encargo 10, BL-030 g): antes era texto libre. */}
        <CampoSeleccion
          nombre="condicionFiscal"
          etiqueta="Condición fiscal"
          opciones={opcionesDeCondicionFiscal(previos["condicionFiscal"])}
          sinSeleccion="Sin dato"
          errores={campos["condicionFiscal"]}
          valorInicial={previos["condicionFiscal"]}
        />
        <CampoTexto
          nombre="contacto"
          etiqueta="Contacto"
          maximo={300}
          errores={campos["contacto"]}
          valorInicial={previos["contacto"]}
        />
        <CampoTexto
          nombre="cbu"
          etiqueta="CBU"
          maximo={22}
          errores={campos["cbu"]}
          valorInicial={previos["cbu"]}
          ayuda="22 dígitos, sin espacios."
        />
        <CampoTexto
          nombre="alias"
          etiqueta="Alias"
          maximo={50}
          errores={campos["alias"]}
          valorInicial={previos["alias"]}
        />
      </Campos>

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>

      <Acciones>
        <Boton href={volverA} variante="sutil" deshabilitado={pendiente}>
          Cancelar
        </Boton>
        <BotonEnviar pendiente={pendiente} cargando="Registrando…">
          Registrar proveedor
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Corregir / desactivar — una fila con su propio estado
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Las órdenes del proveedor que todavía no se pagaron, y su suma. La arma la página. */
export type OrdenesSinPagar = { readonly cantidad: number; readonly monto: string };

export function FilaDeProveedor({
  proveedor,
  sinPagar,
  salidas,
}: {
  readonly proveedor: Proveedor;
  readonly sinPagar: OrdenesSinPagar | null;
  readonly salidas: Salidas;
}) {
  const [editando, setEditando] = useState(false);

  return (
    <>
      <tr className={proveedor.activo ? undefined : estilos.filaInactiva}>
        <th scope="row" className={ui.columnaAncla}>
          <span className={ui.principal}>{proveedor.razonSocial}</span>
        </th>
        <td className={ui.mono}>{proveedor.cuit ?? <span className={ui.secundaria}>—</span>}</td>
        <td>{proveedor.contacto ?? <span className={ui.secundaria}>—</span>}</td>
        <td className={ui.mono}>
          {proveedor.cbu || proveedor.alias ? (
            <>
              {proveedor.cbu ?? "—"}
              {proveedor.alias ? ` / ${proveedor.alias}` : ""}
            </>
          ) : (
            <span className={ui.secundaria}>—</span>
          )}
        </td>
        <td>
          {proveedor.activo ? (
            <Chip tono="exito" icono={<IconoCorrecto />}>
              Activo
            </Chip>
          ) : (
            <Chip tono="neutro" icono={<IconoFaltante />} punteado>
              Inactivo
            </Chip>
          )}
        </td>
        <td>
          <div className={estilos.accionesFila}>
            <BotonDeAccion variante="secundario" tamano="sm" onClick={() => setEditando((v) => !v)}>
              {editando ? "Cerrar" : "Corregir"}
              <SoloLectores> a {proveedor.razonSocial}</SoloLectores>
            </BotonDeAccion>
            {proveedor.activo ? (
              <BotonDesactivar proveedor={proveedor} sinPagar={sinPagar} salidas={salidas} />
            ) : (
              <BotonReactivar proveedorId={proveedor.id} salidas={salidas} />
            )}
          </div>
        </td>
      </tr>
      {editando ? (
        <tr>
          <td colSpan={6}>
            <FormularioDeCorreccion
              proveedor={proveedor}
              salidas={salidas}
              onGuardado={() => setEditando(false)}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FormularioDeCorreccion({
  proveedor,
  salidas,
  onGuardado,
}: {
  readonly proveedor: Proveedor;
  readonly salidas: Salidas;
  readonly onGuardado: () => void;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(corregirProveedorAction);

  // Se cierra la fila SOLO cuando la corrección se guardó bien — nunca en `falla`/`campos`, mismo
  // criterio que `useSubidaDeComprobante` con `reiniciar`: un rechazo no puede hacer desaparecer lo
  // que la persona ya tipeó.
  if (resultado.estado === "ok") {
    onGuardado();
    return null;
  }

  return (
    <Formulario accion={enviar} etiqueta={`Corregir a ${proveedor.razonSocial}`}>
      <input type="hidden" name="proveedorId" value={proveedor.id} />

      <Campos>
        <CampoTexto
          nombre="razonSocial"
          etiqueta="Razón social"
          requerido
          maximo={300}
          ancho
          errores={campos["razonSocial"]}
          valorInicial={previos["razonSocial"] ?? proveedor.razonSocial}
        />
        <CampoTexto
          nombre="cuit"
          etiqueta="CUIT"
          maximo={20}
          errores={campos["cuit"]}
          valorInicial={previos["cuit"] ?? (proveedor.cuit ?? "")}
        />
        {/* La lista, y el valor viejo tal cual si no estaba en ella: editar no lo cambia sin querer. */}
        <CampoSeleccion
          nombre="condicionFiscal"
          etiqueta="Condición fiscal"
          opciones={opcionesDeCondicionFiscal(previos["condicionFiscal"] ?? proveedor.condicionFiscal)}
          sinSeleccion="Sin dato"
          errores={campos["condicionFiscal"]}
          valorInicial={previos["condicionFiscal"] ?? (proveedor.condicionFiscal ?? "")}
        />
        <CampoTexto
          nombre="contacto"
          etiqueta="Contacto"
          maximo={300}
          errores={campos["contacto"]}
          valorInicial={previos["contacto"] ?? (proveedor.contacto ?? "")}
        />
        <CampoTexto
          nombre="cbu"
          etiqueta="CBU"
          maximo={22}
          errores={campos["cbu"]}
          valorInicial={previos["cbu"] ?? (proveedor.cbu ?? "")}
          ayuda="22 dígitos, sin espacios."
        />
        <CampoTexto
          nombre="alias"
          etiqueta="Alias"
          maximo={50}
          errores={campos["alias"]}
          valorInicial={previos["alias"] ?? (proveedor.alias ?? "")}
        />
      </Campos>

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>

      <Acciones>
        <BotonCancelar deshabilitado={pendiente} alCancelar={onGuardado} />
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

/**
 * Desactivar, **con confirmación** (encargo 8, T1 §6 — decisión del usuario: las acciones que tocan
 * plata se confirman). Desactivar no mueve plata por sí solo, pero el proveedor puede tener órdenes
 * sin pagar, y el diálogo lo dice con la cuenta que trajo la página: siguen su circuito, no se
 * cancelan. Reactivar sigue siendo directo: no deja nada en el aire.
 */
function BotonDesactivar({
  proveedor,
  sinPagar,
  salidas,
}: {
  readonly proveedor: Proveedor;
  readonly sinPagar: OrdenesSinPagar | null;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(desactivarProveedorAction);

  return (
    <DialogoDeConfirmacion
      disparador="Desactivar"
      varianteDisparador="peligro"
      etiquetaDisparador={`Desactivar a ${proveedor.razonSocial}`}
      titulo="Desactivar el proveedor"
      accion={enviar}
      textoConfirmar="Desactivar"
      varianteConfirmar="peligro"
      textoPendiente="Desactivando…"
      pendiente={pendiente}
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="proveedorId" value={proveedor.id} />
      <ListaDeConsecuencias>
        <li>
          <strong>{proveedor.razonSocial}</strong> deja de poder elegirse al cargar una orden de pago nueva.
        </li>
        {sinPagar ? (
          <li>
            Tiene{" "}
            <DatoDeConsecuencia>
              {sinPagar.cantidad} {sinPagar.cantidad === 1 ? "orden" : "órdenes"}
            </DatoDeConsecuencia>{" "}
            sin pagar por{" "}
            <DatoDeConsecuencia>
              <Cifra monto={sinPagar.monto} nulo="—" />
            </DatoDeConsecuencia>
            , pendientes de aprobar o aprobadas. No cambian: siguen su circuito igual.
          </li>
        ) : (
          <li>No tiene órdenes sin pagar.</li>
        )}
        <li>Las órdenes y los gastos viejos lo siguen nombrando. Se puede reactivar cuando haga falta.</li>
      </ListaDeConsecuencias>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
        {resultado.estado === "campos" ? (
          <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
        ) : null}
      </div>
    </DialogoDeConfirmacion>
  );
}

/** La mitad simétrica de `BotonDesactivar`. Sin confirmación: reactivar no deja nada en el aire —
 *  el proveedor vuelve a poder elegirse— y es el mismo `activo`, al revés. */
function BotonReactivar({
  proveedorId,
  salidas,
}: {
  readonly proveedorId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(reactivarProveedorAction);

  return (
    <form action={enviar} className={estilos.formularioEnLinea}>
      <input type="hidden" name="proveedorId" value={proveedorId} />
      <BotonEnviar tono="secundario" pendiente={pendiente} cargando="Reactivando…">
        Reactivar
      </BotonEnviar>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
        {resultado.estado === "campos" ? (
          <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
        ) : null}
      </div>
    </form>
  );
}
