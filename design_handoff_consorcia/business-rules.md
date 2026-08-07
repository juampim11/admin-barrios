# Reglas de negocio y permisos

## Modelo mental
- **Tenant** = administradora (estudio). ~20 consorcios, hasta ~300 UF cada uno.
- **Dos alcances, un solo chrome**: contexto "Toda la cartera" (consolidado) y contexto "un consorcio". Sólo cambian el selector de contexto del header y algunos ítems del nav. Nunca dos navegaciones distintas.
- Cambiar de consorcio **conserva la sección actual** (de Gastos de C-04 a Gastos de C-02). `⌘K` abre el selector desde cualquier pantalla.

## Alcance del selector según cantidad de consorcios asignados
| Consorcios | Comportamiento |
|---|---|
| 1 | No es selector: título fijo. |
| 2–9 | Lista simple. El home son tarjetas de trabajo por consorcio, **no** el consolidado. |
| 10+ | Buscador + fijados + "Toda la cartera" **sólo si el rol la tiene**. |

## Matriz de permisos
| Capacidad | Admin tenant | Operador contable | Consejo / presidente | Vecino |
|---|---|---|---|---|
| Cartera consolidada | ✅ | ❌ | ❌ | ❌ |
| Consorcios visibles | todos | los asignados (N) | 1 | 1 (su UF) |
| Cargar gastos / conciliar | ✅ | ✅ | ❌ | ❌ |
| Emitir liquidación | ✅ | ✅ | ❌ | ❌ |
| Aprobar / observar liquidación | ✅ | ❌ | ✅ | ❌ |
| Ver deuda por UF con nombre | ✅ | ✅ | ❌ (sólo agregados) | sólo la propia |
| Datos personales del padrón | ✅ | ✅ | ❌ | los propios |
| Configurar reglas del consorcio | ✅ | ❌ | ❌ | ❌ |

Regla de UI: a un rol **no se le muestran acciones que no puede ejecutar** (no botones deshabilitados). La vista del consejo lleva un sello "sólo lectura".

## Liquidación
- Estados: `borrador` → `cerrada` → `emitida`. Un período **emitido es inmutable**.
- Sobre un período emitido: reemitir la boleta de una UF, anular con nota de crédito, o generar un ajuste imputado al mes siguiente. Todo con autor, fecha y motivo en historial.
- Wizard de 3 pasos: (1) gastos del período, (2) prorrateo, (3) revisión y emisión. Alternativa: planilla única editable con panel de cuadratura fijo.
- Se puede exigir **aprobación del consejo** antes de emitir (flag por consorcio).
- Cierre masivo de cartera: cola con estado por consorcio; los que tienen problema (resto ≠ 0, comprobantes sin confirmar, aprobación pendiente) quedan retenidos y se abren en el wizard en el paso que falta.

## Prorrateo
- Bases: **coeficiente del reglamento** (default), superficie m², partes iguales, mixto por rubro.
- Excepciones por rubro: ej. piscina sólo al sector B, agua por medidor, limpieza de cocheras al sector D en partes iguales.
- Dentro de una excepción por sector, el reparto es **proporcional a los coeficientes de las UF de ese sector**.
- La suma de coeficientes del padrón debe ser **exactamente 100,000%**.
- La liquidación debe cuadrar **sin resto**: si hay diferencia, no se puede emitir. Mostrar cuadratura en vivo.

## Intereses, vencimientos e imputación
- Configurable por consorcio: 1.º vencimiento (ej. día 5), 2.º vencimiento con recargo (ej. día 15, +5%), interés por mora (ej. 4,5% mensual **directo**, no capitalizable).
- Imputación de pagos: **deuda más antigua primero**.
- Fondo de reserva: % sobre expensas ordinarias (ej. 3%), en cuenta bancaria propia; no admite gastos ordinarios.
- Extraordinarias en cuotas (ej. 2 de 6): separadas del gasto ordinario en boleta y reportes.

## Bancos y conciliación
- Cada consorcio tiene sus **propias** cuentas: CA $ operativa, CC $ del fondo de reserva, billetera de links de pago. El disponible del consorcio suma todas.
- La conciliación es **por cuenta**. Los movimientos **nunca cruzan consorcios**. Transferencia entre cuentas del mismo consorcio = movimiento interno, no impacta expensas.
- Match sugerido: CUIT + importe ±$500 dentro de 5 días del vencimiento. En billetera: match exacto por ID de link de pago.
- Acciones: conciliar, dividir entre varias UF, registrar como pago a cuenta, dejar en "cobranzas a identificar".
- Pago parcial: se imputa al período más viejo y el remanente sigue generando intereses. Pago de un tercero (inquilino): se imputa a la UF y se registra quién pagó.

## Gastos y comprobantes
- Carga manual o por OCR. Revisión lado a lado: visor del comprobante + campos leídos (proveedor/CUIT, tipo y número, fecha, neto, IVA, total).
- Validación de CUIT en AFIP; rubro sugerido por historial del proveedor.
- Retenciones a practicar (Ganancias, SUSS) se calculan y quedan pendientes de pago.
- Imputación: gasto del período / extraordinario / fondo de reserva.
- Se puede emitir con comprobantes pendientes de confirmar, pero la UI lo advierte.

## Mora
| Tramo | Acción | Automática |
|---|---|---|
| 1–30 días | Recordatorio (email + portal) | ✅ |
| 31–60 | Aviso formal | ❌ confirmación humana |
| 61–90 | Intimación | ❌ |
| +90 | Carta documento / legales | ❌ |

Plan de pago: anticipo + cuotas con interés de financiación; **suspende los intereses por mora** mientras esté al día; **caduca con 2 cuotas impagas** y la deuda vuelve a su tramo original.

## Reclamos
- SLA por categoría: urgente 4 h, mantenimiento 48 h, administrativo 72 h. Los vencidos se priorizan en la bandeja.
- El reclamo muestra contexto de la UF (saldo, antigüedad, reclamos previos) pero la deuda **no bloquea** el reclamo.
- Un reclamo se vincula a un presupuesto y luego al comprobante del gasto, para que el consejo vea por qué se gastó.

## Portal del vecino
- Total a pagar con desglose (ordinarias, extraordinaria en cuotas, saldo anterior, intereses).
- "¿Por qué pago esto?": composición del gasto del consorcio y explicación del coeficiente y de las excepciones que no le aplican.
- Pago por link, adhesión a débito automático, historial y liquidaciones publicadas.
- **Informar un pago hecho por fuera**: sube comprobante, importe, fecha y medio; queda como `pago informado` y entra a la conciliación de la administración; se acredita al cruzarlo con el extracto.
