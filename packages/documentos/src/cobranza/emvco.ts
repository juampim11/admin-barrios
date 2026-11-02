/**
 * La forma EMVCo de un QR de pago (Merchant-Presented Mode, la que usa Transferencias 3.0): campos
 * TLV —dos dígitos de tag, dos de largo, el valor— y al final el `63` con un CRC-16/CCITT-FALSE
 * (polinomio 0x1021, valor inicial 0xFFFF, sin reflexión ni XOR final) calculado sobre todo el
 * payload **incluido** el `6304`, en cuatro dígitos hexadecimales en mayúscula (BL-013).
 *
 * Vive aparte de `inercia.ts` para que el armado y la lectura sean el mismo código: el test que
 * verifica el payload lo lee con `leerEmv`, no con una expresión regular sobre la cadena.
 */

/**
 * Un campo TLV. El largo va en dos dígitos: un valor de más de 99 caracteres no entra en EMVCo. **Solo
 * ASCII imprimible**: el largo y el CRC se cuentan por carácter, y un carácter fuera de ASCII ("Nº")
 * ocupa más de un byte en el QR — el largo declarado no coincidiría y la billetera no lo leería, sin
 * que nada falle acá.
 */
export function tlv(tag: string, valor: string): string {
  if (!/^\d{2}$/.test(tag)) throw new Error(`tag EMVCo inválido: ${tag}`);
  if (valor.length > 99) throw new Error(`el valor del tag ${tag} tiene más de 99 caracteres`);
  if (!/^[ -~]*$/.test(valor)) throw new Error(`el valor del tag ${tag} tiene caracteres fuera de ASCII imprimible`);
  return `${tag}${String(valor.length).padStart(2, "0")}${valor}`;
}

/** CRC-16/CCITT-FALSE de una cadena (ASCII). Vector de control: `"123456789"` → `29B1`. */
export function crc16(datos: string): string {
  let crc = 0xffff;
  for (const ch of datos) {
    crc ^= ch.charCodeAt(0) << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Cierra un payload con su `63` y el CRC calculado sobre todo lo anterior más `6304`. */
export function conCrc(cuerpo: string): string {
  const conTag = `${cuerpo}6304`;
  return `${conTag}${crc16(conTag)}`;
}

/**
 * Lee un payload EMVCo: devuelve los campos de primer nivel en orden, o lanza si la estructura está
 * rota (un largo que se pasa del final, un tag repetido, el CRC que no da, o el `63` que no es el
 * último campo).
 */
export function leerEmv(payload: string): ReadonlyMap<string, string> {
  const campos = leerTlv(payload);
  const crc = campos.get("63");
  if (crc === undefined || !payload.endsWith(`6304${crc}`)) throw new Error("el payload no termina en su CRC (tag 63)");
  if (crc16(payload.slice(0, -4)) !== crc) throw new Error("el CRC del payload no es válido");
  return campos;
}

/**
 * Los campos TLV de una cadena, en orden, sin mirar CRC: sirve para el payload y para los subcampos de
 * un campo (el `62`). Lanza si un largo se pasa del final o un tag se repite.
 */
export function leerTlv(cadena: string): ReadonlyMap<string, string> {
  const campos = new Map<string, string>();
  let i = 0;
  while (i < cadena.length) {
    const tag = cadena.slice(i, i + 2);
    const largo = Number.parseInt(cadena.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(cadena.slice(i + 2, i + 4)) || i + 4 + largo > cadena.length) {
      throw new Error(`TLV mal formado en la posición ${i}`);
    }
    if (campos.has(tag)) throw new Error(`tag repetido: ${tag}`);
    campos.set(tag, cadena.slice(i + 4, i + 4 + largo));
    i += 4 + largo;
  }
  return campos;
}

/** El código de pago que lleva el QR (campo 62, subcampo `05`), o `null` si no lo lleva o no se lee. */
export function codigoDePagoDelQr(payload: string): string | null {
  try {
    return leerTlv(leerEmv(payload).get("62") ?? "").get("05") ?? null;
  } catch {
    return null;
  }
}
