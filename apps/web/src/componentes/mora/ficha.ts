/**
 * Cómo se dice la ficha de mora de una unidad en palabras (encargo E-a2; maqueta de mora, pantalla 3):
 * los enlaces de contacto, las etiquetas de la cabecera, la promesa de cada gestión y la franja
 * «¿Registrás la gestión?».
 *
 * **No decide nada de negocio.** El estado de la promesa, los meses, el atraso y los permisos vienen
 * resueltos de `fichaDeMora`; acá solo se nombran, con los textos del dominio (`TEXTO_ESTADO_PROMESA`)
 * y el formato de `shared/dinero` y `shared/fechas`. Puro: se prueba sin DOM.
 */

import { aCentavos, formatearMonto, type Monto } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { TEXTO_ESTADO_PROMESA, type CanalRegistrable, type EstadoPromesa } from "@admin-barrios/shared/mora";
import type { Tono } from "@admin-barrios/ui";
import { meses } from "./derivar.ts";
import { diaYMes } from "./textos.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Contacto — portado de Aclade (`aclade-cobranzas/src/lib/contacto.ts`, `enlaceLlamar`,
// `enlaceWhatsapp` y `enlaceMail`), sin el mensaje precargado: acá todavía no hay texto de cobranza
// configurado por barrio, y un texto horneado le hablaría a todos los barrios igual.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** `tel:` con el número como se cargó, sin espacios, guiones ni paréntesis. `null` si no parece un teléfono. */
export function enlaceLlamar(telefono: string | null): string | null {
  if (!telefono) return null;
  const limpio = telefono.replace(/[^0-9+]/g, "");
  return /^\+?[0-9]{6,}$/.test(limpio) ? `tel:${limpio}` : null;
}

/**
 * El número para `wa.me`: solo dígitos, sin ceros adelante y con el 54 del país si no lo trae (la
 * regla de Aclade). `null` si quedan menos de seis dígitos.
 */
export function numeroDeWhatsApp(telefono: string | null): string | null {
  if (!telefono) return null;
  const digitos = telefono.replace(/\D/g, "").replace(/^0+/, "");
  if (digitos.length < 6) return null;
  return digitos.startsWith("54") ? digitos : `54${digitos}`;
}

export function enlaceWhatsApp(telefono: string | null): string | null {
  const numero = numeroDeWhatsApp(telefono);
  return numero ? `https://wa.me/${numero}` : null;
}

/**
 * `mailto:` del mail cargado; `null` si no tiene la forma nombre@dominio. La forma es **cerrada**
 * (security-engineer): un `?`, `&`, `#`, `%`, `/`, `:`, `;`, `,` o barra invertida en el dato del
 * padrón agregaría destinatarios ocultos o un cuerpo al mail (`vecino@x.com?bcc=…`). Aclade aceptaba
 * cualquier cosa sin espacios a los lados de la arroba.
 */
export function enlaceMail(email: string | null): string | null {
  if (!email) return null;
  const limpio = email.trim();
  return /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(limpio) ? `mailto:${limpio}` : null;
}

export type BotonDeContacto = {
  readonly accion: "llamar" | "whatsapp" | "mail";
  readonly texto: string;
  /** `null`: el botón se ve apagado y `motivo` dice por qué. */
  readonly href: string | null;
  readonly motivo: string | null;
};

/** Los tres botones de contacto, cada uno con su enlace o con el motivo por el que no se puede. */
export function botonesDeContacto(titular: { readonly telefono: string | null; readonly email: string | null } | null): BotonDeContacto[] {
  const sinTitular = "La unidad no tiene titular cargado en el padrón.";
  const tel = titular?.telefono ?? null;
  const motivoTel = !titular ? sinTitular : !tel ? "El titular no tiene teléfono cargado en el padrón." : "El teléfono cargado no parece un número válido.";
  const llamar = enlaceLlamar(tel);
  const whatsapp = enlaceWhatsApp(tel);
  const mail = enlaceMail(titular?.email ?? null);
  return [
    { accion: "llamar", texto: "Llamar", href: llamar, motivo: llamar ? null : motivoTel },
    { accion: "whatsapp", texto: "WhatsApp", href: whatsapp, motivo: whatsapp ? null : motivoTel },
    {
      accion: "mail",
      texto: "Mail",
      href: mail,
      motivo: mail
        ? null
        : !titular
          ? sinTitular
          : !titular.email
            ? "El titular no tiene mail cargado en el padrón."
            : "El mail cargado no tiene la forma nombre@dominio.",
    },
  ];
}

/** Los motivos de los botones apagados, sin repetir («Sin teléfono» vale para Llamar y WhatsApp). */
export function motivosDeContacto(botones: readonly BotonDeContacto[]): string[] {
  return [...new Set(botones.map((b) => b.motivo).filter((m): m is string => m !== null))];
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La franja «¿Registrás la gestión?» — portada de Aclade (`gestiones-cliente.tsx`, `FranjaGestion` y
// `QUE_HICE`, líneas 117-155)
// ────────────────────────────────────────────────────────────────────────────────────────────────

const QUE_HICE: Record<CanalRegistrable, string> = {
  whatsapp: "Abriste WhatsApp con",
  mail: "Abriste un mail para",
  llamada: "Llamaste a",
  visita: "Visitaste a",
  nota: "Entregaste una nota a",
  carta_documento: "Preparaste una carta documento para",
};

/** El canal adentro de una oración: en minúscula, salvo la marca (ux-designer). */
const CANAL_EN_LA_ORACION: Record<CanalRegistrable, string> = {
  llamada: "llamada",
  whatsapp: "WhatsApp",
  mail: "mail",
  visita: "visita",
  nota: "nota con acuse firmado",
  carta_documento: "carta documento",
};

/**
 * Lo que dice la franja. El título es el de la maqueta; el detalle, el de Aclade sin la hora (Aclade la
 * saca del reloj del navegador con `Intl`, y acá las fechas y horas de negocio no salen del cliente).
 */
export function textoDeLaFranja(canal: CanalRegistrable, aQuien: string): { readonly titulo: string; readonly detalle: string } {
  const nombre = CANAL_EN_LA_ORACION[canal];
  return {
    titulo: `¿Registrás la gestión por ${nombre}?`,
    detalle: `${QUE_HICE[canal]} ${aQuien}. El canal ya queda cargado (${nombre}). Si no hubo respuesta, registralo igual: «No contesta» también es una gestión.`,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La cabecera y las cifras
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type Etiqueta = { readonly tono: Tono; readonly texto: string };

/** Espacio duro: «$ 250.000,00» y «10/11 · $ …» no se parten al final de un renglón angosto. */
const NBSP = "\u00A0";
const SEP = `${NBSP}·${NBSP}`;
const pesos = (m: Monto): string => `$${NBSP}${formatearMonto(m)}`;

/** La fecha de un `timestamptz` leído como texto (`2026-11-16 12:05:00+00`): los primeros diez caracteres. */
export const fechaDeMarca = (marca: string): string => formatearFecha(marca.slice(0, 10));

/** Las etiquetas de situación de la cabecera: la deuda, la derivación vigente y la promesa. */
export function etiquetasDeLaFicha(f: {
  readonly meses: number;
  readonly derivacionVigente: { readonly estudio: string; readonly derivadaAt: string } | null;
  readonly promesa: { readonly fecha: string; readonly monto: Monto; readonly estado: EstadoPromesa } | null;
}): Etiqueta[] {
  const etiquetas: Etiqueta[] = [];
  if (f.meses > 0) etiquetas.push({ tono: "peligro", texto: `${meses(f.meses)} de deuda` });
  if (f.derivacionVigente) {
    etiquetas.push({ tono: "derivada", texto: `Derivada a ${f.derivacionVigente.estudio} desde el ${fechaDeMarca(f.derivacionVigente.derivadaAt)}` });
  }
  // Los mismos tonos que la celda «Promesa» de la tabla (`TONO_PROMESA`).
  if (f.promesa?.estado === "vencida") etiquetas.push({ tono: "peligro", texto: `⚠ Promesa vencida el ${diaYMes(f.promesa.fecha)}` });
  if (f.promesa?.estado === "pendiente") {
    etiquetas.push({ tono: "alerta", texto: `Promesa de pago al ${diaYMes(f.promesa.fecha)}${SEP}${pesos(f.promesa.monto)}` });
  }
  return etiquetas;
}

/**
 * El origen del capital vencido: cuántas boletas y de qué períodos. «1 boleta vencida sin cubrir ·
 * 09/2026»; con más de tres, desde cuál: «5 boletas vencidas sin cubrir · desde 06/2026».
 */
export function boletasVencidas(periodos: readonly string[]): string {
  const n = periodos.length;
  if (n === 0) return "ninguna boleta vencida sin cubrir";
  const cuantas = n === 1 ? "1 boleta vencida sin cubrir" : `${n} boletas vencidas sin cubrir`;
  // Sin repetir el mes: la cuota de un plan y la expensa del mismo mes son dos boletas del mismo período (P2a-1).
  const ordenados = [...new Set(periodos)].sort();
  const cuales = n <= 3 ? ordenados.map(formatearPeriodo).join(", ") : `desde ${formatearPeriodo(ordenados[0] ?? "")}`;
  return `${cuantas}${SEP}${cuales}`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La promesa de una gestión (Aclade `CHIP_PROMESA`)
// ────────────────────────────────────────────────────────────────────────────────────────────────

const TONO_PROMESA: Record<EstadoPromesa, Tono> = { pendiente: "alerta", cumplida: "exito", vencida: "peligro" };

/**
 * La celda «Promesa»: el chip del estado, «dd/mm · $ monto» y, si pagó algo, «pagó $ X». Una promesa
 * pagada en parte sigue pendiente o vencida (la regla de Aclade): por eso se dice cuánto pagó.
 */
export function textoDeLaPromesa(p: { readonly fecha: string; readonly monto: Monto; readonly pagado: Monto; readonly estado: EstadoPromesa }): {
  readonly chip: Etiqueta;
  readonly detalle: string;
  readonly pagado: string | null;
} {
  return {
    chip: { tono: TONO_PROMESA[p.estado], texto: TEXTO_ESTADO_PROMESA[p.estado] },
    detalle: `${diaYMes(p.fecha)}${SEP}${pesos(p.monto)}`,
    pagado: aCentavos(p.pagado) > 0n ? `pagó${NBSP}${pesos(p.pagado)}` : null,
  };
}
