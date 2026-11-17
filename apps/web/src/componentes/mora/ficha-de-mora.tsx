"use client";

/**
 * La isla de la ficha de mora de una unidad (encargo E-a2; maqueta de mora, pantalla 3): los botones
 * de contacto, la franja «¿Registrás la gestión?», y los diálogos de registrar y anular una gestión y
 * de retirar la unidad del estudio.
 *
 * La ficha en sí es de servidor —cabecera, cifras, pestañas y tablas— y cuesta cero JavaScript; esto
 * es lo único que viaja al navegador. La estructura es la de Aclade
 * (`aclade-cobranzas/src/components/gestiones-cliente.tsx`: un proveedor con el diálogo, la franja que
 * aparece al tocar llamar, WhatsApp o mail, y el aviso de lo registrado), adaptada al kit: los diálogos
 * son `DialogoDeConfirmacion`, los formularios `useFormulario` con los esquemas de
 * `@admin-barrios/shared/mora` (en la acción), y el adjunto se sube como el comprobante de un pago.
 *
 * **Los formularios viven en el proveedor, que no se desmonta.** Al anular una gestión su botón
 * desaparece (ya no es anulable) y al retirar la unidad desaparece «Retirar del estudio»: si el
 * formulario viviera en el botón, el «Listo:» se iría con él (el mismo motivo que en la derivación).
 *
 * No hay regla de negocio acá: qué canales pide adjunto, los textos y los permisos llegan resueltos
 * del servidor; la promesa, el plazo y el adjunto los valida el esquema en la acción y el servicio.
 */

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { AvisoEnLinea, BarraDeAcciones, Boton, Segmentado } from "@admin-barrios/ui";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { anularGestionAction, registrarGestionAction, retirarAction } from "../../acciones/gestiones.ts";
import {
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  Avisos,
  CampoArchivo,
  CampoMonto,
  CampoParrafo,
  CampoSeleccion,
  CampoTexto,
  Campos,
  useFormulario,
  type Opcion,
} from "../formulario.tsx";
import { useSubidaDeAdjuntoDeGestion } from "../useSubidaDeAdjuntoDeGestion.ts";

/** Un botón de contacto, ya resuelto en el servidor (`botonesDeContacto`, `ficha.ts`). */
export type ContactoDeLaIsla = {
  readonly canal: string;
  readonly texto: string;
  readonly href: string | null;
  /** Por qué está apagado; va en su nombre accesible y escrito debajo de la cabecera. */
  readonly motivo: string | null;
  readonly nuevaPestana: boolean;
};

/** La franja de cada canal de contacto (`textoDeLaFranja`, `ficha.ts`). */
export type FranjaDeLaIsla = { readonly titulo: string; readonly detalle: string };

/** La gestión que se anula: lo que se muestra en el diálogo para saber cuál es. */
export type GestionParaAnular = { readonly id: string; readonly descripcion: string };

type Isla = {
  readonly unidadId: string;
  readonly unidad: string;
  readonly hoy: string;
  readonly puedeRegistrar: boolean;
  readonly subidaConfigurada: boolean;
  readonly canales: readonly Opcion[];
  readonly canalesConAdjunto: readonly string[];
  readonly resultados: readonly Opcion[];
  readonly promesaDeAyuda: string;
  /** El tope del selector de «Paga el» (`promesaMaxima` del servicio). */
  readonly promesaMaxima: string;
  readonly franjas: Readonly<Record<string, FranjaDeLaIsla>>;
  readonly motivosDeRetiro: readonly Opcion[];
};

type Contexto = {
  readonly isla: Isla;
  readonly sugerencia: string | null;
  readonly sugerir: (canal: string, origen: HTMLElement | null) => void;
  readonly descartarSugerencia: () => void;
  readonly abrirGestion: (canal?: string) => void;
  readonly abrirAnulacion: (gestion: GestionParaAnular) => void;
  readonly retiro: ReturnType<typeof useFormulario<{ readonly derivacionId: string }>>;
  readonly listo: string | null;
  /** El contenedor del «Listo:»: los tres diálogos mandan el foco ahí al cerrar con éxito (ux-designer). */
  readonly listoRef: RefObject<HTMLDivElement | null>;
};

const Ctx = createContext<Contexto | null>(null);

function useFicha(): Contexto {
  const c = useContext(Ctx);
  if (!c) throw new Error("Los botones de la ficha van adentro de <IslaDeLaFicha>.");
  return c;
}

/**
 * El proveedor: envuelve la ficha entera (la cabecera, la franja y la tabla de gestiones comparten los
 * mismos diálogos). Los diálogos de registrar y anular se dibujan solo con `puedeRegistrar`.
 */
export function IslaDeLaFicha({ children, ...isla }: Isla & { readonly children: ReactNode }) {
  const [sugerencia, setSugerencia] = useState<string | null>(null);
  const [abierta, setAbierta] = useState(false);
  const [canal, setCanal] = useState("");
  const [anulando, setAnulando] = useState<GestionParaAnular | null>(null);
  const [listo, setListo] = useState<string | null>(null);
  const origen = useRef<HTMLElement | null>(null);
  const listoRef = useRef<HTMLDivElement | null>(null);

  const gestion = useFormulario(registrarGestionAction);
  const anulacion = useFormulario(anularGestionAction);
  const retiro = useFormulario(retirarAction);

  // Cada «Listo:» una vez por resultado.
  useEffect(() => {
    if (gestion.resultado.estado !== "ok") return;
    setListo("Listo: la gestión quedó registrada a tu nombre, con fecha y hora.");
    setSugerencia(null);
    setCanal("");
  }, [gestion.resultado]);
  useEffect(() => {
    if (anulacion.resultado.estado === "ok") setListo("Listo: la gestión quedó anulada. Sigue en la lista, tachada y con el motivo.");
  }, [anulacion.resultado]);
  useEffect(() => {
    if (retiro.resultado.estado === "ok") setListo("Listo: la unidad salió de la cartera del estudio en el sistema. La historia queda en «Derivaciones».");
  }, [retiro.resultado]);

  const valor: Contexto = {
    isla,
    sugerencia,
    sugerir: (c, o) => {
      if (!isla.puedeRegistrar) return;
      origen.current = o;
      setSugerencia(c);
    },
    descartarSugerencia: () => {
      setSugerencia(null);
      // El foco vuelve al botón de contacto que se tocó (Aclade).
      const o = origen.current;
      origen.current = null;
      if (o?.isConnected) setTimeout(() => o.focus(), 0);
    },
    abrirGestion: (c) => {
      // Sin canal (el botón de la cabecera), el diálogo arranca sin elegir: no hereda el de la franja.
      setCanal(c ?? "");
      setAbierta(true);
    },
    abrirAnulacion: (g) => setAnulando(g),
    retiro,
    listo,
    listoRef,
  };

  return (
    <Ctx.Provider value={valor}>
      {children}
      {isla.puedeRegistrar ? (
        <>
          <DialogoDeGestion
            isla={isla}
            formulario={gestion}
            abierta={abierta}
            setAbierta={setAbierta}
            canal={canal}
            setCanal={setCanal}
            listoRef={listoRef}
          />
          <DialogoDeAnulacion formulario={anulacion} gestion={anulando} cerrar={() => setAnulando(null)} listoRef={listoRef} />
        </>
      ) : null}
    </Ctx.Provider>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Cabecera: contacto, registrar, retirar
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Llamar, WhatsApp y Mail. Tocar uno sigue el enlace y ofrece registrar la gestión por ese canal. */
export function BotonesDeContacto({ contactos }: { readonly contactos: readonly ContactoDeLaIsla[] }) {
  const f = useFicha();
  return (
    <>
      {contactos.map((c) =>
        c.href ? (
          <Boton
            key={c.canal}
            href={c.href}
            tamano="sm"
            nuevaPestana={c.nuevaPestana}
            alTocar={() => f.sugerir(c.canal, typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null))}
          >
            {c.texto}
          </Boton>
        ) : (
          <Boton key={c.canal} href="" tamano="sm" deshabilitado etiqueta={`${c.texto}: ${c.motivo ?? "no disponible"}`}>
            {c.texto}
          </Boton>
        ),
      )}
    </>
  );
}

/** «Registrar gestión»: el único primario de la cabecera. Solo con permiso (lo decide la página). */
export function BotonRegistrarGestion() {
  const f = useFicha();
  return (
    <BotonDeAccion variante="primario" onClick={() => f.abrirGestion()}>
      Registrar gestión
    </BotonDeAccion>
  );
}

/** «Anular», en cada gestión anulable de la tabla. Abre el único diálogo de anulación. */
export function BotonAnularGestion({ gestion, etiqueta }: { readonly gestion: GestionParaAnular; readonly etiqueta: string }) {
  const f = useFicha();
  return (
    <BotonDeAccion variante="sutil" tamano="sm" etiqueta={etiqueta} onClick={() => f.abrirAnulacion(gestion)}>
      Anular
    </BotonDeAccion>
  );
}

/**
 * El «Listo:» de lo último que se hizo en la ficha, debajo de la cabecera. El contenedor está **siempre**
 * (vacío si no hay mensaje): una región `status` que aparece junto con su texto no siempre se anuncia, y
 * los diálogos le mandan el foco al cerrar con éxito (`tabIndex={-1}`: enfocable, fuera del Tab).
 */
export function ListoDeLaFicha() {
  const f = useFicha();
  return (
    <div role="status" tabIndex={-1} ref={f.listoRef}>
      {f.listo ? <AvisoEnLinea tono="exito">{f.listo}</AvisoEnLinea> : null}
    </div>
  );
}

/**
 * La franja «¿Registrás la gestión por X?» (Aclade `FranjaGestion`), después de tocar un botón de
 * contacto. «Registrar» abre el diálogo con ese canal elegido; «Ahora no» la cierra.
 */
export function FranjaDeGestion() {
  const f = useFicha();
  const caja = useRef<HTMLDivElement>(null);
  // Al aparecer, el foco va a «Registrar» (no tapa nada, pero se encuentra con el teclado).
  useEffect(() => {
    if (f.sugerencia) caja.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [f.sugerencia]);
  if (!f.sugerencia) return null;
  const texto = f.isla.franjas[f.sugerencia];
  if (!texto) return null;
  const canal = f.sugerencia;
  return (
    <div role="region" aria-label="Registrar la gestión del contacto" ref={caja}>
      <AvisoEnLinea tono="info">
        <p role="status">
          <strong>{texto.titulo}</strong> {texto.detalle}
        </p>
        <BarraDeAcciones>
          <BotonDeAccion variante="primario" tamano="sm" onClick={() => f.abrirGestion(canal)}>
            Registrar
          </BotonDeAccion>
          <BotonDeAccion variante="sutil" tamano="sm" onClick={f.descartarSugerencia}>
            Ahora no
          </BotonDeAccion>
        </BarraDeAcciones>
      </AvisoEnLinea>
    </div>
  );
}

/** «Retirar del estudio»: solo con derivación vigente y permiso (lo decide la página). */
export function BotonRetirarDelEstudio({ derivacionId, estudio }: { readonly derivacionId: string; readonly estudio: string }) {
  const f = useFicha();
  const { enviar, pendiente, resultado, campos, previos } = f.retiro;
  const [motivo, setMotivo] = useState(previos["motivo"] ?? "");
  const sueltos = campos[""] ?? [];
  return (
    <DialogoDeConfirmacion
      disparador="Retirar del estudio"
      titulo={`Retirar ${f.isla.unidad} del estudio`}
      accion={enviar}
      textoConfirmar="Retirar del estudio"
      varianteConfirmar="peligro"
      textoPendiente="Retirando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
      focoAlCerrar={resultado.estado === "ok" ? f.listoRef : undefined}
    >
      <input type="hidden" name="derivacionId" value={derivacionId} />
      <p>Hoy la trabaja {estudio}.</p>
      <CampoSeleccion
        nombre="motivo"
        etiqueta="Motivo"
        requerido
        sinSeleccion="Elegí el motivo"
        valorInicial={previos["motivo"] ?? motivo}
        opciones={f.isla.motivosDeRetiro}
        errores={campos["motivo"]}
        alCambiar={setMotivo}
      />
      <CampoParrafo
        nombre="nota"
        etiqueta="Nota"
        requerido={motivo === "otro"}
        ayuda="Con «Otro», contá acá el motivo."
        maximo={500}
        valorInicial={previos["nota"]}
        errores={campos["nota"]}
      />
      {/* Revisado con legal-ph: el sistema no le avisa al estudio todavía, y retirar no toca la deuda. */}
      <p>
        La unidad deja de figurar en la cartera del estudio en el sistema. Retirarla acá no reemplaza avisarle al
        estudio. La deuda no cambia, y la historia queda: gestiones, foto de la derivación y el retiro.
      </p>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
      </Avisos>
    </DialogoDeConfirmacion>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los diálogos del proveedor
// ────────────────────────────────────────────────────────────────────────────────────────────────

const ACEPTAR_ADJUNTO = "application/pdf,image/jpeg,image/png";

function DialogoDeGestion({
  isla,
  formulario,
  abierta,
  setAbierta,
  canal,
  setCanal,
  listoRef,
}: {
  readonly isla: Isla;
  readonly formulario: ReturnType<typeof useFormulario<{ readonly gestionId: string }>>;
  readonly abierta: boolean;
  readonly setAbierta: (v: boolean) => void;
  readonly canal: string;
  readonly setCanal: (v: string) => void;
  readonly listoRef: RefObject<HTMLDivElement | null>;
}) {
  const { enviar, pendiente, resultado, campos, previos } = formulario;
  const idCanal = useId();
  const [elegido, setElegido] = useState("");
  const subida = useSubidaDeAdjuntoDeGestion(isla.unidadId);

  // Se reinicia SOLO con la gestión registrada (o al cancelar): en una falla, el archivo ya subido sirve.
  useEffect(() => {
    if (resultado.estado === "ok") {
      subida.reiniciar();
      setElegido("");
    }
  }, [resultado, subida.reiniciar]);

  const conAdjunto = isla.canalesConAdjunto.includes(canal);
  // «Enviada» va solo con la carta documento o la nota (lo valida el esquema): con otro canal no se
  // ofrece, y si estaba elegida se limpia.
  const resultados = conAdjunto ? isla.resultados : isla.resultados.filter((r) => r.valor !== "enviada");
  useEffect(() => {
    if (!conAdjunto && elegido === "enviada") setElegido("");
  }, [conAdjunto, elegido]);
  const enCurso = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";
  const bloqueo = enCurso
    ? "Esperando el archivo: el botón se habilita apenas termine de subir."
    : conAdjunto && !isla.subidaConfigurada
      ? "La carta documento y la nota firmada necesitan el archivo, y la subida no está configurada en este entorno."
      : null;
  const sueltos = campos[""] ?? [];
  const sinAdjunto = isla.canales.filter((c) => !isla.canalesConAdjunto.includes(c.valor)).map((c) => c.texto);

  return (
    <DialogoDeConfirmacion
      disparador={null}
      abierto={abierta}
      alCambiarAbierto={(v) => {
        setAbierta(v);
        // Cancelar empieza de cero la próxima vez: sin archivo ni resultado (el canal lo pone quien abre).
        if (!v && !pendiente) {
          subida.reiniciar();
          setElegido("");
        }
      }}
      focoAlCerrar={resultado.estado === "ok" ? listoRef : undefined}
      titulo={`Registrar gestión · ${isla.unidad}`}
      accion={enviar}
      textoConfirmar="Registrar gestión"
      textoPendiente="Registrando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
      ancho="ancho"
      confirmarDeshabilitado={bloqueo !== null}
      motivoDeshabilitado={bloqueo}
    >
      <input type="hidden" name="unidadFuncionalId" value={isla.unidadId} />
      <Segmentado
        id={idCanal}
        nombre="canal"
        etiqueta="Canal"
        requerido
        opciones={isla.canales}
        valorInicial={canal}
        error={campos["canal"]?.join(". ")}
        alCambiar={setCanal}
      />
      <CampoSeleccion
        // Al sacar o volver a ofrecer «Enviada» se remonta con lo elegido (el `<select>` no es controlado).
        key={conAdjunto ? "con-enviada" : "sin-enviada"}
        nombre="resultado"
        etiqueta="Resultado"
        requerido
        sinSeleccion="Elegí el resultado"
        valorInicial={elegido}
        opciones={resultados}
        errores={campos["resultado"]}
        alCambiar={setElegido}
      />
      {elegido === "promesa_de_pago" ? (
        <Campos>
          <CampoTexto
            nombre="promesaFecha"
            tipo="date"
            etiqueta="Paga el"
            requerido
            minimo={isla.hoy}
            tope={isla.promesaMaxima}
            ayuda={isla.promesaDeAyuda}
            valorInicial={previos["promesaFecha"]}
            errores={campos["promesaFecha"]}
          />
          <CampoMonto
            nombre="promesaMonto"
            etiqueta="Monto"
            requerido
            valorInicial={previos["promesaMonto"]}
            errores={campos["promesaMonto"]}
          />
        </Campos>
      ) : null}
      <CampoParrafo
        nombre="nota"
        etiqueta="Nota"
        requerido={elegido === "otro"}
        ayuda={elegido === "otro" ? "Con «Otro», contá acá qué pasó." : undefined}
        maximo={500}
        valorInicial={previos["nota"]}
        errores={campos["nota"]}
      />
      {isla.subidaConfigurada ? (
        <>
          <CampoArchivo
            nombre="adjuntoClave"
            etiqueta="Adjunto"
            requerido={conAdjunto}
            aceptar={ACEPTAR_ADJUNTO}
            estado={subida.estado}
            onElegirArchivo={subida.elegirArchivo}
            onReintentar={subida.reintentar}
            errores={campos["adjunto"]}
            ayuda="PDF o foto (JPG o PNG), hasta 10 MB. Obligatorio para la carta documento y la nota firmada. Se sube apenas lo elegís."
          />
          <input type="hidden" name="adjuntoNombre" value={subida.estado.fase === "lista" ? subida.estado.archivo.name : ""} />
        </>
      ) : (
        <AvisoEnLinea tono="alerta">
          La subida de archivos no está configurada en este entorno. Sin adjunto se pueden registrar las gestiones por{" "}
          {sinAdjunto.join(", ")}; la carta documento y la nota firmada necesitan el archivo.
        </AvisoEnLinea>
      )}
      <p>Queda registrada a tu nombre con fecha y hora. No se puede editar: si te equivocás, se anula con motivo.</p>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
      </Avisos>
    </DialogoDeConfirmacion>
  );
}

function DialogoDeAnulacion({
  formulario,
  gestion,
  cerrar,
  listoRef,
}: {
  readonly formulario: ReturnType<typeof useFormulario<{ readonly gestionId: string }>>;
  readonly gestion: GestionParaAnular | null;
  readonly cerrar: () => void;
  readonly listoRef: RefObject<HTMLDivElement | null>;
}) {
  const { enviar, pendiente, resultado, campos, previos } = formulario;
  // La última gestión elegida, para que el cuerpo no se vacíe mientras el diálogo se cierra.
  const ultima = useRef<GestionParaAnular | null>(null);
  if (gestion) ultima.current = gestion;
  const g = gestion ?? ultima.current;
  const sueltos = [...(campos[""] ?? []), ...(campos["gestionId"] ?? [])];
  // `previos` es del último envío: solo se repone si es la misma gestión.
  const mismo = previos["gestionId"] === g?.id;

  return (
    <DialogoDeConfirmacion
      disparador={null}
      abierto={gestion !== null}
      alCambiarAbierto={(v) => {
        if (!v) cerrar();
      }}
      focoAlCerrar={resultado.estado === "ok" ? listoRef : undefined}
      titulo="Anular gestión"
      accion={enviar}
      textoConfirmar="Anular gestión"
      varianteConfirmar="peligro"
      textoPendiente="Anulando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      {g ? <input type="hidden" name="gestionId" value={g.id} /> : null}
      {g ? <p>{g.descripcion}</p> : null}
      <CampoParrafo
        nombre="motivo"
        etiqueta="Motivo"
        requerido
        maximo={300}
        ayuda="Por qué se anula: por ejemplo, «cargada en la unidad equivocada»."
        valorInicial={mismo ? previos["motivo"] : undefined}
        errores={mismo ? campos["motivo"] : undefined}
      />
      <AvisoEnLinea tono="info">La gestión no se borra: queda en la lista, tachada y con el motivo.</AvisoEnLinea>
      <Avisos>
        {resultado.estado === "falla" && mismo ? <AvisoDeFallo error={resultado.error} /> : null}
        {sueltos.length > 0 && mismo ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
      </Avisos>
    </DialogoDeConfirmacion>
  );
}
