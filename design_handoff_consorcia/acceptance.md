# Criterios de aceptación (checklist testeable)

Cada ítem debería poder convertirse en un test. `fixtures.ts` provee los datos y `validarLiquidacion()` cubre los primeros cuatro.

## Prorrateo y cuadratura
- [ ] La suma de coeficientes del padrón es exactamente `100,000%`; si no, la UI lo señala y **no permite emitir**.
- [ ] Prorratear `$57.250.000` por coeficiente entre las 8 UF de `fixtures.ts` da exactamente `DETALLE_ESPERADO.ordinarias`.
- [ ] La piscina (`$2.750.000`, base `SECTOR` = B) se reparte sólo entre B-014 y B-015, proporcional a sus coeficientes: `$1.500.000` y `$1.250.000`. Ninguna otra UF recibe ese cargo.
- [ ] La suma de los totales por UF iguala el total emitido `$62.645.000`, con diferencia `0`.
- [ ] El reparto nunca pierde ni crea centavos: el resto por redondeo se asigna de forma determinista (en la referencia, al mayor coeficiente).
- [ ] Los importes se manejan en enteros (centavos). Ningún cálculo de plata usa float.

## Intereses e imputación
- [ ] Interés por mora = `4,5%` mensual **directo** sobre saldo vencido; con `interesCapitalizable: false` no se capitaliza.
- [ ] Un pago parcial se imputa al período más antiguo primero y el remanente sigue devengando intereses.
- [ ] Un plan de pago vigente suspende el devengamiento de intereses por mora.
- [ ] Con 2 cuotas impagas el plan pasa a `CADUCADO` y la deuda vuelve a su tramo de antigüedad original.

## Estados de la liquidación
- [ ] `BORRADOR` → `CERRADA` → `EMITIDA`. No existe transición que vuelva de `EMITIDA` a `BORRADOR`.
- [ ] Una liquidación `EMITIDA` es inmutable: la API rechaza cualquier mutación de sus líneas o detalle.
- [ ] Sobre una `EMITIDA` se permite: reemisión de la boleta de una UF, anulación con nota de crédito, o ajuste imputado al período siguiente. Las tres quedan en historial con autor, fecha y motivo.
- [ ] Con `requiereAprobacionConsejo: true`, emitir sin aprobación falla.
- [ ] No se puede emitir si algún comprobante del período está en estado `PENDIENTE` **y** el usuario no confirmó explícitamente la advertencia.

## Multitenancy y aislamiento
- [ ] Toda consulta filtra por `consorcioId`; no existe query que devuelva UF, movimientos o comprobantes de más de un consorcio salvo en el consolidado de cartera, que sólo agrega totales.
- [ ] Un movimiento bancario nunca puede conciliarse contra una UF o un comprobante de otro consorcio (test negativo).
- [ ] Un movimiento marcado `esMovimientoInterno` no genera crédito en ninguna cuenta corriente de UF.
- [ ] La cuenta con `admiteGastoOrdinario: false` (fondo de reserva) rechaza la imputación de un gasto ordinario.

## Permisos por rol
- [ ] `OPERADOR_CONTABLE`: el selector no ofrece "Toda la cartera" y la ruta del consolidado devuelve 403.
- [ ] `OPERADOR_CONTABLE` con 3 consorcios asignados: acceder a un cuarto consorcio por URL directa devuelve 403.
- [ ] `CONSEJO`: no recibe del backend deuda individualizada por UF ni datos personales del padrón (verificar el payload, no sólo la vista).
- [ ] `CONSEJO`: puede aprobar u observar una liquidación `CERRADA`; no puede emitir, cargar gastos ni conciliar.
- [ ] `VECINO`: sólo accede a su UF; su payload nunca incluye datos de otras UF.
- [ ] La UI no renderiza acciones que el rol no puede ejecutar (no botones deshabilitados).

## Conciliación
- [ ] El match automático propone contra deuda de la misma cuenta y consorcio: CUIT igual + importe ±$500 + dentro de 5 días del vencimiento.
- [ ] En billetera, el match es exacto por `linkPagoId`; si no hay link, no hay match automático.
- [ ] Un movimiento sin identificar puede quedar en "cobranzas a identificar" sin afectar cuentas corrientes.
- [ ] Un pago de un tercero (`pagadorEsTitular: false`) se imputa a la UF y registra quién pagó.
- [ ] Un pago informado desde el portal queda `INFORMADO` y sólo pasa a `ACREDITADO` al conciliarse con un movimiento real.

## Navegación y contexto
- [ ] Cambiar de consorcio conserva la sección actual (de `/c/A/gastos` a `/c/B/gastos`).
- [ ] Con 1 consorcio asignado, el selector se renderiza como título fijo, no como control.
- [ ] Con 2–9 consorcios, el home son tarjetas de trabajo por consorcio, no el consolidado.

## Presentación
- [ ] Todo importe usa `tabular-nums`, alineado a la derecha, con separador de miles `.` y sin decimales en listados.
- [ ] Coeficientes con 3 decimales y coma (`0,380%`); porcentajes con coma.
- [ ] Fechas `dd/mm/aaaa`, períodos `mm/aaaa`, CUIT `00-00000000-0`.
- [ ] Terminología: consorcio, unidad funcional (UF), coeficiente, expensas ordinarias/extraordinarias, liquidación, prorrateo, fondo de reserva, cuenta corriente, retenciones.
